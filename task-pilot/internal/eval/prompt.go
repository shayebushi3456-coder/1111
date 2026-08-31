package eval

import (
	"encoding/json"
	"fmt"
	"strings"
)

// CurrentScorePromptVersion 当前 BuildEvalCommand 追加的机评量化输出要求版本号。
// 创建 EvalRun 时写入 EvalRun.ScorePromptVersion；后续若调整 JSON 格式/词表，递增此常量，
// 不修改历史 EvalRun 的记录——它们仍按创建时冻结的版本号解释，与 PromptSnapshot 的
// “创建时冻结”设计原则一致。ScorePromptVersion 小于此值的 EvalRun 视为不支持打分。
const CurrentScorePromptVersion = 2

// EvalCheckpoint 是单条校验点在评测输入中的表示：文本描述 + 可选参考文件名列表
// （文件名已加 ckpt_<序号>__ 前缀，与用例原始输入文件/测试产物共享 input/ 目录时不会重名，
// 评测 agent 据此在 input/ 目录下按文件名找到该校验点专属的参考材料）。
type EvalCheckpoint struct {
	Description string   `json:"description"`
	Files       []string `json:"files,omitempty"`
}

// EvalInput 是下发给评测执行器的结构化输入（写入 input/eval_input.json）。
// 评测执行器读取它 + 测试过程/产物，调用评测 LLM 产出 Markdown 分析报告。
type EvalInput struct {
	CaseName    string           `json:"case_name"`
	Description string           `json:"description"`
	Checkpoints []EvalCheckpoint `json:"checkpoints"`
	TestLog     string           `json:"test_log"`
}

// BuildEvalInputJSON 序列化评测输入。
func BuildEvalInputJSON(in EvalInput) (string, error) {
	data, err := json.Marshal(in)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// BuildEvalCommand 生成评测执行器容器内运行的脚本。
// 复用与被测任务同款的 claude 镜像：先切换到评测模型端点，再用 claude -p
// 把「评测 prompt + 评测输入」喂给评测 LLM，产出 Markdown 分析报告。
// 大文件（原始输入文件、被测产物）不再内联进 prompt，而是解包/落在工作区后，
// 在 prompt 中给出目录与文件清单（路径+大小），由评测 agent 用文件读取工具按需读取，
// 避免 prompt 过大触发 ARG_MAX 或超出模型上下文窗口。
// 约定：
//   - 输入：$WORKSPACE/input/eval_input.json（任务描述 + 校验点 + 测试日志，内联进 prompt）；
//     $WORKSPACE/input/ 下用例关联的原始输入文件；$WORKSPACE/tmp/artifacts/ 下解包出的测试产物。
//     后两类仅以清单形式出现在 prompt 中，内容由评测 agent 按路径读取。
//   - 环境：EVAL_BASE_URL / EVAL_MODEL_NAME / EVAL_API_KEY（内置注入）。
//   - 输出：$WORKSPACE/output/trace.jsonl（评测 agent 完整执行轨迹，用于排查评测异常）
//     与 $WORKSPACE/output/report.md（从 trace 的最终 result 事件提取出的 Markdown 报告，
//     由人工审阅并供后端继续解析机评分数）。
//
// modelCommand 是评测任务里驱动评测 LLM 的模型启动命令前缀，例如 "claude -p"、"ccr code -p"。
// 服务会以 `<modelCommand> --output-format stream-json --verbose < prompt.txt > output/trace.jsonl`
// 的形式调用，并从 trace.jsonl 的 result 事件提取 output/report.md。
// 传空串时回退为 "claude -p --dangerously-skip-permissions"（容器内非交互执行，跳过权限确认）。
//
// enablePPTVisualScore / enableHTMLVisualScore 控制是否对 PPT/HTML 类产物进行转图片视觉评测。
// 默认 false：完全跳过对应渲染与视觉评审，仅按任务描述/校验点评估其它维度。
func BuildEvalCommand(promptTemplate string, modelCommand string, enablePPTVisualScore bool, enableHTMLVisualScore bool) string {
	var b strings.Builder
	modelCmd := strings.TrimSpace(modelCommand)
	if modelCmd == "" {
		modelCmd = "claude -p --dangerously-skip-permissions"
	}

	b.WriteString("set -e\n")
	b.WriteString("mkdir -p \"$WORKSPACE/output\" \"$WORKSPACE/tmp/artifacts\"\n")

	// 1) 切换到评测模型端点（与被测任务同款 claude 镜像）。
	b.WriteString("lumi-model-setup switch claude")
	b.WriteString(" --base-url \"$EVAL_BASE_URL\"")
	b.WriteString(" --api-key \"$EVAL_API_KEY\"")
	b.WriteString(" --model \"$EVAL_MODEL_NAME\"\n")

	// 2) 解包被测产物（若有 tar.gz）到稳定目录，供评测 agent 按路径自行读取。
	// 不再 cat 全文进 prompt：改为在 prompt 中给出文件清单（路径+大小），由评测 agent
	// 用其文件读取工具按需读取，避免 prompt 过大触发 ARG_MAX / 超出模型上下文窗口。
	b.WriteString("for f in \"$WORKSPACE\"/input/*.tar.gz; do [ -e \"$f\" ] && tar -xzf \"$f\" -C \"$WORKSPACE/tmp/artifacts\" 2>/dev/null || true; done\n")
	b.WriteString("EVAL_INPUT=$(cat \"$WORKSPACE/input/eval_input.json\")\n")

	// 2.1) 生成被测产物文件清单（相对路径 + 字节数），不含文件内容。
	// 用 find + wc -c 而非 GNU 专有的 find -printf，保证在 busybox/GNU 下都可用。
	b.WriteString("ARTIFACT_LIST=$(cd \"$WORKSPACE/tmp/artifacts\" 2>/dev/null && find . -type f 2>/dev/null | sed 's|^\\./||' | while IFS= read -r p; do printf '%s\\t%s bytes\\n' \"$p\" \"$(wc -c < \"$p\" 2>/dev/null || echo '?')\"; done || true)\n")

	// 2.2) 生成用例原始输入文件清单：排除系统下发的 eval/ppt 评分辅助文件，以及
	// 校验点参考文件（ckpt_<序号>__ 前缀，单独在 2.2.1 生成清单，避免与用例原始输入混淆）。
	b.WriteString("ORIG_INPUT_LIST=$(cd \"$WORKSPACE/input\" 2>/dev/null && find . -maxdepth 1 -type f ! -name 'eval_input.json' ! -name 'gold_reference.json' ! -name '*.tar.gz' ! -name 'score_ppt_v2.py' ! -name 'render_deck.py' ! -name 'pptx_render.py' ! -name 'prompts.py' ! -name 'aggregate_quality.py' ! -name 'ppt_score_runner.py' ! -name 'html_score_runner.py' ! -name 'NotoSansSC-Regular.otf' ! -name 'ckpt_*' 2>/dev/null | sed 's|^\\./||' | while IFS= read -r p; do printf '%s\\t%s bytes\\n' \"$p\" \"$(wc -c < \"$p\" 2>/dev/null || echo '?')\"; done || true)\n")

	// 2.2.1) 生成校验点参考文件清单（标准答案/评分参考图/规范文档等）：文件名形如
	// ckpt_<序号>__<原始文件名>，序号与 eval_input.json 里 checkpoints[] 的顺序一一对应，
	// 提示评测 agent 读取该文件时应对应到具体第几条校验点，而不是当作通用输入材料。
	b.WriteString("CHECKPOINT_FILE_LIST=$(cd \"$WORKSPACE/input\" 2>/dev/null && find . -maxdepth 1 -type f -name 'ckpt_*' 2>/dev/null | sed 's|^\\./||' | while IFS= read -r p; do printf '%s\\t%s bytes\\n' \"$p\" \"$(wc -c < \"$p\" 2>/dev/null || echo '?')\"; done || true)\n")

	// 2.3) 将测试产物中的 PPTX/PPT 渲染为逐页 PNG，并打包到最终 artifact。
	// 评分 Claude 必须读取这些图片后按统一 rubric 评审，而不是消费预先计算的 VLM 分数。
	// render_deck.py 渲染 pptx/html 都是纯语言生态(python-pptx+Pillow / playwright)，
	// 不依赖 soffice/libreoffice/pdftoppm 等系统二进制，失败原因统一是"评测镜像没装
	// 对应 pip 包"而非"系统缺二进制"。NotoSansSC-Regular.otf 是 pptx_render.py 绘制
	// 中文文本用的内置字体，与其它 py 脚本一并下发到 tmp/ppt_scorer/ 同目录。
	if enablePPTVisualScore {
		b.WriteString(`mkdir -p "$WORKSPACE/tmp/ppt_scorer" "$WORKSPACE/tmp/ppt_pages" "$WORKSPACE/output/ppt_render_pages" "$WORKSPACE/output/ppt_review"
for f in score_ppt_v2.py render_deck.py pptx_render.py prompts.py aggregate_quality.py ppt_score_runner.py NotoSansSC-Regular.otf; do
  [ -f "$WORKSPACE/input/$f" ] && cp "$WORKSPACE/input/$f" "$WORKSPACE/tmp/ppt_scorer/$f"
done
if command -v python3 >/dev/null 2>&1 && [ -f "$WORKSPACE/tmp/ppt_scorer/ppt_score_runner.py" ]; then
  python3 "$WORKSPACE/tmp/ppt_scorer/ppt_score_runner.py" || printf 'PPT 图片渲染脚本执行失败，已跳过。请检查 python3/python-pptx/Pillow 依赖是否已安装。\n' > "$WORKSPACE/tmp/ppt_render_summary.txt"
elif ! command -v python3 >/dev/null 2>&1; then
  printf '评测镜像未安装 python3，已跳过 PPT 逐页图片渲染。\n' > "$WORKSPACE/tmp/ppt_render_summary.txt"
else
  printf '未找到 ppt_score_runner.py，已跳过 PPT 逐页图片渲染。\n' > "$WORKSPACE/tmp/ppt_render_summary.txt"
fi
PPT_RENDER_SUMMARY=$(cat "$WORKSPACE/tmp/ppt_render_summary.txt" 2>/dev/null || true)
`)
	} else {
		b.WriteString(`PPT_RENDER_SUMMARY='该用例未开启 PPT 视觉评测（enable_ppt_visual_score=false），未渲染 PPT 逐页图片；请仅按任务描述、校验点和文本/文件内容评估。'
`)
	}

	// 2.4) 将测试产物中的 HTML 页面/幻灯片渲染为逐页 PNG，评审方式与标准与 PPT 完全一致。
	// 默认不渲染；仅在用例显式开启 enable_html_visual_score 时执行。
	if enableHTMLVisualScore {
		b.WriteString(`mkdir -p "$WORKSPACE/tmp/ppt_scorer" "$WORKSPACE/output/html_render_pages" "$WORKSPACE/output/html_review"
[ -f "$WORKSPACE/input/html_score_runner.py" ] && cp "$WORKSPACE/input/html_score_runner.py" "$WORKSPACE/tmp/ppt_scorer/html_score_runner.py"
if command -v python3 >/dev/null 2>&1 && [ -f "$WORKSPACE/tmp/ppt_scorer/html_score_runner.py" ]; then
  python3 "$WORKSPACE/tmp/ppt_scorer/html_score_runner.py" || printf 'HTML 图片渲染脚本执行失败，已跳过。请检查 python3/playwright(及其 chromium 浏览器) 依赖是否已安装。\n' > "$WORKSPACE/tmp/html_render_summary.txt"
elif ! command -v python3 >/dev/null 2>&1; then
  printf '评测镜像未安装 python3，已跳过 HTML 逐页图片渲染。\n' > "$WORKSPACE/tmp/html_render_summary.txt"
else
  printf '未找到 html_score_runner.py，已跳过 HTML 逐页图片渲染。\n' > "$WORKSPACE/tmp/html_render_summary.txt"
fi
HTML_RENDER_SUMMARY=$(cat "$WORKSPACE/tmp/html_render_summary.txt" 2>/dev/null || true)
`)
	} else {
		b.WriteString(`HTML_RENDER_SUMMARY='该用例未开启 HTML 视觉评测（enable_html_visual_score=false），未渲染任何 HTML 逐页图片；请仅按任务描述、校验点和文本/文件内容评估。'
`)
	}

	// 3) 将评测 prompt 模板写入文件（heredoc 避免转义问题），作为最终 prompt 的开头。
	b.WriteString("cat > \"$WORKSPACE/tmp/prompt.txt\" <<'TASKPILOT_PROMPT_EOF'\n")
	b.WriteString(promptTemplate)
	b.WriteString("\nTASKPILOT_PROMPT_EOF\n")

	// 4) 只把小而有界的评测输入(JSON)内联进 prompt；大文件仅给路径清单 + 读取指引，
	// 由评测 agent 用文件读取工具按需读取，不再把全文塞进 prompt。
	b.WriteString("{\n")
	b.WriteString("  printf '\\n\\n## 评测输入(JSON，含任务描述/校验点/测试日志)\\n'\n")
	b.WriteString("  printf '%s\\n' \"$EVAL_INPUT\"\n")
	b.WriteString("  printf '\\n## 用例原始输入文件（被测系统拿到的原始输入，按需读取其内容）\\n'\n")
	b.WriteString("  printf '目录：%s/input/\\n以下为文件清单（路径相对该目录 | 大小）：\\n%s\\n' \"$WORKSPACE\" \"$ORIG_INPUT_LIST\"\n")
	b.WriteString("  printf '\\n## 校验点参考文件（评测输入(JSON) checkpoints[].files 引用的标准答案/评分参考图/规范文档等，仅评测阶段可见，被测系统从未收到过这些文件）\\n'\n")
	b.WriteString("  printf '目录：%s/input/\\n以下为文件清单（路径相对该目录 | 大小），文件名前缀 ckpt_<序号> 对应评测输入(JSON) checkpoints[] 的第几条：\\n%s\\n' \"$WORKSPACE\" \"$CHECKPOINT_FILE_LIST\"\n")
	b.WriteString("  printf '\\n## 被测系统产物文件（测试执行的过程与结果，含 trace.jsonl，按需读取其内容）\\n'\n")
	b.WriteString("  printf '目录：%s/tmp/artifacts/\\n以下为文件清单（路径相对该目录 | 大小）：\\n%s\\n' \"$WORKSPACE\" \"$ARTIFACT_LIST\"\n")
	b.WriteString("  printf '\\n## PPT 逐页图片评审输入（如适用）\\n'\n")
	b.WriteString("  printf '%s\\n' \"$PPT_RENDER_SUMMARY\"\n")
	b.WriteString("  printf '\\n## HTML 逐页图片评审输入（如适用）\\n'\n")
	b.WriteString("  printf '%s\\n' \"$HTML_RENDER_SUMMARY\"\n")
	b.WriteString("  printf '\\n## PPT/HTML 视觉评审统一标准\\n'\n")
	b.WriteString("  printf '%s\\n' '若检测到 PPT 或 HTML 渲染图片，评分 Claude 必须先使用 Read 工具逐页读取上面列出的 p001.png/p002.png 等图片，再进行评价；不得只根据文件名、trace、文本抽取或主观猜测评分。PPT 与 HTML 产物按同一套口径评审：1) layout_soft：检查 overlap、blank、img_broken、cjk_broken、low_contrast、truncate、glue、table_bad、overflow、align 十类排版缺陷；2) aesthetic：检查配色现代协调、字体层次、留白、整体设计感，惩罚陈旧模板、廉价渐变/阴影/艺术字、文字拥挤；3) compliance：结合任务描述和校验点检查页数/页面数、内容覆盖、材料忠实性。报告中需要给出 total(0-1) 以及 layout_soft/aesthetic/compliance 三项分数、逐页主要问题与依据。若图片渲染失败或未检测到 PPT/HTML 产物，则明确说明对应的图片评审不可用。'\n")
	b.WriteString("  printf '\\n> 说明：文件完整内容未内联在本提示中。请使用你的文件读取能力，按上面给出的目录与相对路径读取所需文件；若存在 PPT 或 HTML 渲染图片，必须逐页读取图片后再单列视觉与美观度评价小节。\\n'\n")
		// 4.1) Prompt-first 机评量化输出要求：系统只固定 JSON 结构，不提供/维护
		// Allowed Tags。标签体系与 score 规则完全由评测 Prompt 本身定义；模型应从
		// 上文 rubric 中逐字复制 module/label，后端仅做结构解析与弱校验。
		b.WriteString("  printf '\\n## 机评量化输出要求（系统固定格式，优先级高于以上任何格式指令，不可省略）\\n'\n")
		b.WriteString("  printf '%s\\n' '在 Markdown 报告正文结束后，另起一行，输出一个且仅一个 ```json 代码块，并确保它是全文最后一个代码块，后面不得再输出任何文字。JSON 字段必须为：{\"score\": 0到4之间的整数, \"score_reason\": \"根据命中的最高严重级别/亮点级别说明 score 的计算依据\", \"tags\": [{\"module\": \"Rubric 中的模块名称\", \"label\": \"Rubric 中的标签名称\", \"kind\": \"bad|good\", \"level\": \"P0|P1|P2|L1|L2\", \"detail\": \"基于证据说明为什么命中该标签\"}]}。score 必须严格遵循评测 Prompt 中的 0-4 分规则：有 P0 得 0；无 P0 但有 P1 得 1；无 P0/P1 但有 P2 得 2；无 P0/P1/P2 且无 C-亮点得 3；无 P0/P1/P2 且有 C-亮点得 4。tags 必须来自上文评测 Prompt 的打标 Rubric，module 和 label 必须逐字复制，不得自造、缩写、改写或翻译；C-亮点的 kind=good，其它模块 kind=bad；无命中标签时 tags 输出空数组 []。这个 JSON 代码块用于系统自动解析，请不要省略、不要改变字段名、不要输出注释或尾随逗号。'\n")
		b.WriteString("} >> \"$WORKSPACE/tmp/prompt.txt\"\n")

	// 5) 调用评测 LLM。与测试阶段一致，使用 stream-json + verbose 保存完整 trace，
	// 便于排查评测 agent 是否读取了必要文件、是否调用工具失败、是否被截断等异常。
	// report.md 仍作为后端既有解析入口：从 trace.jsonl 最后的 result 事件提取 Markdown
	// 正文；若解析失败，则写入带错误说明和原始 trace 摘要的 fallback 报告，避免产物为空。
	b.WriteString("set +e\n")
	b.WriteString(modelCmd)
	b.WriteString(" --output-format stream-json --verbose < \"$WORKSPACE/tmp/prompt.txt\" > \"$WORKSPACE/output/trace.jsonl\" 2>&1\n")
	b.WriteString("task_pilot_eval_rc=$?\n")
	b.WriteString("if command -v python3 >/dev/null 2>&1; then TASKPILOT_PY=python3; elif command -v python >/dev/null 2>&1; then TASKPILOT_PY=python; else TASKPILOT_PY=; fi\n")
	b.WriteString("if [ -n \"$TASKPILOT_PY\" ]; then\n")
	b.WriteString("$TASKPILOT_PY - \"$WORKSPACE/output/trace.jsonl\" \"$WORKSPACE/output/report.md\" <<'TASKPILOT_EXTRACT_REPORT_PY'\n")
	b.WriteString(`import json
import sys
from pathlib import Path

trace_path = Path(sys.argv[1])
report_path = Path(sys.argv[2])
last_result = None
parse_errors = 0
try:
    with trace_path.open("r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                parse_errors += 1
                continue
            if ev.get("type") == "result":
                last_result = ev
except Exception as exc:
    report_path.write_text(f"# 评测报告提取失败\n\n无法读取 trace.jsonl：{exc}\n", encoding="utf-8")
    raise SystemExit(0)

if last_result and isinstance(last_result.get("result"), str) and last_result.get("result").strip():
    report_path.write_text(last_result["result"], encoding="utf-8")
else:
    raw_tail = ""
    try:
        raw_tail = "".join(trace_path.read_text(encoding="utf-8", errors="replace").splitlines(True)[-80:])
    except Exception:
        pass
    report_path.write_text(
        "# 评测报告提取失败\n\n"
        "未能从评测 trace.jsonl 中找到有效的 result 事件。\n\n"
        f"- JSON 解析失败行数：{parse_errors}\n\n"
        "## trace 末尾片段\n\n~~~jsonl\n" + raw_tail + "\n~~~\n",
        encoding="utf-8",
    )
`)
	b.WriteString("TASKPILOT_EXTRACT_REPORT_PY\n")
	b.WriteString("else\n")
	b.WriteString("  printf '# 评测报告提取失败\\n\\n评测镜像未安装 python/python3，无法从 trace.jsonl 自动提取最终 report。请直接查看 output/trace.jsonl 排查评测过程。\\n' > \"$WORKSPACE/output/report.md\"\n")
	b.WriteString("fi\n")
	b.WriteString("if [ ! -s \"$WORKSPACE/output/report.md\" ]; then printf '# 评测报告提取失败\\n\\n未能从 output/trace.jsonl 自动提取最终 report，请直接查看 trace.jsonl 排查评测过程。\\n' > \"$WORKSPACE/output/report.md\"; fi\n")
	b.WriteString("set -e\n")
	b.WriteString("echo '--- report.md ---'; cat \"$WORKSPACE/output/report.md\" || true\n")
	b.WriteString("echo '--- eval trace.jsonl ---'; cat \"$WORKSPACE/output/trace.jsonl\" || true\n")
	b.WriteString("if [ \"$task_pilot_eval_rc\" -ne 0 ]; then exit \"$task_pilot_eval_rc\"; fi\n")

	return b.String()
}

// AssertNonEmpty 是一个防御性小工具，保证生成的脚本非空。
func AssertNonEmpty(script string) error {
	if strings.TrimSpace(script) == "" {
		return fmt.Errorf("empty eval command")
	}
	return nil
}

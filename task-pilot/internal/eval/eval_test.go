package eval

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"strings"
	"testing"
)

// makeTarGz 构造一个含指定文件的 tar.gz 供测试。
func makeTarGz(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for name, content := range files {
		hdr := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(content)), Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func TestExtractReportFromTarGz(t *testing.T) {
	content := "# 评测分析报告\n\n## 一、总体评价\n表现良好。\n"
	data := makeTarGz(t, map[string]string{"./report.md": content, "./other.txt": "noise"})

	got, err := ExtractReportFromTarGz(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	if string(got) != content {
		t.Errorf("extracted mismatch: %s", got)
	}
}

func TestExtractReportMissing(t *testing.T) {
	data := makeTarGz(t, map[string]string{"result.txt": "x"})
	if _, err := ExtractReportFromTarGz(bytes.NewReader(data)); err == nil {
		t.Error("missing report.md should error")
	}
}

func TestNormalizeReport(t *testing.T) {
	if got := NormalizeReport("  hello  \n"); got != "hello" {
		t.Errorf("trim failed: %q", got)
	}
	long := strings.Repeat("x", 512*1024+100)
	got := NormalizeReport(long)
	if !strings.Contains(got, "已截断") {
		t.Error("over-long report should be truncated with marker")
	}
}

func TestBuildEvalCommand(t *testing.T) {
	cmd := BuildEvalCommand("请撰写分析报告", "", true, true)
	for _, want := range []string{
		"lumi-model-setup switch claude",
		`--api-key "$EVAL_API_KEY"`,
		`"$WORKSPACE/output/report.md"`,
		"请撰写分析报告",
		"ORIG_INPUT_LIST",
		"CHECKPOINT_FILE_LIST",
		"校验点参考文件",
		"ARTIFACT_LIST",
		"用例原始输入文件",
		"按需读取",
		"PPT 逐页图片评审输入",
		"ppt_render_pages",
		"ppt_review",
		"ppt_score_runner.py",
		"PPT_RENDER_SUMMARY",
		"HTML 逐页图片评审输入",
		"html_render_pages",
		"html_review",
		"html_score_runner.py",
		"HTML_RENDER_SUMMARY",
		"PPT/HTML 视觉评审统一标准",
		"评分 Claude 必须先使用 Read 工具逐页读取",
		// 容器内非交互执行，默认命令必须跳过权限确认，否则无 TTY 会话会卡住。
		"claude -p --dangerously-skip-permissions",
	} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command missing %q", want)
		}
	}
	// 大文件内容不应再被 cat 内联进 prompt（改为清单+按路径读取）。
	if strings.Contains(cmd, "ORIG_INPUT_TEXT") || strings.Contains(cmd, "ARTIFACT_TEXT") {
		t.Error("command should not inline full file contents anymore")
	}
	// 不应再生成 JSON verdict 相关逻辑。
	if strings.Contains(cmd, "verdict.json") {
		t.Error("command should no longer emit verdict.json")
	}
	if err := AssertNonEmpty(cmd); err != nil {
		t.Error(err)
	}

	// 自定义 modelCommand 应被拼接进最终脚本，替代默认的 "claude -p"。
	custom := BuildEvalCommand("请撰写分析报告", "ccr code -p", true, true)
	if !strings.Contains(custom, "ccr code -p --output-format stream-json --verbose") {
		t.Errorf("custom model command not applied: %s", custom)
	}
}

// TestBuildEvalCommandVisualScoreDisabledByDefault visual score disabled 时不应下发/调用
// PPT/HTML 渲染脚本，也不应创建渲染产物目录；需给出固定跳过说明供评测 agent 识别，
// 避免其误判为渲染失败。
func TestBuildEvalCommandVisualScoreDisabledByDefault(t *testing.T) {
	cmd := BuildEvalCommand("请撰写分析报告", "", false, false)
	if strings.Contains(cmd, "html_score_runner.py") || strings.Contains(cmd, "ppt_score_runner.py") {
		t.Error("visual score disabled must not invoke/ship PPT/HTML scorer scripts")
	}
	if strings.Contains(cmd, "html_render_pages") || strings.Contains(cmd, "html_review") || strings.Contains(cmd, "ppt_render_pages") || strings.Contains(cmd, "ppt_review") {
		t.Error("visual score disabled must not create PPT/HTML render output dirs")
	}
	if !strings.Contains(cmd, "enable_html_visual_score=false") || !strings.Contains(cmd, "enable_ppt_visual_score=false") {
		t.Error("expected explicit skip explanation for disabled visual scoring")
	}
	if err := AssertNonEmpty(cmd); err != nil {
		t.Error(err)
	}
}

func TestBuildEvalInputJSON(t *testing.T) {
	s, err := BuildEvalInputJSON(EvalInput{
		CaseName: "c1", Description: "d",
		Checkpoints: []EvalCheckpoint{{Description: "cp1"}, {Description: "cp2", Files: []string{"ckpt_2__ref.png"}}},
		TestLog:     "log",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "cp1") || !strings.Contains(s, "\"case_name\":\"c1\"") {
		t.Errorf("json missing fields: %s", s)
	}
	if !strings.Contains(s, "ckpt_2__ref.png") {
		t.Errorf("json missing checkpoint file reference: %s", s)
	}
}

func TestBuildPPTGoldReferenceJSON(t *testing.T) {
	s, err := BuildPPTGoldReferenceJSON("case-1", "PPT 任务", []string{"覆盖市场规模", "包含结论页"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"qid":"case-1"`,
		`"topic":"PPT 任务"`,
		`"layout_soft":0.5`,
		`"aesthetic":0.2`,
		`"compliance":0.3`,
		"覆盖市场规模",
		"包含结论页",
		"must_be_from_materials",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("gold reference missing %q: %s", want, s)
		}
	}
}

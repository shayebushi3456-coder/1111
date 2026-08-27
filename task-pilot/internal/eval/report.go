package eval

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"

	"task-pilot/internal/model"
)

// ReportFilename 是评测执行器产出的 Markdown 分析报告文件名。
const ReportFilename = "report.md"

// ExtractReportFromTarGz 从 output.tar.gz 中提取 Markdown 分析报告（report.md）的内容。
// 评测执行器把 report.md 放在 output/ 下，服务侧收到的是打包后的 tar.gz。
// 报告是给人看的自由文本，不做任何 schema 校验。
func ExtractReportFromTarGz(r io.Reader) ([]byte, error) {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return nil, fmt.Errorf("gzip open: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("tar read: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if path.Base(hdr.Name) == ReportFilename {
			// 限制读取大小，防御异常大文件（报告为纯文本，8MB 足够）。
			data, err := io.ReadAll(io.LimitReader(tr, 8*1024*1024))
			if err != nil {
				return nil, fmt.Errorf("read %s: %w", ReportFilename, err)
			}
			return data, nil
		}
	}
	return nil, fmt.Errorf("%s not found in artifact", ReportFilename)
}

// NormalizeReport 清理报告文本首尾空白，并对超长内容做安全截断。
func NormalizeReport(s string) string {
	s = strings.TrimSpace(s)
	const max = 512 * 1024 // 512KB，远超正常报告体量，仅作兜底
	if len(s) > max {
		return s[:max] + "\n\n> [报告过长，已截断]"
	}
	return s
}

// jsonFenceRe 匹配 ```json ... ``` fenced code block（非贪婪、跨行）。
var jsonFenceRe = regexp.MustCompile("(?s)```json\\s*(\\{.*?\\})\\s*```")

// ScoreResult 是 ExtractScoreAndIssues 的解析结果。
type ScoreResult struct {
	Score       *float64
	ScoreReason string
	Issues      []model.IssueTag
	Status      model.CaseExecutionScoreStatus
	// Error 记录解析失败原因（Status=PARSE_FAILED），或成功解析但存在非致命问题的提示。
	Error string
}

// scoreJSONPayload 是 fenced JSON block 内部的结构，字段名对应 BuildEvalCommand
// 追加给评测 LLM 的 prompt-first 输出格式约定（见 prompt.go 中的“机评量化输出要求”）。
type scoreJSONPayload struct {
	Score       *float64 `json:"score"`
	ScoreReason string   `json:"score_reason"`
	Tags        []struct {
		Module string `json:"module"`
		Label  string `json:"label"`
		Kind   string `json:"kind"`
		Level  string `json:"level"`
		Detail string `json:"detail"`
	} `json:"tags"`
}

// ExtractScoreAndIssues 从评测报告原文中提取 prompt-first 机评分数与动态标签。
//
// 必须传入 NormalizeReport 截断之前的原始报告文本：512KB 截断可能恰好切碎报告末尾的
// JSON 代码块，若先截断再提取会造成本不存在的假解析失败。
//
// 解析规则：
//   - 报告中可能包含多个 ```json 代码块，约定取最后一个尝试解析，因为系统要求
//     是“报告末尾追加”。
//   - 找不到 json 代码块 / JSON 语法错误 / score 缺失或不在 0-4 整数范围：判定
//     PARSE_FAILED，这些都是核心字段异常，不做兜底猜测。
//   - tags 为 prompt-first 动态标签，后端不维护 Allowed Tags、不校验 label 是否属于
//     某个词表；仅做轻量结构归一化。label 为空的 tag 被丢弃并记录非致命提示。
func ExtractScoreAndIssues(reportRaw string) ScoreResult {
	matches := jsonFenceRe.FindAllStringSubmatch(reportRaw, -1)
	if len(matches) == 0 {
		return ScoreResult{Status: model.ScoreParseFailed, Error: "no json block found"}
	}
	last := matches[len(matches)-1][1]

	var payload scoreJSONPayload
	if err := json.Unmarshal([]byte(last), &payload); err != nil {
		return ScoreResult{Status: model.ScoreParseFailed, Error: "json unmarshal: " + err.Error()}
	}
	if payload.Score == nil {
		return ScoreResult{Status: model.ScoreParseFailed, Error: "score field missing"}
	}
	if *payload.Score < 0 || *payload.Score > 4 || *payload.Score != float64(int(*payload.Score)) {
		return ScoreResult{Status: model.ScoreParseFailed, Error: fmt.Sprintf("score must be an integer in [0,4]: %v", *payload.Score)}
	}

	var tags []model.IssueTag
	dropped := 0
	for _, it := range payload.Tags {
		label := strings.TrimSpace(it.Label)
		if label == "" {
			dropped++
			continue
		}
		tags = append(tags, model.IssueTag{
			Module: strings.TrimSpace(it.Module),
			Label:  label,
			Kind:   normalizeTagKind(it.Kind, it.Module),
			Level:  normalizeTagLevel(it.Level),
			Detail: strings.TrimSpace(it.Detail),
		})
	}

	result := ScoreResult{Score: payload.Score, ScoreReason: strings.TrimSpace(payload.ScoreReason), Issues: tags, Status: model.ScoreOK}
	if dropped > 0 {
		result.Error = fmt.Sprintf("%d 个空标签已过滤", dropped)
	}
	return result
}

func normalizeTagKind(kind string, module string) string {
	trimmed := strings.TrimSpace(kind)
	switch trimmed {
	case "bad", "good":
		return trimmed
	}
	if strings.TrimSpace(module) == "C-亮点" {
		return "good"
	}
	return "bad"
}

func normalizeTagLevel(level string) string {
	trimmed := strings.TrimSpace(level)
	switch trimmed {
	case "P0", "P1", "P2", "L1", "L2":
		return trimmed
	default:
		return ""
	}
}

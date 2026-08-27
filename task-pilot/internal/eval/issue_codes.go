package eval

// IssueTagDef 描述受控问题标签词表中的一项。
type IssueTagDef struct {
	Code  string
	Label string
}

// IssueCodes 机评问题标签受控词表。评测 LLM 输出的 issues[].code 必须从此词表中选取；
// 词表外的 code 在解析时会被丢弃（非致命），不判定整体解析失败。
// 扩展词表只需在此追加常量，不涉及历史数据迁移。
var IssueCodes = []IssueTagDef{
	{Code: "CHECKPOINT_UNMET", Label: "校验点未满足"},
	{Code: "INCOMPLETE_OUTPUT", Label: "输出不完整"},
	{Code: "FORMAT_ERROR", Label: "格式/结构错误"},
	{Code: "HALLUCINATION", Label: "内容失实/编造"},
	{Code: "INSTRUCTION_DEVIATION", Label: "偏离任务要求"},
	{Code: "PERFORMANCE_ISSUE", Label: "执行效率/超时"},
	{Code: "TOOL_MISUSE", Label: "工具调用错误"},
	{Code: "VISUAL_QUALITY", Label: "视觉/排版质量差"},
	{Code: "ERROR_HANDLING", Label: "异常处理不当"},
	{Code: "OTHER", Label: "其他"},
}

var issueCodeSet = func() map[string]string {
	m := make(map[string]string, len(IssueCodes))
	for _, d := range IssueCodes {
		m[d.Code] = d.Label
	}
	return m
}()

// IsValidIssueCode 判断 code 是否在受控词表内。
func IsValidIssueCode(code string) bool {
	_, ok := issueCodeSet[code]
	return ok
}

// IssueLabel 返回 code 对应的中文标签；code 不在词表内时返回空字符串。
func IssueLabel(code string) string {
	return issueCodeSet[code]
}

// NormalizeSeverity 校验 severity 取值，非法/缺失时兜底为 medium（非致命）。
func NormalizeSeverity(sev string) string {
	switch sev {
	case "high", "medium", "low":
		return sev
	default:
		return "medium"
	}
}

package model

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
)

// EvalRunStatus 执行任务（用例集的一次执行）状态。
type EvalRunStatus string

const (
	EvalRunPending   EvalRunStatus = "PENDING"
	EvalRunRunning   EvalRunStatus = "RUNNING"
	EvalRunSucceeded EvalRunStatus = "SUCCEEDED"
	EvalRunFailed    EvalRunStatus = "FAILED"
	EvalRunStopped   EvalRunStatus = "STOPPED"
)

// CaseExecutionStatus 单条用例执行状态（二段式）。评测阶段产出 Markdown 分析报告，
// 不再做机器判定；REPORTED 表示报告已生成、等待人工审阅得出结论。
type CaseExecutionStatus string

const (
	CaseExecPending     CaseExecutionStatus = "PENDING"
	CaseExecTestRunning CaseExecutionStatus = "TEST_RUNNING"
	CaseExecTestDone    CaseExecutionStatus = "TEST_DONE"
	CaseExecEvalRunning CaseExecutionStatus = "EVAL_RUNNING"
	CaseExecReported    CaseExecutionStatus = "REPORTED"
	CaseExecError       CaseExecutionStatus = "ERROR"
	CaseExecStopped     CaseExecutionStatus = "STOPPED"
)

// IsTerminal 报告用例执行是否已达终态。
func (s CaseExecutionStatus) IsTerminal() bool {
	switch s {
	case CaseExecReported, CaseExecError, CaseExecStopped:
		return true
	}
	return false
}

// EvalRun 一次执行任务：关联用例集快照 + 选用端点 + 聚合状态。
type EvalRun struct {
	ID             string         `gorm:"primaryKey;size:64" json:"id"`
	Name           string         `gorm:"size:128" json:"name"`
	CaseSetID      string         `gorm:"index;size:64" json:"case_set_id"`
	EndpointID     string         `gorm:"size:64" json:"endpoint_id"`
	EvalEndpointID string         `gorm:"size:64" json:"eval_endpoint_id"`
	PromptID       string         `gorm:"size:64" json:"prompt_id"`
	PromptSnapshot string         `gorm:"type:text" json:"-"`
	SnapshotJSON   string         `gorm:"type:text" json:"-"`
	Status         EvalRunStatus  `gorm:"size:32;index" json:"status"`
	Total          int            `json:"total"`
	Reported       int            `json:"reported"`
	Errored        int            `json:"errored"`
	// MaxConcurrent 本次执行任务的单请求并发上限（运行中用例数）。<=0 表示该维度不限流。
	MaxConcurrent  int            `json:"max_concurrent"`
	// TestImage 本次执行任务的测试容器镜像；空表示回退到内置/服务默认镜像。
	TestImage string `gorm:"size:256" json:"test_image,omitempty"`
	// EvalImage 本次执行任务的评测容器镜像；空表示回退到 config.Builtin.EvalExecutorImage。
	EvalImage string `gorm:"size:256" json:"eval_image,omitempty"`
	// TestModelCommand 测试任务里模型启动命令片段（例如 "ccr code -p"）；空表示回退到内置默认。
	TestModelCommand string `gorm:"size:256" json:"test_model_command,omitempty"`
	// EvalModelCommand 评测任务里模型启动命令片段（例如 "claude -p"）；空表示回退到内置默认。
	EvalModelCommand string `gorm:"size:256" json:"eval_model_command,omitempty"`
	// ScorePromptVersion 创建时写入的机评量化脚本版本号（见 eval.CurrentScorePromptVersion）。
	// 0 表示该 EvalRun 创建于机评打分能力上线之前，其所有用例执行的 ScoreStatus 应为 NOT_APPLICABLE，
	// 不参与任何均分/排行榜聚合，也不视为解析异常。历史 EvalRun 不做回填，语义按创建时版本冻结解释。
	ScorePromptVersion int            `json:"score_prompt_version"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
	FinishedAt     *time.Time     `json:"finished_at,omitempty"`
	DeletedAt      gorm.DeletedAt `gorm:"index" json:"-"`

	CaseExecutions []CaseExecution `gorm:"foreignKey:EvalRunID" json:"case_executions,omitempty"`
}

// CaseExecutionScoreStatus 机评量化结果状态。
// 与 CaseExecutionStatus 是独立维度：分数解析失败不影响用例执行本身的终态判定。
type CaseExecutionScoreStatus string

const (
	// ScoreNotApplicable 该次评测所属 EvalRun 的脚本版本不支持打分（历史数据），不解析、不视为异常。
	ScoreNotApplicable CaseExecutionScoreStatus = "NOT_APPLICABLE"
	// ScoreOK 已成功解析出合法分数（可能仍有部分非法标签被丢弃，见 ScoreError 附加提示）。
	ScoreOK CaseExecutionScoreStatus = "OK"
	// ScoreParseFailed 脚本已要求打分，但报告中未能解析出合法的 JSON 分数块。
	ScoreParseFailed CaseExecutionScoreStatus = "PARSE_FAILED"
)

// IssueTag 单条标签，序列化后存储于 CaseExecution.IssueTagsJSON。
//
// Prompt-first 新链路不再依赖后端内置 Allowed Tags，而是原样保存评测 Prompt
// 要求模型输出的动态标签（module/label/kind/level/detail）。Code/Severity 仅保留给
// 历史 CHECKPOINT_UNMET/TOOL_MISUSE 等旧版报告兼容展示。
type IssueTag struct {
	// Legacy fields for score prompt v1.
	Code     string `json:"code,omitempty"`
	Severity string `json:"severity,omitempty"`

	// Prompt-first fields for score prompt v2+.
	Module string `json:"module,omitempty"`
	Label  string `json:"label,omitempty"`
	Kind   string `json:"kind,omitempty"`  // bad/good
	Level  string `json:"level,omitempty"` // P0/P1/P2/L1/L2

	Detail string `json:"detail,omitempty"`
}

// CaseExecution 单条用例的一次执行，桥接 TestTask（被测）与 EvalTask（评测报告）。
type CaseExecution struct {
	ID          string              `gorm:"primaryKey;size:64" json:"id"`
	EvalRunID   string              `gorm:"index;size:64" json:"eval_run_id"`
	CaseID      string              `gorm:"size:64" json:"case_id"`
	CaseName    string              `gorm:"size:128" json:"case_name"`
	TestTaskID  string              `gorm:"index;size:64" json:"test_task_id"`
	EvalTaskID  string              `gorm:"index;size:64" json:"eval_task_id,omitempty"`
	Status      CaseExecutionStatus `gorm:"size:32;index" json:"status"`
	ExitCode    *int                `json:"exit_code,omitempty"`
	Message     string              `gorm:"type:text" json:"message,omitempty"`
	Report      string              `gorm:"type:text" json:"report,omitempty"`
	// Score 机评总分，0-100（可含一位小数）。null 表示不参与任何均分/排行榜统计。
	Score *float64 `json:"score,omitempty"`
	// IssueTagsJSON 问题标签列表（[]IssueTag）的 JSON 序列化存储，不直接出接口
	// （历史上一直是 json:"-"，接口一直没有下发过 issue_tags，前端相应也一直没渲染出问题标签——
	// 这里才是本次要修的根因；GORM 不识别自定义 gorm:"-" 标签之外的虚拟字段，
	// 故用 IssueTags 承担对外 JSON 字段，值在读库后由 AfterFind 钩子填充）。
	IssueTagsJSON string `gorm:"type:text" json:"-"`
	// IssueTags 问题标签列表，对外 JSON 字段。gorm:"-" 表示不映射到任何数据库列，
	// 由 AfterFind 钩子从 IssueTagsJSON 反序列化填充，保证任何直接把 CaseExecution
	// 序列化进接口响应的路径（EvalRun.CaseExecutions、/tasks 等）都能带上该字段。
	IssueTags []IssueTag `gorm:"-" json:"issue_tags,omitempty"`
	// ScoreStatus 机评量化解析结果状态，参见 CaseExecutionScoreStatus。
	ScoreStatus CaseExecutionScoreStatus `gorm:"size:20;index" json:"score_status"`
	// ScoreReason 评测模型按 prompt-first 规则给出的分数计算依据。
	ScoreReason string `gorm:"type:text" json:"score_reason,omitempty"`
	// ScoreError 当 ScoreStatus=PARSE_FAILED 时记录失败原因；ScoreStatus=OK 时可能携带非致命提示
	// （例如“N 个非法标签已过滤”），便于排查评测 prompt/模型是否遵循了输出格式约定。
	ScoreError string     `gorm:"type:text" json:"score_error,omitempty"`
	OrderNo    int        `json:"order_no"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// AfterFind 是 GORM 查询钩子：每次从数据库读出 CaseExecution 后自动反序列化
// IssueTagsJSON 填充导出字段 IssueTags，使其能随 CaseExecution 一起序列化进任何
// 接口响应（EvalRun.CaseExecutions、/tasks 等），无需每个调用点手动转换。
// 解析失败时留空切片而非报错——防御性兜底，展示层不应因此崩溃。
func (ce *CaseExecution) AfterFind(tx *gorm.DB) error {
	if ce.IssueTagsJSON == "" {
		return nil
	}
	var tags []IssueTag
	_ = json.Unmarshal([]byte(ce.IssueTagsJSON), &tags)
	ce.IssueTags = tags
	return nil
}

// EvalRunSnapshot 冻结创建时的用例集内容，保证历史结果可复现。
type EvalRunSnapshot struct {
	CaseSetID   string                `json:"case_set_id"`
	CaseSetName string                `json:"case_set_name"`
	Version     int                   `json:"version"`
	Cases       []EvalRunSnapshotCase `json:"cases"`
}

// EvalRunSnapshotCheckpoint 冻结创建时单条校验点的文本与参考文件绑定。
type EvalRunSnapshotCheckpoint struct {
	Description string   `json:"description"`
	FileIDs     []string `json:"file_ids,omitempty"`
}

type EvalRunSnapshotCase struct {
	CaseID      string                      `json:"case_id"`
	Name        string                      `json:"name"`
	Description string                      `json:"description"`
	FileIDs     []string                    `json:"file_ids"`
	Checkpoints []EvalRunSnapshotCheckpoint `json:"checkpoints"`
	// MCPIDs / SkillIDs 创建时冻结的用例 MCP/Skill 绑定，与其它快照字段一致，
	// 保证历史 EvalRun 复现时使用的是创建时刻的绑定，不受后续用例编辑影响。
	MCPIDs   []string `json:"mcp_ids"`
	SkillIDs []string `json:"skill_ids"`
	// EnablePPTVisualScore / EnableHTMLVisualScore 创建时冻结的视觉评测开关。
	// 默认 false：PPT/HTML 产物均不转图片评测，只有显式开启时执行。
	EnablePPTVisualScore  bool `json:"enable_ppt_visual_score"`
	EnableHTMLVisualScore bool `json:"enable_html_visual_score"`
	// SkipHTMLVisualScore 兼容旧字段；新逻辑以 EnableHTMLVisualScore 为准。
	SkipHTMLVisualScore bool `json:"skip_html_visual_score"`
}

func EncodeSnapshot(s EvalRunSnapshot) string {
	data, err := json.Marshal(s)
	if err != nil {
		return ""
	}
	return string(data)
}

func DecodeSnapshot(raw string) EvalRunSnapshot {
	var s EvalRunSnapshot
	if raw == "" {
		return s
	}
	_ = json.Unmarshal([]byte(raw), &s)
	return s
}

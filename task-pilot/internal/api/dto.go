package api

import (
	"task-pilot/internal/model"
	"task-pilot/internal/service"
)

type CreateTaskRequest struct {
	RequestID      string                `json:"request_id"`
	Name           string                `json:"name" binding:"required"`
	Namespace      string                `json:"namespace"`
	Image          string                `json:"image"`
	Command        string                `json:"command" binding:"required"`
	InputFiles     []model.InputFileSpec `json:"input_files"`
	TimeoutSeconds int64                 `json:"timeout_seconds"`
}

type TaskResponse struct {
	Task *model.Task `json:"task"`
}

type FileResponse struct {
	FileID   string `json:"file_id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Purpose  string `json:"purpose"`
	Sha256   string `json:"sha256,omitempty"`
}

type ArtifactListResponse struct {
	Artifacts []FileResponse `json:"artifacts"`
}

type ListTaskResponse struct {
	Tasks []model.Task `json:"tasks"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

// ---- 配置中心：被测模型端点 ----

type UpsertEndpointRequest struct {
	Name      string `json:"name"`
	BaseURL   string `json:"base_url"`
	ModelName string `json:"model_name"`
	APIKey    string `json:"api_key"`
	IsDefault bool   `json:"is_default"`
}

// EndpointResponse 端点响应，api_key 一律脱敏。
type EndpointResponse struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	BaseURL      string `json:"base_url"`
	ModelName    string `json:"model_name"`
	APIKeyMasked string `json:"api_key_masked"`
	IsDefault    bool   `json:"is_default"`
}

type EndpointListResponse struct {
	Endpoints []EndpointResponse `json:"endpoints"`
}

// ---- 用例集 ----

// CheckpointRequest 单条校验点：文本描述 + 可选参考文件（仅供评测 LLM 读取，不下发给测试任务）。
type CheckpointRequest struct {
	Description string   `json:"description" binding:"required"`
	FileIDs     []string `json:"file_ids"`
}

type CaseRequest struct {
	Name        string              `json:"name" binding:"required"`
	Description string              `json:"description" binding:"required"`
	FileIDs     []string            `json:"file_ids"`
	Checkpoints []CheckpointRequest `json:"checkpoints" binding:"required"`
	// MCPIDs / SkillIDs 引用 model.MCPConfig / model.SkillConfig 的 ID，
	// 派发该用例的测试任务前会在执行器 Pod 内还原为对应的 MCP/Skill 配置。
	MCPIDs   []string `json:"mcp_ids"`
	SkillIDs []string `json:"skill_ids"`
	// 数据标签：一级/二级类型为级联下拉；task_types 可多选；difficulty 手填。
	Level1Type string   `json:"level1_type"`
	Level2Type string   `json:"level2_type"`
	TaskTypes  []string `json:"task_types"`
	Difficulty string   `json:"difficulty"`
	// SkipHTMLVisualScore 跳过该用例测试产物中 HTML 文件的视觉美观度评测。
	// 省略/false（默认）：HTML 产物按既有行为转图片走美观度评测；true：不转图片，跳过该维度评审。
	SkipHTMLVisualScore bool `json:"skip_html_visual_score"`
}

type CaseSetRequest struct {
	Name        string        `json:"name" binding:"required"`
	Description string        `json:"description"`
	Cases       []CaseRequest `json:"cases" binding:"required"`
}

type CaseSetResponse struct {
	CaseSet *model.CaseSet `json:"case_set"`
}

type CaseSetListResponse struct {
	CaseSets []model.CaseSet `json:"case_sets"`
}

// ---- 执行任务（EvalRun） ----

type CreateEvalRunRequest struct {
	CaseSetID  string `json:"case_set_id" binding:"required"`
	Name       string `json:"name"`
	EndpointID string `json:"endpoint_id"`
	// EvalEndpointID 评测模型端点；省略时使用默认评测端点（is_default:true）。
	EvalEndpointID string `json:"eval_endpoint_id"`
	PromptID       string `json:"prompt_id"`
	// MaxConcurrent 本次执行任务的单请求并发上限（运行中用例数）。
	// 省略/<=0 时用服务端配置 scheduler.max_concurrent_per_run 的默认值。
	MaxConcurrent int `json:"max_concurrent"`
	// TestImage 测试任务容器镜像。省略时依次回退：
	// config.Builtin.TestExecutorImage → cfg.Kubernetes.DefaultImage。
	TestImage string `json:"test_image"`
	// EvalImage 评测任务容器镜像。省略时使用 config.Builtin.EvalExecutorImage。
	EvalImage string `json:"eval_image"`
	// TestModelCommand 测试任务里执行任务描述的模型启动命令片段，例如：
	//   "ccr code -p"、"claude -p"、"aider --model xxx -m"
	// 服务会拼接为 `<test_model_command> '<任务描述>' --output-format stream-json --verbose > output/trace.jsonl 2>&1`。
	// 省略时使用 config.Builtin.DefaultTestModelCommand（默认 "ccr code -p"）。
	TestModelCommand string `json:"test_model_command"`
	// EvalModelCommand 评测任务里驱动评测 LLM 的模型启动命令，例如 "claude -p"、"ccr code -p"。
	// 服务会拼接为 `<eval_model_command> < prompt.txt > output/report.md`。
	// 省略时使用 config.Builtin.DefaultEvalModelCommand（默认 "claude -p"）。
	EvalModelCommand string `json:"eval_model_command"`
}

type EvalRunResponse struct {
	EvalRun      *model.EvalRun          `json:"eval_run"`
	ScoreSummary *service.ScoreSummary   `json:"score_summary,omitempty"`
}

type EvalRunListResponse struct {
	EvalRuns []model.EvalRun `json:"eval_runs"`
}

// LeaderboardResponse 按被测模型端点聚合的机评排行榜。
type LeaderboardResponse struct {
	Period string                   `json:"period"`
	Items  []service.LeaderboardItem `json:"items"`
}

// RunningCaseExecutionsResponse 当前正在执行的评测用例列表（跨所有 EvalRun）。
type RunningCaseExecutionsResponse struct {
	Count          int                   `json:"count"`
	CaseExecutions []model.CaseExecution `json:"case_executions"`
}

// ---- 评测 Prompt ----

type UpsertPromptRequest struct {
	Name      string `json:"name"`
	Content   string `json:"content"`
	IsDefault bool   `json:"is_default"`
}

type PromptResponse struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Content   string `json:"content"`
	IsDefault bool   `json:"is_default"`
}

type PromptListResponse struct {
	Prompts []PromptResponse `json:"prompts"`
}

// ---- MCP 配置 ----

type UpsertMCPConfigRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
	// ConfigJSON 单个 MCP server 的配置对象，写入 .mcp.json 的 mcpServers.<Name> 字段。
	ConfigJSON string `json:"config_json" binding:"required"`
}

type MCPConfigResponse struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ConfigJSON  string `json:"config_json"`
}

type MCPConfigListResponse struct {
	MCPConfigs []MCPConfigResponse `json:"mcp_configs"`
}

// ---- Skill 配置 ----

type UpsertSkillConfigRequest struct {
	Name        string            `json:"name" binding:"required"`
	Description string            `json:"description"`
	ContentMD   string            `json:"content_md" binding:"required"`
	ExtraFiles  map[string]string `json:"extra_files"`
}

type SkillConfigResponse struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	ContentMD   string            `json:"content_md"`
	ExtraFiles  map[string]string `json:"extra_files"`
}

type SkillConfigListResponse struct {
	SkillConfigs []SkillConfigResponse `json:"skill_configs"`
}

// ---- 全局环境变量 ----

type UpsertEnvVarRequest struct {
	Key         string `json:"key" binding:"required"`
	Value       string `json:"value"` // 更新时留空保留原值
	Description string `json:"description"`
}

type EnvVarResponse struct {
	ID          string `json:"id"`
	Key         string `json:"key"`
	ValueMasked string `json:"value_masked"`
	Description string `json:"description"`
}

type EnvVarListResponse struct {
	EnvVars []EnvVarResponse `json:"env_vars"`
}


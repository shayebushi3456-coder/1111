package config

// import "os"

// ModelEndpoint 描述一个 LLM 端点。
type ModelEndpoint struct {
	BaseURL   string
	ModelName string
	APIKey    string
}

// BuiltinConfig 内置写死的评测配置。用户无法通过任何接口修改这些项。
// 评测模型 api_key 从环境变量注入（EVAL_MODEL_API_KEY），不入库、不出接口。
type BuiltinConfig struct {
	TestExecutorImage  string
	EvalExecutorImage  string
	EvalModel          ModelEndpoint
	EvalPromptTemplate string
	TestTimeoutSeconds int64
	EvalTimeoutSeconds int64
	// DefaultTestModelCommand 测试任务里执行任务描述的模型启动命令片段（前缀）。
	// 拼接形式：`<cmd> '<任务描述>' --output-format stream-json --verbose > output/trace.jsonl 2>&1`。
	// 例如 "ccr code -p"、"claude -p"。用户创建 EvalRun 时可通过 test_model_command 覆盖。
	DefaultTestModelCommand string
	// DefaultEvalModelCommand 评测任务里驱动评测 LLM 的模型启动命令。
	// 拼接形式：`<cmd> < prompt.txt > output/report.md`。
	// 例如 "claude -p"、"ccr code -p"。用户创建 EvalRun 时可通过 eval_model_command 覆盖。
	DefaultEvalModelCommand string
}

// evalPromptTmpl 评测 prompt 模板，全局统一写死（默认项）。
// 引导评测模型产出一份给人阅读的 Markdown 分析报告，不再要求任何 JSON schema。
const evalPromptTmpl = `你是严格、客观的评测专家。请根据「任务描述」「校验点」以及被测系统的「执行过程与结果」，
撰写一份结构化的 Markdown 分析报告，供人工审阅后得出结论。报告应包含以下部分：

# 评测分析报告

## 一、总体评价
用几句话概述被测系统在本用例上的整体表现。

## 二、逐条校验点分析
针对每一个校验点，说明其是否满足、依据是什么（引用执行过程或产物中的具体证据）、以及存在的问题。

## 三、发现的问题与风险
列出测试过程或产物中暴露的缺陷、异常或潜在风险。

## 四、结论与建议
给出总结性判断和改进建议。

要求：语言客观、有据可依，直接输出 Markdown 正文，不要输出与报告无关的额外说明。`

// Builtin 内置配置实例。镜像/评测 prompt/超时为默认兜底值。
// 评测端点（base_url/model/api_key）已迁移至可运行时配置的 EvalEndpoint（配置中心），
// 这里的 EvalModel 仅作为首次启动 seed 默认评测端点时的 base_url/model 初始值；
// api_key 不再硬编码，由 EvalEndpointService.SeedDefault 从环境变量 EVAL_MODEL_API_KEY 读取。
var Builtin = BuiltinConfig{
	TestExecutorImage: "registry-cn-beijing.siflow.cn/skyinfer/eval-pod-base:1.3.0-vscs-20260818-3484",
	EvalExecutorImage: "registry-cn-beijing.siflow.cn/skyinfer/eval-pod-base:1.3.0-vscs-20260818-3484",
	EvalModel: ModelEndpoint{
		BaseURL:   "http://iqeust-litellm.danbo-agidata-inner.com/v1",
		ModelName: "deepseek-v4-flash",
	},
	EvalPromptTemplate: evalPromptTmpl,
	TestTimeoutSeconds: 2400,
	EvalTimeoutSeconds: 600,
	// 保留改造前的默认行为：测试用 ccr code -p，评测用 claude -p。
	// 执行器 Job 的 pod 是一次性、强隔离沙箱（独立 emptyDir，任务结束即销毁），
	// 无持久环境可污染也无人能响应交互式确认，故默认附加
	// --dangerously-skip-permissions 跳过 Claude Code 的工具调用权限确认，
	// 否则无 TTY 的容器内会话会卡在权限提示上。
	DefaultTestModelCommand: "claude -p --dangerously-skip-permissions",
	DefaultEvalModelCommand: "claude -p --dangerously-skip-permissions",
}

/* ============================================================
   WorkEval — 领域模型类型定义
   字段与 task-pilot 后端 JSON 输出严格对齐：
   - internal/model/*.go 的 `json:"..."` tag
   - internal/api/dto.go 的响应包裹结构（如 {case_sets:[...]}）
   任何这里的字段变化都必须先确认后端对应的 json tag。
   ============================================================ */

export type RunStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'STOPPED';

export type CaseExecStatus =
  | 'PENDING'
  | 'TEST_RUNNING'
  | 'TEST_DONE'
  | 'EVAL_RUNNING'
  | 'REPORTED'
  | 'ERROR'
  | 'STOPPED';

export type TaskStatus = 'CREATED' | 'SUBMITTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

// ---- 配置中心：被测 / 评测模型端点（EndpointResponse，api_key 一律脱敏） ----
export interface EndpointResponse {
  id: string;
  name: string;
  base_url: string;
  model_name: string;
  api_key_masked: string;
  is_default: boolean;
}
export type TargetEndpoint = EndpointResponse;
export type EvalEndpoint = EndpointResponse;

export interface UpsertEndpointRequest {
  name: string;
  base_url: string;
  model_name: string;
  api_key: string;
  is_default: boolean;
}

// ---- 评测 Prompt（PromptResponse） ----
export interface EvalPrompt {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
}

export interface UpsertPromptRequest {
  name: string;
  content: string;
  is_default: boolean;
}

// ---- 用例集（model.CaseSet / model.Case / model.Checkpoint） ----
export interface Checkpoint {
  id: string;
  case_id: string;
  order_no: number;
  description: string;
  // file_ids 校验点绑定的参考文件（如标准答案、评分参考图、规范文档），仅评测阶段可见，
  // 测试任务永远不会收到这些文件——与校验点文本本身对被测 agent 保密的原则一致。
  file_ids: string[];
}

export interface CaseItem {
  id: string;
  case_set_id: string;
  name: string;
  description: string;
  order_no: number;
  checkpoints?: Checkpoint[];
  file_ids: string[];
  mcp_ids: string[];
  skill_ids: string[];
  // 数据标签：一级/二级类型为级联词表下拉；task_types 可多选；difficulty 手填。
  level1_type?: string;
  level2_type?: string;
  task_types?: string[];
  difficulty?: string;
  // skip_html_visual_score 跳过该用例测试产物中 HTML 文件的视觉美观度评测（不转图片、不做
  // layout_soft/aesthetic 评审）。省略/false（默认）：HTML 产物按既有行为转图片走美观度评测。
  skip_html_visual_score?: boolean;
}

export interface CaseSet {
  id: string;
  name: string;
  description: string;
  version: number;
  created_at: string;
  updated_at: string;
  cases?: CaseItem[];
}

// ---- 请求体：CaseSetRequest / CaseRequest ----
// CheckpointRequestInput 单条校验点：文本描述 + 可选参考文件 ID 列表。
export interface CheckpointRequestInput {
  description: string;
  file_ids: string[];
}
export interface CaseRequestInput {
  name: string;
  description: string;
  file_ids: string[];
  checkpoints: CheckpointRequestInput[];
  mcp_ids: string[];
  skill_ids: string[];
  level1_type: string;
  level2_type: string;
  task_types: string[];
  difficulty: string;
  skip_html_visual_score: boolean;
}
export interface CaseSetRequestInput {
  name: string;
  description: string;
  cases: CaseRequestInput[];
}

// ---- MCP Server 配置（model.MCPConfig，供用例绑定；派发测试任务前还原为 Pod 内 .mcp.json） ----
export interface MCPConfig {
  id: string;
  name: string;
  description: string;
  config_json: string;
}

export interface UpsertMCPConfigRequest {
  name: string;
  description: string;
  config_json: string;
}

// ---- Skill 配置（model.SkillConfig，供用例绑定；派发测试任务前还原为 Pod 内 ~/.claude/skills/<name>/） ----
export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  content_md: string;
  extra_files: Record<string, string> | null;
}

export interface UpsertSkillConfigRequest {
  name: string;
  description: string;
  content_md: string;
  extra_files: Record<string, string>;
}

// ---- 全局环境变量（Value 加密存储，接口只返回脱敏 value_masked） ----
export interface EnvVar {
  id: string;
  key: string;
  value_masked: string;
  description: string;
}

export interface UpsertEnvVarRequest {
  key: string;
  value: string; // 编辑时留空保留原值
  description: string;
}

// ---- 执行任务（model.EvalRun / model.CaseExecution） ----

// 机评量化解析结果状态：与 CaseExecStatus 是独立维度，分数解析失败不影响用例执行的终态判定。
//   NOT_APPLICABLE — 该次评测所属 EvalRun 创建于机评打分能力上线之前，不视为异常。
//   OK             — 已成功解析出合法分数。
//   PARSE_FAILED   — 脚本已要求打分，但报告中未能解析出合法的 JSON 分数块，需要关注。
export type ScoreStatus = 'NOT_APPLICABLE' | 'OK' | 'PARSE_FAILED';

export interface IssueTag {
  // legacy fields for score prompt v1
  code?: string;
  severity?: 'high' | 'medium' | 'low';
  // prompt-first dynamic tag fields for score prompt v2+
  module?: string;
  label?: string;
  kind?: 'bad' | 'good';
  level?: 'P0' | 'P1' | 'P2' | 'L1' | 'L2';
  detail?: string;
}

export interface CaseExecution {
  id: string;
  eval_run_id: string;
  case_id: string;
  case_name: string;
  test_task_id: string;
  eval_task_id?: string;
  status: CaseExecStatus;
  exit_code?: number | null;
  message?: string;
  report?: string;
  // score/issue_tags 为空/undefined 时一律看 score_status：
  // NOT_APPLICABLE（历史数据，不提示异常）与 PARSE_FAILED（需要关注）不能混同展示。
  score?: number | null;
  issue_tags?: IssueTag[];
  score_status: ScoreStatus;
  score_reason?: string;
  score_error?: string;
  order_no: number;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
}

// IssueCount 问题标签命中统计（Top 标签面板）。
export interface IssueCount {
  code?: string;
  module?: string;
  label: string;
  kind?: 'bad' | 'good';
  level?: 'P0' | 'P1' | 'P2' | 'L1' | 'L2';
  count: number;
  ratio: number;
}

// ScoreSummary 一次 EvalRun 的机评量化汇总，随 GET /eval-runs/:id 附加返回。
export interface ScoreSummary {
  score_scale?: '0-4' | '0-100';
  avg_score: number | null;
  scored_count: number;
  total_count: number;
  availability_rate?: number;
  score_status_breakdown: Partial<Record<ScoreStatus, number>>;
  distribution: Record<string, number>;
  level_breakdown?: Partial<Record<'P0' | 'P1' | 'P2' | 'L1' | 'L2', number>>;
  top_issues: IssueCount[];
}

export interface EvalRun {
  id: string;
  name: string;
  case_set_id: string;
  endpoint_id: string;
  eval_endpoint_id: string;
  prompt_id: string;
  status: RunStatus;
  total: number;
  reported: number;
  errored: number;
  max_concurrent: number;
  test_image?: string;
  eval_image?: string;
  test_model_command?: string;
  eval_model_command?: string;
  score_prompt_version: number;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
  case_executions?: CaseExecution[];
}

// EvalRunResponse GET /eval-runs/:id 与 /results 的完整响应包裹（含机评汇总）。
export interface EvalRunResponse {
  eval_run: EvalRun;
  score_summary?: ScoreSummary;
}

// LeaderboardItem 排行榜单个被测模型（TargetEndpoint）的聚合结果。
export interface LeaderboardItem {
  endpoint_id: string;
  endpoint_name: string;
  avg_score: number;
  run_count: number;
  case_count: number;
  scored_case_count: number;
  top_issues: IssueCount[];
  score_trend: number[];
}

export type LeaderboardPeriod = '30d' | '90d' | 'all';

export interface LeaderboardResponse {
  period: string;
  items: LeaderboardItem[];
}

export interface CreateEvalRunRequest {
  case_set_id: string;
  name?: string;
  endpoint_id?: string;
  eval_endpoint_id?: string;
  prompt_id?: string;
  max_concurrent?: number;
}

// ---- 文件对象（model.FileObject / FileResponse） ----
export type FilePurpose = 'input' | 'artifact';

export interface FileResponse {
  file_id: string;
  filename: string;
  size: number;
  purpose: FilePurpose;
  sha256?: string;
}

// ---- 任务（model.Task，用于 GET /tasks/:id 查看测试/评测任务原始状态） ----
export interface TaskRecord {
  id: string;
  request_id: string;
  name: string;
  namespace: string;
  job_name: string;
  pod_name?: string;
  image: string;
  command: string;
  role?: string;
  case_execution_id?: string;
  status: TaskStatus;
  exit_code?: number | null;
  error_message?: string;
  timeout_seconds: number;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

// ---- 通用响应包裹 ----
export interface ErrorResponse {
  error: string;
}

/* ------------------------------------------------------------
   trace.jsonl 原始事件类型
   与 executor 内 `claude -p ... --output-format stream-json --verbose` 的
   真实产物格式对齐（已用 2747 行真实样本核对）。trace.jsonl 本身打包在
   评测执行器上传的 output.tar.gz 产物内，前端需先解压 tar.gz 才能取到它。
   ------------------------------------------------------------ */

export interface TraceSystemInit {
  type: 'system';
  subtype: 'init';
  cwd: string;
  session_id: string;
  model: string;
  tools: string[];
  permissionMode?: string;
  uuid: string;
}

export interface TraceSystemThinkingTokens {
  type: 'system';
  subtype: 'thinking_tokens';
  estimated_tokens: number;
  estimated_tokens_delta: number;
  uuid: string;
}

export interface TraceSystemTaskStarted {
  type: 'system';
  subtype: 'task_started';
  task_id: string;
  tool_use_id: string;
  description: string;
  task_type: string;
  uuid: string;
}

export interface TraceSystemTaskNotification {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  tool_use_id: string;
  status: 'completed' | 'failed' | 'running';
  output_file: string;
  summary: string;
  uuid: string;
}

export type TraceSystemEvent =
  | TraceSystemInit
  | TraceSystemThinkingTokens
  | TraceSystemTaskStarted
  | TraceSystemTaskNotification;

export interface TraceUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export interface TraceContentThinking {
  type: 'thinking';
  thinking: string;
}
export interface TraceContentToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export interface TraceContentText {
  type: 'text';
  text: string;
}
export type TraceAssistantContent = TraceContentThinking | TraceContentToolUse | TraceContentText;

export interface TraceAssistantEvent {
  type: 'assistant';
  message: {
    content: TraceAssistantContent[];
    model: string;
    usage: TraceUsage;
  };
  uuid: string;
}

export interface TraceToolResultMeta {
  success: boolean;
  [key: string]: unknown;
}

export interface TraceContentToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Record<string, unknown>;
}

export interface TraceUserEvent {
  type: 'user';
  message: { role: 'user'; content: TraceContentToolResult[] };
  tool_use_result?: TraceToolResultMeta;
  uuid: string;
}

export interface TraceResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  total_cost_usd: number;
  usage: TraceUsage;
  uuid: string;
}

export type TraceEvent = TraceSystemEvent | TraceAssistantEvent | TraceUserEvent | TraceResultEvent;

/* ------------------------------------------------------------
   归一化后的 trace 展示项（由 normalizeTrace() 生成，供 UI 渲染）
   ------------------------------------------------------------ */

export interface TraceItemThinkingBurst {
  kind: 'thinking_burst';
  count: number;
  startTok: number;
  endTok: number;
}
export interface TraceItemInit {
  kind: 'init';
  model: string;
  cwd: string;
  tools: string[];
}
export interface TraceItemThinkingText {
  kind: 'thinking_text';
  text: string;
  tokens: TraceUsage;
}
export interface TraceItemToolUse {
  kind: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  tokens: TraceUsage;
  result: { content: string | Record<string, unknown>; meta?: TraceToolResultMeta } | null;
}
export interface TraceItemOrphanResult {
  kind: 'orphan_result';
  toolUseId: string;
  content: string | Record<string, unknown>;
  meta?: TraceToolResultMeta;
}
export interface TraceItemText {
  kind: 'text';
  text: string;
  tokens: TraceUsage;
}
export interface TraceItemBgTask {
  kind: 'bg_task';
  taskId: string;
  description: string;
  taskType: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
}
export interface TraceItemResult {
  kind: 'result';
  text: string;
  isError: boolean;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  usage: TraceUsage;
}

export type TraceItem =
  | TraceItemThinkingBurst
  | TraceItemInit
  | TraceItemThinkingText
  | TraceItemToolUse
  | TraceItemOrphanResult
  | TraceItemText
  | TraceItemBgTask
  | TraceItemResult;

export type TraceItemKind = TraceItem['kind'];

/* ------------------------------------------------------------
   output.tar.gz 内的产物成员（前端本地解压后得到的条目，非后端字段）
   ------------------------------------------------------------ */
export interface TarMember {
  name: string;
  size: number;
  data: Uint8Array;
}

export type ArtifactPreviewType = 'jsonl' | 'json' | 'md' | 'html' | 'text' | 'binary';

export type EndpointKind = 'target' | 'eval';

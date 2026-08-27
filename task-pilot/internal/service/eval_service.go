package service

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"task-pilot/internal/config"
	"task-pilot/internal/eval"
	"task-pilot/internal/filetransfer"
	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// EvalService 执行任务（EvalRun）编排：二段式执行——先派发 TestTask（被测），
// 测试成功后派发 EvalTask（评测 LLM），产出 Markdown 分析报告供人工审阅。
type EvalService struct {
	db           *gorm.DB
	cfg          *config.Config
	tasks        *TaskService
	caseSet      *CaseSetService
	configS      *ConfigService
	evalEndpoint *EvalEndpointService
	files        *filetransfer.Service
	prompts      *PromptService
	mcpConfigs   *MCPConfigService
	skillConfigs *SkillConfigService
	envVars      *EnvVarService
}

func NewEvalService(db *gorm.DB, cfg *config.Config, tasks *TaskService, caseSet *CaseSetService, configS *ConfigService, evalEndpoint *EvalEndpointService, files *filetransfer.Service, prompts *PromptService, mcpConfigs *MCPConfigService, skillConfigs *SkillConfigService, envVars *EnvVarService) *EvalService {
	return &EvalService{db: db, cfg: cfg, tasks: tasks, caseSet: caseSet, configS: configS, evalEndpoint: evalEndpoint, files: files, prompts: prompts, mcpConfigs: mcpConfigs, skillConfigs: skillConfigs, envVars: envVars}
}

// CreateEvalRunInput 创建执行任务输入。
type CreateEvalRunInput struct {
	CaseSetID  string
	Name       string
	EndpointID string
	// EvalEndpointID 评测端点；空则使用默认评测端点。
	EvalEndpointID string
	PromptID       string
	// MaxConcurrent 单请求并发上限；<=0 时回退到配置 scheduler.max_concurrent_per_run。
	MaxConcurrent int
	// TestImage 覆盖测试任务镜像；空时回退 Builtin.TestExecutorImage → cfg.DefaultImage。
	TestImage string
	// EvalImage 覆盖评测任务镜像；空时回退 Builtin.EvalExecutorImage。
	EvalImage string
	// TestModelCommand 覆盖测试任务模型启动命令片段（例如 "ccr code -p"）；
	// 空时回退 Builtin.DefaultTestModelCommand。
	TestModelCommand string
	// EvalModelCommand 覆盖评测任务模型启动命令片段（例如 "claude -p"）；
	// 空时回退 Builtin.DefaultEvalModelCommand。
	EvalModelCommand string
}

// shellSingleQuote 用单引号安全包裹字符串，防止命令注入。
func shellSingleQuote(v string) string {
	return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'"
}

// shellDoubleQuoteInner 转义将被嵌入双引号字符串内部的值（不含外层引号本身），
// 用于拼装 MCP/Skill 名称、路径等需要在双引号上下文中保持字面含义的片段。
func shellDoubleQuoteInner(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	value = strings.ReplaceAll(value, `$`, `\$`)
	value = strings.ReplaceAll(value, "`", "\\`")
	return value
}

// resolveTestImage 决定测试任务的容器镜像：
//   run.TestImage → Builtin.TestExecutorImage → cfg.Kubernetes.DefaultImage。
func resolveTestImage(run *model.EvalRun, cfg *config.Config) string {
	if run != nil && run.TestImage != "" {
		return run.TestImage
	}
	if config.Builtin.TestExecutorImage != "" {
		return config.Builtin.TestExecutorImage
	}
	return cfg.Kubernetes.DefaultImage
}

// resolveEvalImage 决定评测任务的容器镜像：
//   run.EvalImage → Builtin.EvalExecutorImage。
func resolveEvalImage(run *model.EvalRun) string {
	if run != nil && run.EvalImage != "" {
		return run.EvalImage
	}
	return config.Builtin.EvalExecutorImage
}

// resolveEvalModelCommand 决定评测任务的模型启动命令：
//   run.EvalModelCommand → Builtin.DefaultEvalModelCommand。
// 传给 eval.BuildEvalCommand 后，若仍为空则由其内部再兜底为 "claude -p --dangerously-skip-permissions"。
func resolveEvalModelCommand(run *model.EvalRun) string {
	if run != nil && run.EvalModelCommand != "" {
		return run.EvalModelCommand
	}
	return config.Builtin.DefaultEvalModelCommand
}

// buildAgentSetupScript 生成测试任务执行 agent 命令前需要预先跑的“环境准备”脚本：
//   - 把用例绑定的 MCPConfig 合并写入 $WORKSPACE/.mcp.json（mcpServers.<name> = 配置对象），
//     Claude Code 会在启动时从当前工作目录读取该文件自动加载 MCP server；
//   - 把用例绑定的 SkillConfig 还原为 $HOME/.claude/skills/<name>/SKILL.md（及其附加文件），
//     Claude Code 会从 $HOME/.claude/skills/ 发现并加载 Skill。
//
// 两者都用 heredoc 写文件而非 printf 拼接：内容本身可能含引号/反引号/$ 等，heredoc 逐项使用
// 唯一定界符（含用例内序号）避免相邻多个配置之间的定界符冲突或提前截断。
// 找不到绑定（mcps/skills 均为空）时返回空串，不改变现有行为。
func buildAgentSetupScript(mcps []model.MCPConfig, skills []model.SkillConfig) string {
	if len(mcps) == 0 && len(skills) == 0 {
		return ""
	}
	var b strings.Builder

	if len(mcps) > 0 {
		b.WriteString("mkdir -p \"$WORKSPACE\"\n")
		// 用 python3 拼装合法 JSON（各 ConfigJSON 本身是任意结构的 JSON 值，逐项在 shell 里
		// 用字符串拼接容易在转义上出错；服务端已在写入时校验过是合法 JSON 对象）。
		b.WriteString("cat > \"$WORKSPACE/.tp_mcp_merge.py\" <<'TASKPILOT_MCP_MERGE_PY_EOF'\n")
		b.WriteString(mcpMergeScript)
		b.WriteString("\nTASKPILOT_MCP_MERGE_PY_EOF\n")
		for i := range mcps {
			delim := fmt.Sprintf("TASKPILOT_MCP_%d_EOF", i)
			b.WriteString(fmt.Sprintf("cat > \"$WORKSPACE/.tp_mcp_%d.json\" <<'%s'\n", i, delim))
			b.WriteString(mcps[i].ConfigJSON)
			b.WriteString("\n" + delim + "\n")
			b.WriteString(fmt.Sprintf(
				"python3 \"$WORKSPACE/.tp_mcp_merge.py\" \"$WORKSPACE/.mcp.json\" %s \"$WORKSPACE/.tp_mcp_%d.json\"\n",
				shellSingleQuote(mcps[i].Name), i,
			))
		}
		b.WriteString("rm -f \"$WORKSPACE\"/.tp_mcp_*.json \"$WORKSPACE/.tp_mcp_merge.py\"\n")
	}

	for i := range skills {
		sk := skills[i]
		skillDirQuoted := "\"$HOME/.claude/skills/" + shellDoubleQuoteInner(sk.Name) + "\""
		b.WriteString("mkdir -p " + skillDirQuoted + "\n")
		mdDelim := fmt.Sprintf("TASKPILOT_SKILL_%d_MD_EOF", i)
		b.WriteString(fmt.Sprintf("cat > %s/SKILL.md <<'%s'\n", skillDirQuoted, mdDelim))
		b.WriteString(sk.ContentMD)
		b.WriteString("\n" + mdDelim + "\n")

		extraFiles := model.DecodeExtraFiles(sk.ExtraFilesJSON)
		if len(extraFiles) > 0 {
			// map 遍历顺序不确定，但生成的仅是若干条互相独立的 mkdir/cat 语句，
			// 顺序不影响最终落地结果，因此不需要额外排序。
			j := 0
			for relPath, content := range extraFiles {
				// path.Clean("/"+relPath)[1:] 把 "../x"、"a//b"、"/a/b" 等一律归一为
				// 相对于 skill 目录内部的干净路径，杜绝路径穿越写到目录外。
				safeRel := path.Clean("/" + relPath)[1:]
				if safeRel == "" || safeRel == "." {
					continue
				}
				fullPathQuoted := skillDirQuoted[:len(skillDirQuoted)-1] + "/" + shellDoubleQuoteInner(safeRel) + "\""
				subdir := path.Dir(safeRel)
				if subdir != "." {
					subdirQuoted := skillDirQuoted[:len(skillDirQuoted)-1] + "/" + shellDoubleQuoteInner(subdir) + "\""
					b.WriteString("mkdir -p " + subdirQuoted + "\n")
				}
				fileDelim := fmt.Sprintf("TASKPILOT_SKILL_%d_EXTRA_%d_EOF", i, j)
				b.WriteString(fmt.Sprintf("cat > %s <<'%s'\n", fullPathQuoted, fileDelim))
				b.WriteString(content)
				b.WriteString("\n" + fileDelim + "\n")
				j++
			}
		}
	}

	return b.String()
}

// mcpMergeScript 是一段内嵌的最小 Python 脚本：把一个 MCP server 的配置对象合并进
// 目标 .mcp.json 的 mcpServers.<name> 字段（若目标文件不存在则新建）。用 Python 而非 jq
// 是因为执行器镜像必装 python3（PPT/HTML 渲染依赖），而 jq 未必存在。
const mcpMergeScript = `import json, sys
target_path, name, config_path = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(target_path) as f:
        doc = json.load(f)
except (FileNotFoundError, ValueError):
    doc = {}
if not isinstance(doc, dict):
    doc = {}
servers = doc.get("mcpServers")
if not isinstance(servers, dict):
    servers = {}
with open(config_path) as f:
    servers[name] = json.load(f)
doc["mcpServers"] = servers
with open(target_path, "w") as f:
    json.dump(doc, f, indent=2)
`

// buildTestCommand 组装测试任务命令：先按用例绑定还原 MCP/Skill 配置，再切换被测模型端点、
// 执行任务描述，并以 stream-json + --verbose 采集被测方的完整执行 trace（逐事件：工具调用/
// 消息/用量），落盘到 output/trace.jsonl。该文件随产物 tar.gz 上传持久化，
// 评测阶段会把测试产物作为原材料一并喂给评测 LLM，故 trace 自动进入评测输入。
// api_key 通过环境变量 TARGET_API_KEY 引用，不写入命令字面量。
//
// modelCommand 是模型启动命令片段前缀，例如 "ccr code -p"、"claude -p"；
// 传空串时回退为 "ccr code -p"，保持向后兼容。
// setupScript 为 buildAgentSetupScript 的产出，空串时不影响既有行为。
func buildTestCommand(description string, modelCommand string, setupScript string) string {
	var b strings.Builder
	modelCmd := strings.TrimSpace(modelCommand)
	if modelCmd == "" {
		modelCmd = "claude -p --dangerously-skip-permissions"
	}
	if setupScript != "" {
		b.WriteString(setupScript)
	}
	b.WriteString("lumi-model-setup switch claude")
	b.WriteString(" --base-url \"$TARGET_BASE_URL\"")
	b.WriteString(" --api-key \"$TARGET_API_KEY\"")
	b.WriteString(" --model \"$TARGET_MODEL_NAME\"\n")
	// stream-json 需配 --verbose。用重定向而非管道采集 trace：executor 的 sh(dash)
	// 不支持 set -o pipefail，管道会吞掉退出码；直接重定向则原样保留退出码。
	// 临时关闭 set -e，确保 agent 命令失败时仍能 cat trace 并归集 output，随后再按原退出码失败。
	b.WriteString("set +e\n")
	b.WriteString(modelCmd)
	b.WriteString(" ")
	b.WriteString(shellSingleQuote(description))
	b.WriteString(" --output-format stream-json --verbose > output/trace.jsonl 2>&1\n")
	b.WriteString("task_pilot_agent_rc=$?\n")
	b.WriteString("set -e\n")
	b.WriteString("cat output/trace.jsonl || true\n")
	// 被测 agent 的工作目录是 $WORKSPACE，其生成的交付物（报告/CSV/代码等）多落在工作区
	// 根目录，而非 output/。而 executor 只打包 output/ 目录，导致产物里只剩 trace.jsonl。
	// 这里把根目录下新增的文件/目录（排除受管目录 input/output/tmp）归集进 output/，
	// 确保被测系统的真实产出随 output.tar.gz 一并上传。-maxdepth 1 只取根层，cp -a 保留属性；
	// 找不到内容时 find 正常退出，不影响 set -e。
	b.WriteString("find \"$WORKSPACE\" -maxdepth 1 -mindepth 1 ! -name input ! -name output ! -name tmp -exec cp -a {} \"$WORKSPACE/output/\" \\; 2>/dev/null || true\n")
	b.WriteString("if [ \"$task_pilot_agent_rc\" -ne 0 ]; then exit \"$task_pilot_agent_rc\"; fi\n")
	return b.String()
}

// CreateEvalRun 创建执行任务：仅落库并把每条用例排入 PENDING 队列，
// 实际 Job 派发由 ScheduleOnce 按全局并发额度出队进行（不再即时全量派发）。
func (s *EvalService) CreateEvalRun(ctx context.Context, in CreateEvalRunInput) (*model.EvalRun, error) {
	if in.CaseSetID == "" {
		return nil, fmt.Errorf("case_set_id is required")
	}
	cs, err := s.caseSet.Get(in.CaseSetID)
	if err != nil {
		return nil, fmt.Errorf("load case set: %w", err)
	}
	if len(cs.Cases) == 0 {
		return nil, fmt.Errorf("case set has no cases")
	}

	// 解析被测端点（仅校验存在性；api_key 在派发时才解密），并记录 endpoint_id。
	var endpoint *model.TargetEndpoint
	if in.EndpointID != "" {
		endpoint, err = s.configS.GetEndpoint(in.EndpointID)
	} else {
		endpoint, err = s.configS.DefaultEndpoint()
	}
	if err != nil {
		return nil, fmt.Errorf("resolve target endpoint: %w", err)
	}

	// 解析评测端点（指定优先，否则默认），并记录 eval_endpoint_id；api_key 在派发时才解密。
	var evalEndpoint *model.EvalEndpoint
	if in.EvalEndpointID != "" {
		evalEndpoint, err = s.evalEndpoint.GetEndpoint(in.EvalEndpointID)
	} else {
		evalEndpoint, err = s.evalEndpoint.DefaultEndpoint()
	}
	if err != nil {
		return nil, fmt.Errorf("resolve eval endpoint: %w", err)
	}

	// 解析评测 prompt（指定优先，否则默认），并将其内容快照到本次 run，保证可复现。
	var prompt *model.EvalPrompt
	if in.PromptID != "" {
		prompt, err = s.prompts.Get(in.PromptID)
	} else {
		prompt, err = s.prompts.Default()
	}
	if err != nil {
		return nil, fmt.Errorf("resolve eval prompt: %w", err)
	}

	snapshot := buildSnapshot(cs)
	name := in.Name
	if name == "" {
		name = cs.Name + "-run"
	}
	// 单请求并发上限：请求显式指定优先，否则用服务端配置默认值。
	maxConcurrent := in.MaxConcurrent
	if maxConcurrent <= 0 {
		maxConcurrent = s.cfg.Scheduler.MaxConcurrentPerRun
	}
	runID := util.NewID("er")
	run := &model.EvalRun{
		ID:             runID,
		Name:           name,
		CaseSetID:      cs.ID,
		EndpointID:     endpoint.ID,
		EvalEndpointID: evalEndpoint.ID,
		PromptID:       prompt.ID,
		PromptSnapshot: prompt.Content,
		SnapshotJSON:   model.EncodeSnapshot(snapshot),
		Status:         model.EvalRunRunning,
		Total:          len(cs.Cases),
		MaxConcurrent:  maxConcurrent,
		TestImage:        strings.TrimSpace(in.TestImage),
		EvalImage:        strings.TrimSpace(in.EvalImage),
		TestModelCommand: strings.TrimSpace(in.TestModelCommand),
		EvalModelCommand: strings.TrimSpace(in.EvalModelCommand),
		// ScorePromptVersion 冻结创建时的机评量化脚本版本，保证历史 run 的语义不随后续
		// 版本升级而改变（与 PromptSnapshot/SnapshotJSON 的“创建时冻结”原则一致）。
		ScorePromptVersion: eval.CurrentScorePromptVersion,
	}
	if err := s.db.Create(run).Error; err != nil {
		return nil, err
	}

	// 每条用例仅入队为 PENDING，等待调度器派发测试任务。
	for i := range cs.Cases {
		c := cs.Cases[i]
		ce := &model.CaseExecution{
			ID:        util.NewID("ce"),
			EvalRunID: runID,
			CaseID:    c.ID,
			CaseName:  c.Name,
			Status:    model.CaseExecPending,
			OrderNo:   c.OrderNo,
		}
		if err := s.db.Create(ce).Error; err != nil {
			return nil, err
		}
	}

	return s.GetEvalRun(runID)
}

// resolveInputFiles 将文件 ID 列表解析为带真实文件名的输入规格。文件名取自文件对象元数据，
// 使被测系统在工作区 input/ 下看到的是用户上传时的原始文件名（如 sales_h1_2025.csv），
// 而非内部 fileID。查不到元数据时回退用 fileID 作为文件名（保底可下载）。
func (s *EvalService) resolveInputFiles(fileIDs []string) []model.InputFileSpec {
	if len(fileIDs) == 0 {
		return nil
	}
	specs := make([]model.InputFileSpec, 0, len(fileIDs))
	for _, id := range fileIDs {
		if id == "" {
			continue
		}
		filename := id
		if fo, err := s.files.Get(id); err == nil && fo.Filename != "" {
			filename = fo.Filename
		}
		specs = append(specs, model.InputFileSpec{FileID: id, Filename: filename})
	}
	return specs
}

// resolveCheckpointInputs 把快照中各条校验点绑定的参考文件（如标准答案、评分参考图、规范
// 文档）解析为 (a) eval.EvalInput 里每条校验点携带的文件名清单，(b) 需要一并下发到评测执行器
// input/ 目录的文件规格。文件名统一加 "ckpt_<序号>__" 前缀，避免与用例原始输入文件/测试产物/
// 系统内置的评分辅助脚本同名冲突，同时让评测 agent 从文件名就能对应到具体第几条校验点。
// 校验点文件绝不进入测试任务的输入区，只在评测阶段下发——与校验点文本本身的隔离原则一致。
func (s *EvalService) resolveCheckpointInputs(checkpoints []model.EvalRunSnapshotCheckpoint) ([]eval.EvalCheckpoint, []model.InputFileSpec) {
	evalCheckpoints := make([]eval.EvalCheckpoint, 0, len(checkpoints))
	var specs []model.InputFileSpec
	for i, cp := range checkpoints {
		var names []string
		for _, id := range cp.FileIDs {
			if id == "" {
				continue
			}
			filename := id
			if fo, err := s.files.Get(id); err == nil && fo.Filename != "" {
				filename = fo.Filename
			}
			prefixed := fmt.Sprintf("ckpt_%d__%s", i+1, filename)
			names = append(names, prefixed)
			specs = append(specs, model.InputFileSpec{FileID: id, Filename: prefixed})
		}
		evalCheckpoints = append(evalCheckpoints, eval.EvalCheckpoint{
			Description: cp.Description,
			Files:       names,
		})
	}
	return evalCheckpoints, specs
}

func buildSnapshot(cs *model.CaseSet) model.EvalRunSnapshot {
	snap := model.EvalRunSnapshot{
		CaseSetID:   cs.ID,
		CaseSetName: cs.Name,
		Version:     cs.Version,
	}
	for _, c := range cs.Cases {
		cps := make([]model.EvalRunSnapshotCheckpoint, 0, len(c.Checkpoints))
		for _, cp := range c.Checkpoints {
			cps = append(cps, model.EvalRunSnapshotCheckpoint{
				Description: cp.Description,
				FileIDs:     cp.FileIDs,
			})
		}
		snap.Cases = append(snap.Cases, model.EvalRunSnapshotCase{
			CaseID:              c.ID,
			Name:                c.Name,
			Description:         c.Description,
			FileIDs:             c.FileIDs,
			Checkpoints:         cps,
			MCPIDs:              c.MCPIDs,
			SkillIDs:            c.SkillIDs,
			Level1Type:          c.Level1Type,
			Level2Type:          c.Level2Type,
			TaskTypes:           c.TaskTypes,
			Difficulty:          c.Difficulty,
			SkipHTMLVisualScore: c.SkipHTMLVisualScore,
		})
	}
	return snap
}

// GetEvalRun 查询执行任务（含各用例执行状态）。
func (s *EvalService) GetEvalRun(id string) (*model.EvalRun, error) {
	var run model.EvalRun
	err := s.db.Preload("CaseExecutions", func(db *gorm.DB) *gorm.DB {
		return db.Order("order_no asc")
	}).First(&run, "id = ?", id).Error
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// ListEvalRuns 列出执行任务（不含用例明细）。
func (s *EvalService) ListEvalRuns() ([]model.EvalRun, error) {
	var runs []model.EvalRun
	if err := s.db.Order("created_at desc").Limit(100).Find(&runs).Error; err != nil {
		return nil, err
	}
	return runs, nil
}

// ListRunningCaseExecutions 跨所有 EvalRun 返回当前正在执行的用例（测试或评测阶段），
// 即状态为 TEST_RUNNING / EVAL_RUNNING 的用例执行；与调度器 runningCount 的口径一致，
// 反映的正是当前占用并发额度的那批用例。按开始时间升序（先进先出，久跑的排前）。
func (s *EvalService) ListRunningCaseExecutions() ([]model.CaseExecution, error) {
	var ces []model.CaseExecution
	err := s.db.
		Where("status IN ?", []model.CaseExecutionStatus{model.CaseExecTestRunning, model.CaseExecEvalRunning}).
		Order("updated_at asc").
		Limit(200).
		Find(&ces).Error
	if err != nil {
		return nil, err
	}
	return ces, nil
}

// StopEvalRun 停止执行任务：删除未终态用例的 TestTask Job，置为 STOPPED。
func (s *EvalService) StopEvalRun(ctx context.Context, id string) (*model.EvalRun, error) {
	run, err := s.GetEvalRun(id)
	if err != nil {
		return nil, err
	}
	for i := range run.CaseExecutions {
		ce := run.CaseExecutions[i]
		if ce.Status.IsTerminal() {
			continue
		}
		// 取消当前阶段对应的 Job（测试或评测）。
		for _, taskID := range []string{ce.TestTaskID, ce.EvalTaskID} {
			if taskID == "" {
				continue
			}
			if _, err := s.tasks.CancelTask(ctx, taskID); err != nil {
				s.db.Model(&ce).Update("message", err.Error())
			}
		}
		now := time.Now()
		s.db.Model(&ce).Updates(map[string]any{"status": model.CaseExecStopped, "finished_at": &now})
	}
	now := time.Now()
	s.db.Model(run).Updates(map[string]any{"status": model.EvalRunStopped, "finished_at": &now})
	return s.GetEvalRun(id)
}

// DeleteEvalRun 删除执行任务：先停止仍在运行的用例，再软删除 run 与用例执行。
func (s *EvalService) DeleteEvalRun(ctx context.Context, id string) error {
	run, err := s.GetEvalRun(id)
	if err != nil {
		return err
	}
	if run.Status == model.EvalRunRunning || run.Status == model.EvalRunPending {
		if _, err := s.StopEvalRun(ctx, id); err != nil {
			return err
		}
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("eval_run_id = ?", id).Delete(&model.CaseExecution{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.EvalRun{}, "id = ?", id).Error
	})
}

// GetResults 返回执行任务的完整结果：每条用例含其 Markdown 分析报告全文。
func (s *EvalService) GetResults(id string) (*model.EvalRun, error) {
	var run model.EvalRun
	err := s.db.Preload("CaseExecutions", func(db *gorm.DB) *gorm.DB {
		return db.Order("order_no asc")
	}).First(&run, "id = ?", id).Error
	if err != nil {
		return nil, err
	}
	return &run, nil
}

// runningCount 返回全局处于运行中的用例任务数（测试 + 评测阶段），用于并发限流。
func (s *EvalService) runningCount() (int64, error) {
	var n int64
	err := s.db.Model(&model.CaseExecution{}).
		Where("status IN ?", []model.CaseExecutionStatus{model.CaseExecTestRunning, model.CaseExecEvalRunning}).
		Count(&n).Error
	return n, err
}

// runningCountPerRun 返回每个 EvalRun 当前运行中的用例数（测试 + 评测），
// 用于单请求（per-run）并发上限判定。
func (s *EvalService) runningCountPerRun() (map[string]int, error) {
	type row struct {
		EvalRunID string
		N         int
	}
	var rows []row
	err := s.db.Model(&model.CaseExecution{}).
		Select("eval_run_id, count(*) as n").
		Where("status IN ?", []model.CaseExecutionStatus{model.CaseExecTestRunning, model.CaseExecEvalRunning}).
		Group("eval_run_id").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	m := make(map[string]int, len(rows))
	for _, r := range rows {
		m[r.EvalRunID] = r.N
	}
	return m, nil
}

// ScheduleOnce 是并发调度器，叠加两级额度：
//   - 全局额度：max_concurrent_tasks - 全局运行中用例数（跨所有 EvalRun）；
//   - 单请求额度：每个 EvalRun 的 MaxConcurrent - 该 run 运行中用例数。
// 二者同时满足才派发。优先派发待评测（TEST_DONE，让在途用例尽快完成并释放额度），
// 再派发待测试（PENDING）。全局或单请求 <=0 表示对应维度不限流。
func (s *EvalService) ScheduleOnce(ctx context.Context) error {
	maxTasks := s.cfg.Scheduler.MaxConcurrentTasks

	available := -1 // -1 表示全局不限流
	if maxTasks > 0 {
		running, err := s.runningCount()
		if err != nil {
			return err
		}
		available = maxTasks - int(running)
		if available <= 0 {
			return nil
		}
	}

	// 各 run 当前运行中用例数，用于单请求并发上限判定；派发过程中就地累加，
	// 两次 dispatchPending 共享同一份计数。
	perRun, err := s.runningCountPerRun()
	if err != nil {
		return err
	}

	// 1) 先派发待评测用例（TEST_DONE → EVAL_RUNNING）。
	dispatched := s.dispatchPending(ctx, model.CaseExecTestDone, available, perRun)
	if available > 0 {
		available -= dispatched
		if available <= 0 {
			return nil
		}
	}

	// 2) 再派发待测试用例（PENDING → TEST_RUNNING）。
	s.dispatchPending(ctx, model.CaseExecPending, available, perRun)
	return nil
}

// dispatchPending 按 FIFO 遍历指定状态的用例并派发，同时受全局额度 limit（<0 不限）
// 与每个 run 的单请求并发上限约束。perRun 为各 run 运行中计数，成功派发即就地 +1。
// 返回实际派发（消耗全局额度）的数量。
func (s *EvalService) dispatchPending(ctx context.Context, status model.CaseExecutionStatus, limit int, perRun map[string]int) int {
	// 不用 SQL Limit：需按 per-run 上限跳过部分候选，故取全部候选后在内存中判定。
	var ces []model.CaseExecution
	if err := s.db.Where("status = ?", status).Order("created_at asc").Find(&ces).Error; err != nil {
		return 0
	}
	dispatched := 0
	for i := range ces {
		ce := &ces[i]
		// 全局额度用尽则停止（limit<0 视为不限）。
		if limit >= 0 && dispatched >= limit {
			break
		}
		run, err := s.getRun(ce.EvalRunID)
		if err != nil {
			continue
		}
		// 单请求并发上限：该 run 已达上限则跳过，把额度让给其他 run，避免单请求独占。
		if run.MaxConcurrent > 0 && perRun[ce.EvalRunID] >= run.MaxConcurrent {
			continue
		}

		var ok bool
		if status == model.CaseExecPending {
			ok = s.dispatchTestTask(ctx, ce)
		} else {
			ok = s.dispatchEvalTask(ctx, ce, model.DecodeSnapshot(run.SnapshotJSON))
		}
		if ok {
			dispatched++
			perRun[ce.EvalRunID]++
		}
	}
	return dispatched
}

func (s *EvalService) getRun(id string) (*model.EvalRun, error) {
	var run model.EvalRun
	if err := s.db.First(&run, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &run, nil
}

// dispatchTestTask 为一条 PENDING 用例派发测试任务。返回是否成功占用额度。
// 关键隔离：测试任务只收到任务描述 + 输入文件 + 被测端点，不含任何校验点。
func (s *EvalService) dispatchTestTask(ctx context.Context, ce *model.CaseExecution) bool {
	run, err := s.getRun(ce.EvalRunID)
	if err != nil {
		return false
	}
	endpoint, err := s.configS.GetEndpoint(run.EndpointID)
	if err != nil {
		s.failEval(ce, "resolve endpoint: "+err.Error())
		return false
	}
	apiKey, err := s.configS.ResolveAPIKey(endpoint)
	if err != nil {
		s.failEval(ce, "decrypt api_key: "+err.Error())
		return false
	}
	sc := snapshotCase(model.DecodeSnapshot(run.SnapshotJSON), ce.CaseID)
	if sc == nil {
		s.failEval(ce, "snapshot case not found")
		return false
	}

	// 解析用例快照冻结的 MCP/Skill 绑定，生成派发前需要在执行器 Pod 内还原的配置脚本；
	// 未绑定或绑定的 ID 在派发时已被删除（GetMany 静默跳过缺失项）均不影响测试任务正常派发。
	mcps, err := s.mcpConfigs.GetMany(sc.MCPIDs)
	if err != nil {
		s.failEval(ce, "resolve mcp configs: "+err.Error())
		return false
	}
	skills, err := s.skillConfigs.GetMany(sc.SkillIDs)
	if err != nil {
		s.failEval(ce, "resolve skill configs: "+err.Error())
		return false
	}
	setupScript := buildAgentSetupScript(mcps, skills)

	// 用例描述可含 {{KEY}}；派发时用全局环境变量明文替换，库内/快照仍保留占位符。
	envMap, err := s.envVars.ResolveMap()
	if err != nil {
		s.failEval(ce, "resolve env vars: "+err.Error())
		return false
	}
	description, err := SubstituteEnvVars(sc.Description, envMap)
	if err != nil {
		s.failEval(ce, "substitute env vars: "+err.Error())
		return false
	}

	task, err := s.tasks.CreateTask(ctx, CreateTaskInput{
		Name:       fmt.Sprintf("%s-%s", run.Name, ce.CaseName),
		Image:      resolveTestImage(run, s.cfg),
		Command:    buildTestCommand(description, run.TestModelCommand, setupScript),
		InputFiles: s.resolveInputFiles(sc.FileIDs),
		Env: map[string]string{
			"TARGET_BASE_URL":   endpoint.BaseURL,
			"TARGET_MODEL_NAME": endpoint.ModelName,
			"TARGET_API_KEY":    apiKey,
		},
		Role:            "test",
		CaseExecutionID: ce.ID,
		TimeoutSeconds:  config.Builtin.TestTimeoutSeconds,
	})
	if err != nil {
		s.failEval(ce, "dispatch test task: "+err.Error())
		return false
	}
	s.db.Model(ce).Updates(map[string]any{"test_task_id": task.ID, "status": model.CaseExecTestRunning})
	return true
}

// ReconcileOnce 推进各 EvalRun 的二段式流程并重算聚合状态。
func (s *EvalService) ReconcileOnce(ctx context.Context) error {
	var runs []model.EvalRun
	if err := s.db.Where("status = ?", model.EvalRunRunning).Find(&runs).Error; err != nil {
		return err
	}
	for i := range runs {
		s.reconcileRun(ctx, runs[i])
	}
	return nil
}

func (s *EvalService) reconcileRun(ctx context.Context, run model.EvalRun) {
	var ces []model.CaseExecution
	if err := s.db.Where("eval_run_id = ?", run.ID).Find(&ces).Error; err != nil {
		return
	}
	for i := range ces {
		s.reconcileCaseExecution(ctx, &ces[i])
	}
	s.aggregate(run.ID)
}

// reconcileCaseExecution 推进单条用例已派发阶段的状态（测试/评测任务终态处理）。
// 未派发的 PENDING / 待评测的 TEST_DONE 由 ScheduleOnce 负责派发。
func (s *EvalService) reconcileCaseExecution(ctx context.Context, ce *model.CaseExecution) {
	switch ce.Status {
	case model.CaseExecTestRunning:
		s.advanceTestStage(ctx, ce)
	case model.CaseExecEvalRunning:
		s.advanceEvalStage(ctx, ce)
	}
}

// advanceTestStage 处理测试任务终态：成功→置 TEST_DONE 等待调度评测；失败→ERROR。
func (s *EvalService) advanceTestStage(ctx context.Context, ce *model.CaseExecution) {
	if ce.TestTaskID == "" {
		return
	}
	task, err := s.tasks.GetTask(ce.TestTaskID)
	if err != nil {
		return
	}
	switch task.Status {
	case model.TaskStatusSucceeded:
		updates := map[string]any{"status": model.CaseExecTestDone}
		if task.ExitCode != nil {
			updates["exit_code"] = *task.ExitCode
		}
		s.db.Model(ce).Updates(updates)
	case model.TaskStatusFailed:
		now := time.Now()
		s.db.Model(ce).Updates(map[string]any{
			"status": model.CaseExecError, "message": task.ErrorMessage, "finished_at": &now,
		})
	case model.TaskStatusCancelled:
		now := time.Now()
		s.db.Model(ce).Updates(map[string]any{"status": model.CaseExecStopped, "finished_at": &now})
	}
}

// snapshotCase 按 caseID 查找快照中的用例（含校验点）。
func snapshotCase(snapshot model.EvalRunSnapshot, caseID string) *model.EvalRunSnapshotCase {
	for i := range snapshot.Cases {
		if snapshot.Cases[i].CaseID == caseID {
			return &snapshot.Cases[i]
		}
	}
	return nil
}

// dispatchEvalTask 派发评测任务：把测试产物 + 描述 + 校验点交给评测执行器。
// 返回是否成功占用了一个并发额度（派发成功或因失败终态而消耗判定，均视为已处理）。
func (s *EvalService) dispatchEvalTask(ctx context.Context, ce *model.CaseExecution, snapshot model.EvalRunSnapshot) bool {
	sc := snapshotCase(snapshot, ce.CaseID)
	if sc == nil {
		now := time.Now()
		s.db.Model(ce).Updates(map[string]any{
			"status": model.CaseExecError, "message": "snapshot case not found", "finished_at": &now,
		})
		return false
	}

	// 组装评测输入：任务描述 + 校验点（含各自参考文件名清单） + 测试过程日志。
	testLog := s.tasks.FetchLogs(ctx, ce.TestTaskID)
	evalCheckpoints, checkpointFileSpecs := s.resolveCheckpointInputs(sc.Checkpoints)
	evalInputJSON, err := eval.BuildEvalInputJSON(eval.EvalInput{
		CaseName:    sc.Name,
		Description: sc.Description,
		Checkpoints: evalCheckpoints,
		TestLog:     testLog,
	})
	if err != nil {
		s.failEval(ce, "build eval input: "+err.Error())
		return false
	}

	// 评测输入落盘为文件对象，作为评测任务的 input_files 之一。
	inputFile, err := s.files.SaveBytes([]byte(evalInputJSON), "eval_input.json", model.FilePurposeInput, ce.ID)
	if err != nil {
		s.failEval(ce, "save eval input: "+err.Error())
		return false
	}

	// PPT 美观度评分器需要 gold_reference.json。当前用例模型只有自由文本校验点，
	// 第一版将 checkpoints 映射到 key_points_coverage，并使用评分器默认权重。
	checkpointDescs := make([]string, 0, len(sc.Checkpoints))
	for _, cp := range sc.Checkpoints {
		checkpointDescs = append(checkpointDescs, cp.Description)
	}
	pptGoldJSON, err := eval.BuildPPTGoldReferenceJSON(sc.CaseID, sc.Name, checkpointDescs)
	if err != nil {
		s.failEval(ce, "build ppt gold reference: "+err.Error())
		return false
	}
	pptGoldFile, err := s.files.SaveBytes([]byte(pptGoldJSON), "gold_reference.json", model.FilePurposeInput, ce.ID)
	if err != nil {
		s.failEval(ce, "save ppt gold reference: "+err.Error())
		return false
	}

	// 一并把测试产物作为评测输入（评测执行器读取过程与结果）。
	inputFiles := []model.InputFileSpec{
		{FileID: inputFile.ID, Filename: "eval_input.json"},
		{FileID: pptGoldFile.ID, Filename: "gold_reference.json"},
	}
	artifacts, _ := s.files.ListArtifacts(ce.TestTaskID)
	for i := range artifacts {
		inputFiles = append(inputFiles, model.InputFileSpec{FileID: artifacts[i].ID, Filename: artifacts[i].Filename})
	}

	// 把用例关联的原始输入文件一并作为评测输入，使评测 LLM 能直接看到被测系统拿到的原始输入。
	// 复用 resolveInputFiles 解析真实文件名（缺失则回退 fileID），供评测脚本按名读取并拼入 prompt。
	inputFiles = append(inputFiles, s.resolveInputFiles(sc.FileIDs)...)

	// 校验点各自绑定的参考文件（标准答案/评分参考图/规范文档等），仅在评测阶段下发，
	// 测试任务不会看到——与校验点文本本身对被测 agent 保密的原则一致。
	inputFiles = append(inputFiles, checkpointFileSpecs...)

	// 下发 PPT/HTML 图片渲染与评分辅助脚本。EvalTask 会在检测到 PPTX/PPT 产物时
	// best-effort 调用 ppt_score_runner.py，检测到 HTML 产物时调用
	// html_score_runner.py；两者共用同一个 render_deck.py 纯语言渲染实现
	// （pptx→python-pptx+Pillow，html→playwright），产物统一为逐页 PNG 供评测
	// Claude 用 Read 工具评审。
	for _, name := range eval.PPTScorerFilenames {
		data, err := eval.ReadPPTScorerFile(name)
		if err != nil {
			s.failEval(ce, "load ppt scorer "+name+": "+err.Error())
			return false
		}
		fo, err := s.files.SaveBytes(data, name, model.FilePurposeInput, ce.ID)
		if err != nil {
			s.failEval(ce, "save ppt scorer "+name+": "+err.Error())
			return false
		}
		inputFiles = append(inputFiles, model.InputFileSpec{FileID: fo.ID, Filename: name})
	}

	// 解析评测端点：优先本次 run 记录的 eval_endpoint_id；为空（历史数据）回退默认端点。
	run, runErr := s.getRun(ce.EvalRunID)
	var evalEP *model.EvalEndpoint
	if runErr == nil && run.EvalEndpointID != "" {
		evalEP, err = s.evalEndpoint.GetEndpoint(run.EvalEndpointID)
	} else {
		evalEP, err = s.evalEndpoint.DefaultEndpoint()
	}
	if err != nil {
		s.failEval(ce, "resolve eval endpoint: "+err.Error())
		return false
	}
	evalAPIKey, err := s.evalEndpoint.ResolveAPIKey(evalEP)
	if err != nil {
		s.failEval(ce, "decrypt eval api_key: "+err.Error())
		return false
	}
	evalEnv := map[string]string{
		"EVAL_BASE_URL":   evalEP.BaseURL,
		"EVAL_MODEL_NAME": evalEP.ModelName,
		"EVAL_API_KEY":    evalAPIKey,
	}

	// 使用本次 run 快照的用户自定义评测 prompt。
	promptContent := config.Builtin.EvalPromptTemplate
	if runErr == nil && run.PromptSnapshot != "" {
		promptContent = run.PromptSnapshot
	}

	task, err := s.tasks.CreateTask(ctx, CreateTaskInput{
		Name:            "eval-" + ce.CaseName,
		Image:           resolveEvalImage(run),
		Command:         eval.BuildEvalCommand(promptContent, resolveEvalModelCommand(run), sc.SkipHTMLVisualScore),
		InputFiles:      inputFiles,
		Env:             evalEnv,
		Role:            "eval",
		CaseExecutionID: ce.ID,
		TimeoutSeconds:  config.Builtin.EvalTimeoutSeconds,
	})
	if err != nil {
		s.failEval(ce, "dispatch eval task: "+err.Error())
		return false
	}
	s.db.Model(ce).Updates(map[string]any{"eval_task_id": task.ID, "status": model.CaseExecEvalRunning})
	return true
}

// advanceEvalStage 处理评测任务终态：解析报告 → REPORTED；失败→ERROR。
func (s *EvalService) advanceEvalStage(ctx context.Context, ce *model.CaseExecution) {
	if ce.EvalTaskID == "" {
		return
	}
	task, err := s.tasks.GetTask(ce.EvalTaskID)
	if err != nil {
		return
	}
	switch task.Status {
	case model.TaskStatusSucceeded:
		s.processReport(ce)
	case model.TaskStatusFailed:
		s.failEval(ce, "eval task failed: "+task.ErrorMessage)
	case model.TaskStatusCancelled:
		now := time.Now()
		s.db.Model(ce).Updates(map[string]any{"status": model.CaseExecStopped, "finished_at": &now})
	}
}

// processReport 读取评测任务产物 report.md，原样保存为用例的分析报告并置 REPORTED。
// 报告正文是给人阅读的自由格式文本，不做任何机器判定；报告末尾的机评量化 JSON 块
// 则尝试解析出 score/issues，解析结果独立记录在 ScoreStatus，解析失败不影响
// REPORTED 状态判定，也不会调用 failEval——量化环节与报告生成是两个独立维度。
func (s *EvalService) processReport(ce *model.CaseExecution) {
	artifacts, err := s.files.ListArtifacts(ce.EvalTaskID)
	if err != nil || len(artifacts) == 0 {
		s.failEval(ce, "no eval artifact produced")
		return
	}
	// 评测执行器上传的产物为 output.tar.gz，内含 report.md。
	_, file, err := s.files.Open(artifacts[0].ID)
	if err != nil {
		s.failEval(ce, "open eval artifact: "+err.Error())
		return
	}
	defer file.Close()

	raw, err := eval.ExtractReportFromTarGz(file)
	if err != nil {
		s.failEval(ce, "extract report: "+err.Error())
		return
	}
	reportRaw := string(raw)

	// 分数提取必须在 NormalizeReport 截断之前的原始文本上进行：512KB 截断可能恰好
	// 切碎报告末尾的 JSON 代码块，先截断再提取会造成本不存在的假解析失败。
	scoreUpdates := s.extractScoreUpdates(ce, reportRaw)

	report := eval.NormalizeReport(reportRaw)
	if report == "" {
		s.failEval(ce, "empty analysis report")
		return
	}

	now := time.Now()
	updates := map[string]any{
		"status": model.CaseExecReported, "report": report,
		"message": "analysis report generated", "finished_at": &now,
	}
	for k, v := range scoreUpdates {
		updates[k] = v
	}
	s.db.Model(ce).Updates(updates)
}

// extractScoreUpdates 根据本次评测所属 EvalRun 的脚本版本决定是否解析机评分数：
//   - run.ScorePromptVersion < eval.CurrentScorePromptVersion（含历史数据默认值 0）：
//     该次评测脚本本身不要求模型输出 JSON 分数块，判定 NOT_APPLICABLE，不解析、不视为异常。
//   - 否则调用 eval.ExtractScoreAndIssues 解析，结果可能是 OK 或 PARSE_FAILED。
func (s *EvalService) extractScoreUpdates(ce *model.CaseExecution, reportRaw string) map[string]any {
	run, err := s.getRun(ce.EvalRunID)
	if err != nil || run.ScorePromptVersion < eval.CurrentScorePromptVersion {
		return map[string]any{"score_status": model.ScoreNotApplicable}
	}

	result := eval.ExtractScoreAndIssues(reportRaw)
	issuesJSON, _ := json.Marshal(result.Issues)
	return map[string]any{
		"score":           result.Score,
		"score_reason":    result.ScoreReason,
		"issue_tags_json": string(issuesJSON),
		"score_status":    result.Status,
		"score_error":     result.Error,
	}
}

// failEval 将用例执行置为 ERROR（评测流程本身异常，非业务判定失败）。
func (s *EvalService) failEval(ce *model.CaseExecution, msg string) {
	now := time.Now()
	s.db.Model(ce).Updates(map[string]any{
		"status": model.CaseExecError, "message": msg, "finished_at": &now,
	})
}

// aggregate 根据用例执行状态重算 EvalRun 的计数与整体状态。
// 评测产出分析报告由人工审阅，不做通过/失败判定：所有用例达终态即完成，
// 全部生成报告（无 ERROR）则 SUCCEEDED，否则 FAILED（指执行层面异常）。
func (s *EvalService) aggregate(runID string) {
	var ces []model.CaseExecution
	if err := s.db.Where("eval_run_id = ?", runID).Find(&ces).Error; err != nil {
		return
	}
	reported, errored, terminal := 0, 0, 0
	for _, ce := range ces {
		switch ce.Status {
		case model.CaseExecReported:
			reported++
			terminal++
		case model.CaseExecError:
			errored++
			terminal++
		case model.CaseExecStopped:
			terminal++
		}
	}
	updates := map[string]any{"reported": reported, "errored": errored}
	if terminal == len(ces) && len(ces) > 0 {
		now := time.Now()
		updates["finished_at"] = &now
		if errored == 0 {
			updates["status"] = model.EvalRunSucceeded
		} else {
			updates["status"] = model.EvalRunFailed
		}
	}
	_ = s.db.Model(&model.EvalRun{}).Where("id = ? AND status = ?", runID, model.EvalRunRunning).Updates(updates).Error
}

// ---- 机评分数聚合（详情页 score_summary / Leaderboard） ----
//
// 所有聚合查询必须显式过滤 score_status='OK'：NOT_APPLICABLE（历史数据）和
// PARSE_FAILED（解析异常）都不应计入均分分母，否则会用没有意义的样本拉低/污染统计结果。

// ScoreSummary 是一次 EvalRun 的 prompt-first 机评量化汇总，供 GET /eval-runs/:id 附加返回。
type ScoreSummary struct {
	ScoreScale           string         `json:"score_scale"`
	AvgScore             *float64      `json:"avg_score"`
	ScoredCount          int           `json:"scored_count"`
	TotalCount           int           `json:"total_count"`
	AvailabilityRate     *float64      `json:"availability_rate,omitempty"`
	ScoreStatusBreakdown map[string]int `json:"score_status_breakdown"`
	Distribution         map[string]int `json:"distribution"`
	LevelBreakdown       map[string]int `json:"level_breakdown"`
	TopIssues            []IssueCount  `json:"top_issues"`
}

// IssueCount 是动态标签的命中统计（用于 Top 标签面板）。
type IssueCount struct {
	Code   string  `json:"code,omitempty"` // legacy fallback
	Module string  `json:"module,omitempty"`
	Label  string  `json:"label"`
	Kind   string  `json:"kind,omitempty"`
	Level  string  `json:"level,omitempty"`
	Count  int     `json:"count"`
	Ratio  float64 `json:"ratio"`
}

// GetScoreSummary 聚合一个 EvalRun 下所有用例执行的机评分数与问题标签。
func (s *EvalService) GetScoreSummary(runID string) (*ScoreSummary, error) {
	var ces []model.CaseExecution
	if err := s.db.Where("eval_run_id = ?", runID).Find(&ces).Error; err != nil {
		return nil, err
	}
	return summarizeScores(ces), nil
}

// summarizeScores 是纯函数聚合逻辑，与查询解耦，便于单元测试与在 Leaderboard 中复用。
func summarizeScores(ces []model.CaseExecution) *ScoreSummary {
	summary := &ScoreSummary{
		ScoreScale:           "0-4",
		TotalCount:           len(ces),
		ScoreStatusBreakdown: map[string]int{},
		Distribution:         map[string]int{"0": 0, "1": 0, "2": 0, "3": 0, "4": 0},
		LevelBreakdown:       map[string]int{"P0": 0, "P1": 0, "P2": 0, "L1": 0, "L2": 0},
	}
	issueCounts := map[string]IssueCount{}
	var sum float64
	available := 0
	for _, ce := range ces {
		status := string(ce.ScoreStatus)
		if status == "" {
			status = string(model.ScoreNotApplicable)
		}
		summary.ScoreStatusBreakdown[status]++
		if ce.ScoreStatus != model.ScoreOK || ce.Score == nil {
			continue
		}
		summary.ScoredCount++
		sum += *ce.Score
		if *ce.Score >= 3 {
			available++
		}
		summary.Distribution[scoreBucket(*ce.Score)]++
		for _, tag := range ce.IssueTags {
			if tag.Level != "" {
				summary.LevelBreakdown[tag.Level]++
			}
			key := issueCountKey(tag)
			if key == "" {
				continue
			}
			it := issueCounts[key]
			if it.Count == 0 {
				it = issueCountFromTag(tag)
			}
			it.Count++
			issueCounts[key] = it
		}
	}
	if summary.ScoredCount > 0 {
		avg := sum / float64(summary.ScoredCount)
		summary.AvgScore = &avg
		rate := float64(available) / float64(summary.ScoredCount)
		summary.AvailabilityRate = &rate
	}
	summary.TopIssues = topIssues(issueCounts, summary.ScoredCount, 5)
	return summary
}

// scoreBucket 把 prompt-first 0-4 分归到展示用分档。
func scoreBucket(score float64) string {
	if score < 0 {
		return "0"
	}
	if score > 4 {
		return "4"
	}
	return fmt.Sprintf("%.0f", score)
}

func issueCountKey(tag model.IssueTag) string {
	if tag.Label != "" || tag.Module != "" {
		return tag.Module + "\x00" + tag.Label + "\x00" + tag.Kind + "\x00" + tag.Level
	}
	return tag.Code
}

func issueCountFromTag(tag model.IssueTag) IssueCount {
	label := tag.Label
	if label == "" {
		label = eval.IssueLabel(tag.Code)
	}
	if label == "" {
		label = tag.Code
	}
	return IssueCount{Code: tag.Code, Module: tag.Module, Label: label, Kind: tag.Kind, Level: tag.Level}
}

// topIssues 按命中次数降序取前 limit 个动态标签，ratio 相对 scoredCount 计算
// （分母是参与计分的用例数，不是命中总数，语义为“在多少比例的用例中出现过该标签”）。
func topIssues(counts map[string]IssueCount, scoredCount int, limit int) []IssueCount {
	items := make([]IssueCount, 0, len(counts))
	for _, it := range counts {
		if scoredCount > 0 {
			it.Ratio = float64(it.Count) / float64(scoredCount)
		}
		items = append(items, it)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Count != items[j].Count {
			return items[i].Count > items[j].Count
		}
		return items[i].Module+items[i].Label+items[i].Level < items[j].Module+items[j].Label+items[j].Level
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}

// LeaderboardItem 是排行榜单个被测模型（TargetEndpoint）的聚合结果。
type LeaderboardItem struct {
	EndpointID       string       `json:"endpoint_id"`
	EndpointName     string       `json:"endpoint_name"`
	AvgScore         float64      `json:"avg_score"`
	RunCount         int          `json:"run_count"`
	CaseCount        int          `json:"case_count"`
	ScoredCaseCount  int          `json:"scored_case_count"`
	TopIssues        []IssueCount `json:"top_issues"`
	ScoreTrend       []float64    `json:"score_trend"`
}

// GetLeaderboard 按被测模型端点聚合近 sinceDays 天内（0 表示不限时间）已完成的
// EvalRun，仅统计 score_status='OK' 的用例执行，得出各模型的均分/问题标签/趋势。
// 环比（与前一统计周期对比）留给前端按需请求两个 period 自行计算，避免这里
// 引入“上一周期”的隐含时间窗定义分歧。
func (s *EvalService) GetLeaderboard(sinceDays int) ([]LeaderboardItem, error) {
	q := s.db.Model(&model.EvalRun{}).Where("status IN ? AND score_prompt_version >= ?", []model.EvalRunStatus{model.EvalRunSucceeded, model.EvalRunFailed}, eval.CurrentScorePromptVersion)
	if sinceDays > 0 {
		q = q.Where("created_at >= ?", time.Now().AddDate(0, 0, -sinceDays))
	}
	var runs []model.EvalRun
	if err := q.Find(&runs).Error; err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return nil, nil
	}

	runIDs := make([]string, 0, len(runs))
	endpointOfRun := make(map[string]string, len(runs))
	for _, r := range runs {
		runIDs = append(runIDs, r.ID)
		endpointOfRun[r.ID] = r.EndpointID
	}

	var ces []model.CaseExecution
	if err := s.db.Where("eval_run_id IN ?", runIDs).Find(&ces).Error; err != nil {
		return nil, err
	}

	// 按端点分桶：用例执行 + 该端点参与的 run 数（用于 run_count），
	// score_trend 按 run 创建时间升序取各 run 的均分序列（可为空，前端据此绘制稀疏点）。
	type bucket struct {
		ces  []model.CaseExecution
		runs []model.EvalRun
	}
	buckets := map[string]*bucket{}
	for _, ce := range ces {
		epID := endpointOfRun[ce.EvalRunID]
		if epID == "" {
			continue
		}
		b, ok := buckets[epID]
		if !ok {
			b = &bucket{}
			buckets[epID] = b
		}
		b.ces = append(b.ces, ce)
	}
	runSeen := map[string]map[string]bool{} // epID -> runID -> seen，用于 run_count 去重
	for _, r := range runs {
		epID := r.EndpointID
		if epID == "" {
			continue
		}
		if runSeen[epID] == nil {
			runSeen[epID] = map[string]bool{}
		}
		runSeen[epID][r.ID] = true
		if b, ok := buckets[epID]; ok {
			b.runs = append(b.runs, r)
		}
	}

	endpointIDs := make([]string, 0, len(buckets))
	for id := range buckets {
		endpointIDs = append(endpointIDs, id)
	}
	var endpoints []model.TargetEndpoint
	if len(endpointIDs) > 0 {
		if err := s.db.Where("id IN ?", endpointIDs).Find(&endpoints).Error; err != nil {
			return nil, err
		}
	}
	nameOf := make(map[string]string, len(endpoints))
	for _, ep := range endpoints {
		nameOf[ep.ID] = ep.Name
	}

	items := make([]LeaderboardItem, 0, len(buckets))
	for epID, b := range buckets {
		summary := summarizeScores(b.ces)
		if summary.ScoredCount == 0 {
			continue // 该端点在统计周期内没有任何合法分数，不参与排名
		}
		sort.Slice(b.runs, func(i, j int) bool { return b.runs[i].CreatedAt.Before(b.runs[j].CreatedAt) })
		trend := make([]float64, 0, len(b.runs))
		for _, r := range b.runs {
			runCes := make([]model.CaseExecution, 0)
			for _, ce := range b.ces {
				if ce.EvalRunID == r.ID {
					runCes = append(runCes, ce)
				}
			}
			runSummary := summarizeScores(runCes)
			if runSummary.AvgScore != nil {
				trend = append(trend, *runSummary.AvgScore)
			}
		}
		name := nameOf[epID]
		if name == "" {
			name = epID
		}
		items = append(items, LeaderboardItem{
			EndpointID:      epID,
			EndpointName:    name,
			AvgScore:        *summary.AvgScore,
			RunCount:        len(runSeen[epID]),
			CaseCount:       len(b.ces),
			ScoredCaseCount: summary.ScoredCount,
			TopIssues:       summary.TopIssues,
			ScoreTrend:      trend,
		})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].AvgScore > items[j].AvgScore })
	return items, nil
}

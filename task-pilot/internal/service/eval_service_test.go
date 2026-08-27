package service

import (
	"strings"
	"testing"

	"task-pilot/internal/config"
	"task-pilot/internal/filetransfer"
	"task-pilot/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestBuildTestCommand(t *testing.T) {
	cmd := buildTestCommand("生成一个登录报告", "", "")

	// 必须先切换模型端点，再执行任务描述。
	if !strings.Contains(cmd, "lumi-model-setup switch claude") {
		t.Error("missing model switch command")
	}
	// 端点参数必须通过环境变量引用，绝不出现明文 api_key 字面量。
	for _, want := range []string{`--base-url "$TARGET_BASE_URL"`, `--api-key "$TARGET_API_KEY"`, `--model "$TARGET_MODEL_NAME"`} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command missing %q", want)
		}
	}
	if !strings.Contains(cmd, "claude -p --dangerously-skip-permissions '生成一个登录报告'") {
		t.Errorf("prompt not embedded correctly: %s", cmd)
	}
	// switch 必须在 claude -p 之前。
	if strings.Index(cmd, "switch claude") > strings.Index(cmd, "claude -p") {
		t.Error("switch must come before claude -p")
	}
	// 必须把工作区根目录下的产出归集进 output/，且排除受管目录，否则产物只剩 trace.jsonl。
	if !strings.Contains(cmd, `"$WORKSPACE/output/"`) {
		t.Error("must collect workspace-root outputs into output/")
	}
	// 必须在 agent 失败时仍打印 trace，并在归集 output 后按原退出码失败。
	for _, want := range []string{"set +e", "task_pilot_agent_rc=$?", "cat output/trace.jsonl || true", `exit "$task_pilot_agent_rc"`} {
		if !strings.Contains(cmd, want) {
			t.Errorf("command should preserve and print failed trace: missing %q", want)
		}
	}
}

func TestBuildTestCommandInjectionSafe(t *testing.T) {
	// 描述含单引号/分号，必须被安全转义，不能逃逸出单引号上下文。
	cmd := buildTestCommand("a'; rm -rf / #", "", "")
	if !strings.Contains(cmd, `'"'"'`) {
		t.Errorf("single quote not escaped: %s", cmd)
	}
}

func TestBuildAgentSetupScript(t *testing.T) {
	if got := buildAgentSetupScript(nil, nil); got != "" {
		t.Errorf("no bindings should produce empty script, got %q", got)
	}

	mcps := []model.MCPConfig{{Name: "search", ConfigJSON: `{"command":"npx","args":["-y","@some/mcp"]}`}}
	skills := []model.SkillConfig{{
		Name:           "report-writer",
		ContentMD:      "# Report Writer\n\ndo the thing",
		ExtraFilesJSON: model.EncodeExtraFiles(map[string]string{"references/style.md": "use formal tone"}),
	}}
	script := buildAgentSetupScript(mcps, skills)

	if !strings.Contains(script, `$WORKSPACE/.mcp.json`) {
		t.Error("must write .mcp.json under $WORKSPACE")
	}
	if !strings.Contains(script, `"command":"npx"`) {
		t.Error("mcp config content must be embedded")
	}
	if !strings.Contains(script, `$HOME/.claude/skills/report-writer`) {
		t.Error("must create skill directory under $HOME/.claude/skills")
	}
	if !strings.Contains(script, "# Report Writer") {
		t.Error("SKILL.md content must be embedded")
	}
	if !strings.Contains(script, "use formal tone") {
		t.Error("extra skill file content must be embedded")
	}
	if !strings.Contains(script, "references/style.md") {
		t.Error("extra skill file relative path must be preserved")
	}
}

func TestBuildAgentSetupScriptPathTraversalSafe(t *testing.T) {
	skills := []model.SkillConfig{{
		Name:           "evil",
		ContentMD:      "# Evil",
		ExtraFilesJSON: model.EncodeExtraFiles(map[string]string{"../../etc/passwd": "pwned"}),
	}}
	script := buildAgentSetupScript(nil, skills)
	if strings.Contains(script, "../") {
		t.Errorf("extra file path must not escape skill directory: %s", script)
	}
}

func TestResolveInputFiles(t *testing.T) {
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.FileObject{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	// 一条有真实文件名的文件对象；另一条 ID 在库中不存在（走回退）。
	db.Create(&model.FileObject{ID: "file-real", Filename: "sales_h1_2025.csv"})
	files := filetransfer.NewService(db, config.FileTransferConfig{})
	svc := &EvalService{db: db, files: files}

	if svc.resolveInputFiles(nil) != nil {
		t.Error("empty should map to nil")
	}
	specs := svc.resolveInputFiles([]string{"file-real", "file-missing", ""})
	if len(specs) != 2 {
		t.Fatalf("expected 2 specs (empty id skipped), got %d: %+v", len(specs), specs)
	}
	// 已知文件必须使用真实文件名，而非 fileID。
	if specs[0].FileID != "file-real" || specs[0].Filename != "sales_h1_2025.csv" {
		t.Errorf("known file should resolve real name, got %+v", specs[0])
	}
	// 未知文件回退用 fileID 作为文件名，保底可下载。
	if specs[1].FileID != "file-missing" || specs[1].Filename != "file-missing" {
		t.Errorf("unknown file should fall back to fileID, got %+v", specs[1])
	}
}

// TestResolveCheckpointInputs 校验点参考文件必须加上 ckpt_<序号>__ 前缀（序号从 1 开始，
// 与 eval_input.json 里 checkpoints[] 的下标顺序一致），且无绑定文件的校验点不产生任何 spec。
func TestResolveCheckpointInputs(t *testing.T) {
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.FileObject{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.Create(&model.FileObject{ID: "file-gold", Filename: "gold_answer.md"})
	files := filetransfer.NewService(db, config.FileTransferConfig{})
	svc := &EvalService{db: db, files: files}

	checkpoints := []model.EvalRunSnapshotCheckpoint{
		{Description: "无参考文件"},
		{Description: "有参考文件", FileIDs: []string{"file-gold", ""}},
	}
	evalCheckpoints, specs := svc.resolveCheckpointInputs(checkpoints)
	if len(evalCheckpoints) != 2 {
		t.Fatalf("expected 2 eval checkpoints, got %d", len(evalCheckpoints))
	}
	if len(evalCheckpoints[0].Files) != 0 {
		t.Errorf("checkpoint without files should have empty Files, got %+v", evalCheckpoints[0])
	}
	if len(evalCheckpoints[1].Files) != 1 || evalCheckpoints[1].Files[0] != "ckpt_2__gold_answer.md" {
		t.Errorf("checkpoint file name not prefixed correctly: %+v", evalCheckpoints[1])
	}
	if len(specs) != 1 || specs[0].FileID != "file-gold" || specs[0].Filename != "ckpt_2__gold_answer.md" {
		t.Errorf("input file specs wrong: %+v", specs)
	}
}

func TestBuildSnapshot(t *testing.T) {
	cs := &model.CaseSet{
		ID: "cs-1", Name: "集", Version: 3,
		Cases: []model.Case{
			{
				ID: "case-1", Name: "用例1", Description: "描述", OrderNo: 0,
				FileIDs:             []string{"f1"},
				SkipHTMLVisualScore: true,
				Checkpoints: []model.Checkpoint{
					{Description: "校验A"}, {Description: "校验B", FileIDs: []string{"file-gold"}},
				},
			},
		},
	}
	snap := buildSnapshot(cs)
	if snap.Version != 3 || len(snap.Cases) != 1 {
		t.Fatalf("snapshot header wrong: %+v", snap)
	}
	if len(snap.Cases[0].Checkpoints) != 2 || snap.Cases[0].Checkpoints[0].Description != "校验A" {
		t.Errorf("checkpoints not captured: %+v", snap.Cases[0].Checkpoints)
	}
	if got := snap.Cases[0].Checkpoints[1].FileIDs; len(got) != 1 || got[0] != "file-gold" {
		t.Errorf("checkpoint file_ids not captured: %+v", snap.Cases[0].Checkpoints[1])
	}
	if !snap.Cases[0].SkipHTMLVisualScore {
		t.Error("skip_html_visual_score not captured in snapshot")
	}

	// 快照可 JSON 往返。
	raw := model.EncodeSnapshot(snap)
	back := model.DecodeSnapshot(raw)
	if back.CaseSetName != "集" || len(back.Cases) != 1 {
		t.Errorf("snapshot round trip failed: %+v", back)
	}
	if !back.Cases[0].SkipHTMLVisualScore {
		t.Error("skip_html_visual_score not round-tripped through JSON snapshot")
	}
}

package service

import (
	"testing"

	"task-pilot/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open in-memory sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.CaseSet{}, &model.Case{}, &model.Checkpoint{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// ckps 是测试辅助函数：把纯文本描述批量转换为 CheckpointInput（无参考文件）。
func ckps(descriptions ...string) []CheckpointInput {
	out := make([]CheckpointInput, 0, len(descriptions))
	for _, d := range descriptions {
		out = append(out, CheckpointInput{Description: d})
	}
	return out
}

func sampleInput() CaseSetInput {
	return CaseSetInput{
		Name:        "登录回归集",
		Description: "覆盖登录",
		Cases: []CaseInput{
			{
				Name:        "正常登录",
				Description: "执行登录并输出报告",
				FileIDs:     []string{"file-a", "file-b"},
				Checkpoints: ckps("输出包含登录成功", "不得泄露明文密码"),
			},
		},
	}
}

func TestCaseSetCreateAndGet(t *testing.T) {
	svc := NewCaseSetService(newTestDB(t))
	cs, err := svc.Create(sampleInput())
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if cs.Version != 1 {
		t.Errorf("version = %d, want 1", cs.Version)
	}
	if len(cs.Cases) != 1 {
		t.Fatalf("cases = %d, want 1", len(cs.Cases))
	}
	if len(cs.Cases[0].Checkpoints) != 2 {
		t.Errorf("checkpoints = %d, want 2", len(cs.Cases[0].Checkpoints))
	}
	if got := cs.Cases[0].FileIDs; len(got) != 2 || got[0] != "file-a" {
		t.Errorf("file_ids not round-tripped: %v", got)
	}
	// 默认（未设置）必须是 false：HTML 产物默认转图片走美观度评测，行为不受此开关新增影响。
	if cs.Cases[0].SkipHTMLVisualScore {
		t.Error("skip_html_visual_score should default to false")
	}
}

// TestCaseSetSkipHTMLVisualScoreRoundTrip skip_html_visual_score 需随 Create/Get 完整往返。
func TestCaseSetSkipHTMLVisualScoreRoundTrip(t *testing.T) {
	svc := NewCaseSetService(newTestDB(t))
	in := sampleInput()
	in.Cases[0].SkipHTMLVisualScore = true
	cs, err := svc.Create(in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !cs.Cases[0].SkipHTMLVisualScore {
		t.Error("skip_html_visual_score not round-tripped on create")
	}

	reloaded, err := svc.Get(cs.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if !reloaded.Cases[0].SkipHTMLVisualScore {
		t.Error("skip_html_visual_score not round-tripped after reload")
	}
}

// TestCaseSetCheckpointFileIDsRoundTrip 校验点绑定的参考文件 ID 需随 Create/Get 完整往返。
func TestCaseSetCheckpointFileIDsRoundTrip(t *testing.T) {
	svc := NewCaseSetService(newTestDB(t))
	in := sampleInput()
	in.Cases[0].Checkpoints = []CheckpointInput{
		{Description: "输出与标准答案一致", FileIDs: []string{"file-gold"}},
		{Description: "无参考文件的校验点"},
	}
	cs, err := svc.Create(in)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if got := cs.Cases[0].Checkpoints[0].FileIDs; len(got) != 1 || got[0] != "file-gold" {
		t.Errorf("checkpoint[0].file_ids not round-tripped: %v", got)
	}
	if got := cs.Cases[0].Checkpoints[1].FileIDs; len(got) != 0 {
		t.Errorf("checkpoint[1].file_ids should be empty, got: %v", got)
	}

	reloaded, err := svc.Get(cs.ID)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got := reloaded.Cases[0].Checkpoints[0].FileIDs; len(got) != 1 || got[0] != "file-gold" {
		t.Errorf("checkpoint[0].file_ids not round-tripped after reload: %v", got)
	}
}

func TestCaseSetValidation(t *testing.T) {
	svc := NewCaseSetService(newTestDB(t))

	if _, err := svc.Create(CaseSetInput{Name: "", Cases: []CaseInput{{Name: "c", Description: "d", Checkpoints: ckps("x")}}}); err == nil {
		t.Error("empty name should fail")
	}
	if _, err := svc.Create(CaseSetInput{Name: "x", Cases: nil}); err == nil {
		t.Error("no cases should fail")
	}
	if _, err := svc.Create(CaseSetInput{Name: "x", Cases: []CaseInput{{Name: "c", Description: "d", Checkpoints: nil}}}); err == nil {
		t.Error("case without checkpoints should fail")
	}
	if _, err := svc.Create(CaseSetInput{Name: "x", Cases: []CaseInput{{Name: "c", Description: "d", Checkpoints: []CheckpointInput{{Description: ""}}}}}); err == nil {
		t.Error("checkpoint without description should fail")
	}
}

func TestCaseSetUpdateReplacesAndBumpsVersion(t *testing.T) {
	svc := NewCaseSetService(newTestDB(t))
	cs, _ := svc.Create(sampleInput())

	in := sampleInput()
	in.Name = "改名后"
	in.Cases = []CaseInput{{Name: "唯一用例", Description: "d", Checkpoints: ckps("only")}}
	updated, err := svc.Update(cs.ID, in)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Version != 2 {
		t.Errorf("version = %d, want 2", updated.Version)
	}
	if updated.Name != "改名后" {
		t.Errorf("name not updated: %q", updated.Name)
	}
	if len(updated.Cases) != 1 || updated.Cases[0].Name != "唯一用例" {
		t.Errorf("cases not replaced: %+v", updated.Cases)
	}
	if len(updated.Cases[0].Checkpoints) != 1 {
		t.Errorf("checkpoints not replaced: %d", len(updated.Cases[0].Checkpoints))
	}
}

func TestCaseSetListIncludesCaseCount(t *testing.T) {
	svc := NewCaseSetService(newTestDB(t))
	if _, err := svc.Create(sampleInput()); err != nil {
		t.Fatalf("create: %v", err)
	}
	sets, err := svc.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(sets) != 1 {
		t.Fatalf("sets = %d, want 1", len(sets))
	}
	if len(sets[0].Cases) != 1 {
		t.Errorf("cases = %d, want 1 (list must preload cases for count display)", len(sets[0].Cases))
	}
}

func TestCaseSetDelete(t *testing.T) {
	svc := NewCaseSetService(newTestDB(t))
	cs, _ := svc.Create(sampleInput())
	if err := svc.Delete(cs.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := svc.Get(cs.ID); err == nil {
		t.Error("get after delete should fail")
	}
}

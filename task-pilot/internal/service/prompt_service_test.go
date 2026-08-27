package service

import (
	"testing"

	"task-pilot/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newPromptService(t *testing.T) *PromptService {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.EvalPrompt{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return NewPromptService(db)
}

func TestPromptCreateAndGet(t *testing.T) {
	svc := newPromptService(t)
	p, err := svc.Create(UpsertPromptInput{Name: "p1", Content: "判定内容", IsDefault: true})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := svc.Get(p.ID)
	if err != nil || got.Content != "判定内容" {
		t.Errorf("get mismatch: %+v err=%v", got, err)
	}
}

func TestPromptRequiresFields(t *testing.T) {
	svc := newPromptService(t)
	if _, err := svc.Create(UpsertPromptInput{Name: "", Content: "x"}); err == nil {
		t.Error("missing name should fail")
	}
	if _, err := svc.Create(UpsertPromptInput{Name: "x", Content: ""}); err == nil {
		t.Error("missing content should fail")
	}
}

func TestPromptDefaultUniqueness(t *testing.T) {
	svc := newPromptService(t)
	a, _ := svc.Create(UpsertPromptInput{Name: "a", Content: "c", IsDefault: true})
	b, _ := svc.Create(UpsertPromptInput{Name: "b", Content: "c", IsDefault: true})

	def, err := svc.Default()
	if err != nil || def.ID != b.ID {
		t.Errorf("default should be latest (b), got %+v err=%v", def, err)
	}
	reloadA, _ := svc.Get(a.ID)
	if reloadA.IsDefault {
		t.Error("first prompt should no longer be default")
	}
}

func TestPromptUpdateKeepsContentWhenEmpty(t *testing.T) {
	svc := newPromptService(t)
	p, _ := svc.Create(UpsertPromptInput{Name: "a", Content: "orig"})
	updated, err := svc.Update(p.ID, UpsertPromptInput{Name: "a2", Content: ""})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.Content != "orig" {
		t.Error("empty content on update must keep existing content")
	}
	if updated.Name != "a2" {
		t.Errorf("name not updated: %q", updated.Name)
	}
}

func TestPromptSeedDefault(t *testing.T) {
	svc := newPromptService(t)
	if err := svc.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	def, err := svc.Default()
	if err != nil || def.Name != "default" {
		t.Errorf("seed should create a default prompt, got %+v err=%v", def, err)
	}
	// 再次 seed 不应重复创建。
	if err := svc.SeedDefault(); err != nil {
		t.Fatalf("second seed: %v", err)
	}
	list, _ := svc.List()
	if len(list) != 1 {
		t.Errorf("seed should be idempotent, got %d prompts", len(list))
	}
}

func TestPromptDelete(t *testing.T) {
	svc := newPromptService(t)
	p, _ := svc.Create(UpsertPromptInput{Name: "a", Content: "c"})
	if err := svc.Delete(p.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := svc.Get(p.ID); err == nil {
		t.Error("get after delete should fail")
	}
}

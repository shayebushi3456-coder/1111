package service

import (
	"testing"

	"task-pilot/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newEvalDB(t *testing.T) *gorm.DB {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.EvalRun{}, &model.CaseExecution{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// TestAggregateAllReported 验证：全部用例生成报告 → EvalRun SUCCEEDED。
func TestAggregateAllReported(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db}
	run := &model.EvalRun{ID: "er-1", Status: model.EvalRunRunning, Total: 2}
	db.Create(run)
	db.Create(&model.CaseExecution{ID: "ce-1", EvalRunID: "er-1", Status: model.CaseExecReported})
	db.Create(&model.CaseExecution{ID: "ce-2", EvalRunID: "er-1", Status: model.CaseExecReported})

	svc.aggregate("er-1")

	var got model.EvalRun
	db.First(&got, "id = ?", "er-1")
	if got.Status != model.EvalRunSucceeded {
		t.Errorf("status = %s, want SUCCEEDED", got.Status)
	}
	if got.Reported != 2 || got.Errored != 0 {
		t.Errorf("counts wrong: reported=%d errored=%d", got.Reported, got.Errored)
	}
}

// TestAggregateWithError 验证：存在 ERROR → EvalRun FAILED（执行层面异常）。
func TestAggregateWithError(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db}
	run := &model.EvalRun{ID: "er-2", Status: model.EvalRunRunning, Total: 2}
	db.Create(run)
	db.Create(&model.CaseExecution{ID: "ce-3", EvalRunID: "er-2", Status: model.CaseExecReported})
	db.Create(&model.CaseExecution{ID: "ce-4", EvalRunID: "er-2", Status: model.CaseExecError})

	svc.aggregate("er-2")

	var got model.EvalRun
	db.First(&got, "id = ?", "er-2")
	if got.Status != model.EvalRunFailed {
		t.Errorf("status = %s, want FAILED", got.Status)
	}
	if got.Reported != 1 || got.Errored != 1 {
		t.Errorf("counts wrong: reported=%d errored=%d", got.Reported, got.Errored)
	}
}

// TestAggregateStillRunning 验证：有未终态用例时不改变 RUNNING。
func TestAggregateStillRunning(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db}
	run := &model.EvalRun{ID: "er-3", Status: model.EvalRunRunning, Total: 2}
	db.Create(run)
	db.Create(&model.CaseExecution{ID: "ce-5", EvalRunID: "er-3", Status: model.CaseExecReported})
	db.Create(&model.CaseExecution{ID: "ce-6", EvalRunID: "er-3", Status: model.CaseExecEvalRunning})

	svc.aggregate("er-3")

	var got model.EvalRun
	db.First(&got, "id = ?", "er-3")
	if got.Status != model.EvalRunRunning {
		t.Errorf("status = %s, want RUNNING (not terminal yet)", got.Status)
	}
	if got.Reported != 1 {
		t.Errorf("reported = %d, want 1", got.Reported)
	}
}

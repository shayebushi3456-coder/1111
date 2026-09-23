package service

import (
	"context"
	"testing"

	"task-pilot/internal/model"
)

func TestRefreshSnapshotCase(t *testing.T) {
	snap := model.EvalRunSnapshot{
		CaseSetID: "cs-1",
		Cases: []model.EvalRunSnapshotCase{{
			CaseID:      "case-1",
			Name:        "old",
			Description: "old desc",
			Checkpoints: []model.EvalRunSnapshotCheckpoint{{Description: "old cp"}},
		}},
	}
	live := model.Case{
		ID:          "case-1",
		Name:        "new",
		Description: "new desc",
		FileIDs:     []string{"f1"},
		Checkpoints: []model.Checkpoint{{Description: "new cp", FileIDs: []string{"ref"}}},
	}
	got, ok := refreshSnapshotCase(snap, live)
	if !ok {
		t.Fatal("expected refresh ok")
	}
	if got.Cases[0].Description != "new desc" || got.Cases[0].Checkpoints[0].Description != "new cp" {
		t.Fatalf("snapshot not refreshed: %+v", got.Cases[0])
	}
	if _, ok := refreshSnapshotCase(snap, model.Case{ID: "missing"}); ok {
		t.Fatal("missing case should not refresh")
	}
}

func TestReEvalCaseExecutionQueuesWithoutRerunningTest(t *testing.T) {
	db := newEvalDB(t)
	if err := db.AutoMigrate(&model.Task{}, &model.CaseSet{}, &model.Case{}, &model.Checkpoint{}, &model.EvalPrompt{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	const (
		projectID = "proj-1"
		runID     = "er-1"
		ceID      = "ce-1"
		caseID    = "case-1"
		taskID    = "task-test-1"
	)
	score := 3.0
	db.Create(&model.EvalRun{
		ID:             runID,
		ProjectID:      projectID,
		CaseSetID:      "cs-1",
		PromptID:       "prompt-1",
		PromptSnapshot: "old prompt",
		SnapshotJSON: model.EncodeSnapshot(model.EvalRunSnapshot{
			CaseSetID: "cs-1", Version: 1,
			Cases: []model.EvalRunSnapshotCase{{CaseID: caseID, Name: "old", Description: "old desc", Checkpoints: []model.EvalRunSnapshotCheckpoint{{Description: "old cp"}}}},
		}),
		Status:   model.EvalRunSucceeded,
		Total:    1,
		Reported: 1,
	})
	db.Create(&model.CaseExecution{
		ID: ceID, EvalRunID: runID, CaseID: caseID, CaseName: "old",
		TestTaskID: taskID, EvalTaskID: "task-eval-old", Status: model.CaseExecReported,
		Report: "old report", Score: &score, ScoreStatus: model.ScoreOK, EvalAttempts: 2,
	})
	db.Create(&model.Task{ID: taskID, ProjectID: projectID, Status: model.TaskStatusSucceeded})
	db.Create(&model.CaseSet{ID: "cs-1", ProjectID: projectID, Name: "cs", Version: 2})
	db.Create(&model.Case{
		ID: caseID, CaseSetID: "cs-1", Name: "new name", Description: "new desc",
		FileIDsJSON: model.EncodeFileIDs(nil),
	})
	db.Create(&model.Checkpoint{ID: "cp-1", CaseID: caseID, Description: "new cp", OrderNo: 1})
	db.Create(&model.EvalPrompt{ID: "prompt-1", ProjectID: projectID, Name: "p", Content: "fresh judge prompt", IsDefault: true})

	svc := &EvalService{
		db:      db,
		tasks:   &TaskService{db: db},
		caseSet: NewCaseSetService(db),
		prompts: NewPromptService(db),
	}
	run, err := svc.ReEvalCaseExecution(context.Background(), projectID, runID, ceID)
	if err != nil {
		t.Fatalf("ReEvalCaseExecution: %v", err)
	}
	if run.Status != model.EvalRunRunning {
		t.Fatalf("run status = %s, want RUNNING", run.Status)
	}
	if run.PromptSnapshot != "fresh judge prompt" {
		t.Fatalf("prompt not refreshed: %q", run.PromptSnapshot)
	}
	snap := model.DecodeSnapshot(run.SnapshotJSON)
	if snap.Cases[0].Description != "new desc" || snap.Cases[0].Checkpoints[0].Description != "new cp" {
		t.Fatalf("case snapshot not refreshed: %+v", snap.Cases[0])
	}
	ce := run.CaseExecutions[0]
	if ce.Status != model.CaseExecTestDone {
		t.Fatalf("ce status = %s, want TEST_DONE", ce.Status)
	}
	if ce.TestTaskID != taskID {
		t.Fatalf("test task must be preserved, got %q", ce.TestTaskID)
	}
	if ce.EvalTaskID != "" || ce.Report != "" || ce.Score != nil || ce.EvalAttempts != 0 {
		t.Fatalf("eval fields not cleared: %+v", ce)
	}
}

func TestReEvalRejectsWithoutSucceededTest(t *testing.T) {
	db := newEvalDB(t)
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.Create(&model.EvalRun{ID: "er", ProjectID: "p", Status: model.EvalRunSucceeded, Total: 1})
	db.Create(&model.CaseExecution{ID: "ce", EvalRunID: "er", CaseID: "c", TestTaskID: "t", Status: model.CaseExecReported})
	db.Create(&model.Task{ID: "t", Status: model.TaskStatusFailed})
	svc := &EvalService{db: db, tasks: &TaskService{db: db}}
	if _, err := svc.ReEvalCaseExecution(context.Background(), "p", "er", "ce"); err == nil {
		t.Fatal("expected error when test task not succeeded")
	}
}

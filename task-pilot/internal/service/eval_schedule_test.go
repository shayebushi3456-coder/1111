package service

import (
	"testing"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
)

// TestRunningCountCountsBothStages 验证：并发计数覆盖测试与评测两个运行阶段。
func TestRunningCountCountsBothStages(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db, cfg: &config.Config{}}

	db.Create(&model.CaseExecution{ID: "ce-1", EvalRunID: "er", Status: model.CaseExecTestRunning})
	db.Create(&model.CaseExecution{ID: "ce-2", EvalRunID: "er", Status: model.CaseExecEvalRunning})
	db.Create(&model.CaseExecution{ID: "ce-3", EvalRunID: "er", Status: model.CaseExecPending})   // 排队，不计
	db.Create(&model.CaseExecution{ID: "ce-4", EvalRunID: "er", Status: model.CaseExecTestDone})  // 待评测，不计
	db.Create(&model.CaseExecution{ID: "ce-5", EvalRunID: "er", Status: model.CaseExecReported})  // 终态，不计

	n, err := svc.runningCount()
	if err != nil {
		t.Fatalf("runningCount: %v", err)
	}
	if n != 2 {
		t.Errorf("runningCount = %d, want 2 (仅 TEST_RUNNING + EVAL_RUNNING)", n)
	}
}

// TestScheduleUnlimitedWhenMaxLEZero 验证：max<=0 时不限流，ScheduleOnce 不因额度提前返回。
// 这里用 max=0 且无被测端点，dispatchTestTask 会因端点缺失失败——但 ScheduleOnce 本身应正常返回 nil。
func TestScheduleNoPendingReturnsNil(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db, cfg: &config.Config{Scheduler: config.SchedulerConfig{MaxConcurrentTasks: 5}}}

	// 无任何 PENDING/TEST_DONE 用例时，调度应无操作且不报错。
	if err := svc.ScheduleOnce(nil); err != nil {
		t.Errorf("ScheduleOnce with empty queue: %v", err)
	}
}

// TestScheduleRespectsCapNoAvailable 验证：running 已达上限时，不再尝试派发（available<=0 提前返回）。
func TestScheduleRespectsCapNoAvailable(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db, cfg: &config.Config{Scheduler: config.SchedulerConfig{MaxConcurrentTasks: 2}}}

	// 2 个运行中已占满 max=2；另有 PENDING 在排队。
	db.Create(&model.CaseExecution{ID: "r1", EvalRunID: "er", Status: model.CaseExecTestRunning})
	db.Create(&model.CaseExecution{ID: "r2", EvalRunID: "er", Status: model.CaseExecEvalRunning})
	db.Create(&model.CaseExecution{ID: "p1", EvalRunID: "er", Status: model.CaseExecPending})

	if err := svc.ScheduleOnce(nil); err != nil {
		t.Fatalf("ScheduleOnce: %v", err)
	}
	// 额度已满，PENDING 用例不应被改动（仍为 PENDING，未变 TEST_RUNNING）。
	var p model.CaseExecution
	db.First(&p, "id = ?", "p1")
	if p.Status != model.CaseExecPending {
		t.Errorf("p1 status = %s, want PENDING (cap reached, must not dispatch)", p.Status)
	}
}

// TestRunningCountPerRun 验证：按 run 分组的运行中计数正确。
func TestRunningCountPerRun(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db, cfg: &config.Config{}}

	db.Create(&model.CaseExecution{ID: "a1", EvalRunID: "erA", Status: model.CaseExecTestRunning})
	db.Create(&model.CaseExecution{ID: "a2", EvalRunID: "erA", Status: model.CaseExecEvalRunning})
	db.Create(&model.CaseExecution{ID: "b1", EvalRunID: "erB", Status: model.CaseExecTestRunning})
	db.Create(&model.CaseExecution{ID: "b2", EvalRunID: "erB", Status: model.CaseExecPending})    // 不计
	db.Create(&model.CaseExecution{ID: "a3", EvalRunID: "erA", Status: model.CaseExecReported})   // 不计

	m, err := svc.runningCountPerRun()
	if err != nil {
		t.Fatalf("runningCountPerRun: %v", err)
	}
	if m["erA"] != 2 || m["erB"] != 1 {
		t.Errorf("per-run counts wrong: %+v (want erA=2 erB=1)", m)
	}
}

// TestSchedulePerRunCapBlocks 验证：单请求并发上限已满时，该 run 的 PENDING 用例不被派发，
// 且额度让给其他 run（此处仅验证被限 run 不动，避免依赖 K8s 派发副作用）。
func TestSchedulePerRunCapBlocks(t *testing.T) {
	db := newEvalDB(t)
	// 全局不限流（max=0），只考察 per-run 上限。
	svc := &EvalService{db: db, cfg: &config.Config{Scheduler: config.SchedulerConfig{MaxConcurrentTasks: 0}}}

	// run 的单请求上限为 1，且已有 1 个运行中 → 其 PENDING 不应被派发。
	db.Create(&model.EvalRun{ID: "er", Status: model.EvalRunRunning, MaxConcurrent: 1})
	db.Create(&model.CaseExecution{ID: "run1", EvalRunID: "er", Status: model.CaseExecTestRunning})
	db.Create(&model.CaseExecution{ID: "pend1", EvalRunID: "er", Status: model.CaseExecPending})

	if err := svc.ScheduleOnce(nil); err != nil {
		t.Fatalf("ScheduleOnce: %v", err)
	}
	var p model.CaseExecution
	db.First(&p, "id = ?", "pend1")
	if p.Status != model.CaseExecPending {
		t.Errorf("pend1 status = %s, want PENDING (per-run cap reached, must not dispatch)", p.Status)
	}
}

// TestListRunningCaseExecutions 验证：仅返回 TEST_RUNNING / EVAL_RUNNING 的用例，跨所有 run。
func TestListRunningCaseExecutions(t *testing.T) {
	db := newEvalDB(t)
	svc := &EvalService{db: db, cfg: &config.Config{}}

	db.Create(&model.CaseExecution{ID: "r1", EvalRunID: "erA", Status: model.CaseExecTestRunning})
	db.Create(&model.CaseExecution{ID: "r2", EvalRunID: "erB", Status: model.CaseExecEvalRunning})
	db.Create(&model.CaseExecution{ID: "q1", EvalRunID: "erA", Status: model.CaseExecPending})   // 排队，不返回
	db.Create(&model.CaseExecution{ID: "d1", EvalRunID: "erB", Status: model.CaseExecTestDone})  // 待评测，不返回
	db.Create(&model.CaseExecution{ID: "t1", EvalRunID: "erA", Status: model.CaseExecReported})  // 终态，不返回

	ces, err := svc.ListRunningCaseExecutions()
	if err != nil {
		t.Fatalf("ListRunningCaseExecutions: %v", err)
	}
	if len(ces) != 2 {
		t.Fatalf("running = %d, want 2 (仅 TEST_RUNNING + EVAL_RUNNING)", len(ces))
	}
	for _, ce := range ces {
		if ce.Status != model.CaseExecTestRunning && ce.Status != model.CaseExecEvalRunning {
			t.Errorf("unexpected status in result: %s", ce.Status)
		}
	}
}

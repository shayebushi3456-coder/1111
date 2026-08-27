# 阶段三测试指南（评测 LLM + verdict 判定 + results 接口）

> 对应实现：测试任务成功后自动派发**评测任务（EvalTask）**，调用评测 LLM 逐条判定校验点，
> 产出 `verdict.json`，服务解析后按「全部校验点通过才 PASSED」判定，并提供 `/results` 接口。

---

## 1. 二段式流程回顾

```text
CaseExecution:
  TEST_RUNNING ──(TestTask 成功)──> EVAL_RUNNING ──(EvalTask 成功)──┬─> PASSED (全部校验点通过)
       │                                                            └─> FAILED (任一不通过)
       └─(TestTask 失败) ──> ERROR       (EvalTask 失败/无 verdict) ──> ERROR
```

- **测试任务(A)**：`lumi-model-setup switch` + `claude -p`，被测端点注入，**不含校验点**。
- **评测任务(B)**：内置评测镜像，输入 = 任务描述 + 校验点 + 测试日志 + 测试产物，输出 `verdict.json`。
- **判定**：`verdict.checkpoints` 全部 `passed=true` → 用例 PASSED；否则 FAILED。

---

## 2. 评测执行器镜像契约（须内置实现）

评测 Job 用内置镜像 `config.Builtin.EvalExecutorImage`，容器内脚本（`internal/eval/prompt.go` 的 `BuildEvalCommand` 生成）会调用镜像内的判定程序：

```sh
task-pilot-judge \
  --prompt "$WORKSPACE/tmp/prompt.txt" \
  --input "$WORKSPACE/input/eval_input.json" \
  --artifacts-dir "$WORKSPACE/input" \
  --base-url "$EVAL_BASE_URL" \
  --model "$EVAL_MODEL_NAME" \
  --api-key "$EVAL_API_KEY" \
  --output "$WORKSPACE/output/verdict.json"
```

镜像方需保证：
- `task-pilot-judge` 读取 `eval_input.json`（`{case_name, description, checkpoints[], test_log}`）+ `artifacts-dir` 下的测试产物；
- 按 prompt 调用评测 LLM，**逐条**判定校验点；
- 写出 `$WORKSPACE/output/verdict.json`：

```json
{
  "overall": "fail",
  "checkpoints": [
    {"index": 0, "passed": true,  "reason": "日志含 login success"},
    {"index": 1, "passed": false, "reason": "report.txt 出现明文密码"}
  ]
}
```

服务只以逐条 `checkpoints[].passed` 聚合判定，`overall` 仅参考。

> 无该镜像/判定程序时，评测 Job 会失败，用例判 `ERROR`（属预期，不会误判 PASSED）。

---

## 3. 环境准备

```bash
export EVAL_ENCRYPTION_SECRET=dev-secret     # 加密被测端点 api_key
export EVAL_MODEL_API_KEY=sk-eval-xxxx        # 评测模型 api_key，注入评测 Job
go run ./cmd/server
```

内置评测端点（base_url/model/镜像）写死在 `internal/config/center.go`，如需对接真实评测 LLM，改这里后重编译。

---

## 4. 单元测试（无需集群）

```bash
go test ./internal/eval/... ./internal/service/... ./internal/util/... ./internal/job/... -v
```

阶段三新增覆盖：

| 测试 | 覆盖点 |
|------|--------|
| `eval/eval_test.go` | verdict JSON 解析、全通过判定、空校验点拒绝、tar.gz 提取 verdict.json、评测命令组装、eval_input 序列化 |
| `service/eval_aggregate_test.go` | 聚合：全 PASSED→SUCCEEDED、含 FAILED→FAILED、未终态→保持 RUNNING |

---

## 5. 端到端（需集群 + 评测镜像）

前 4 步（建端点/用例集/执行任务/轮询）同阶段二 `docs/TESTING-phase2.md`。阶段三重点看**评测阶段与结果**。

### 5.1 观察二段式推进

```bash
curl -s "$BASE_URL/api/v1/eval-runs/<ER_ID>" | jq '.eval_run.case_executions[] | {case_name, status, test_task_id, eval_task_id}'
```

预期状态依次：`TEST_RUNNING` → `EVAL_RUNNING`（eval_task_id 出现）→ `PASSED`/`FAILED`。

### 5.2 查询完整结果（新接口）

```bash
curl -s "$BASE_URL/api/v1/eval-runs/<ER_ID>/results" | jq '.eval_run | {
  status, total, passed, failed, errored,
  cases: [.case_executions[] | {
    case_name, status, test_task_id, eval_task_id, message,
    checkpoints: [.check_results[] | {order_no, passed, reason}]
  }]
}'
```

预期：每条用例带 `check_results` 数组，逐条校验点含 `passed` 与 `reason`。

---

## 6. 校验清单

| 场景 | 预期 |
|------|------|
| 测试成功 | 用例进入 EVAL_RUNNING，派发评测 Job |
| 评测成功且校验全过 | 用例 PASSED，check_results 全 passed |
| 评测成功但有校验不过 | 用例 FAILED，message 含 "n/m checkpoints failed" |
| 评测 Job 失败/无 verdict | 用例 ERROR（不误判 PASSED） |
| verdict.json 非法 | 用例 ERROR，message 含 parse 错误 |
| results 接口 | 返回逐条 check_results |
| 隔离验证 | 测试 Job 无校验点；评测 Job 才含校验点 |
| 评测凭据 | 评测 Job env 有 EVAL_API_KEY，服务任何接口不返回它 |

隔离验证命令：
```bash
# 测试 Job：应无校验点
kubectl get job <test_task_id>-job -n task-pilot -o yaml | grep -i "checkpoint\|校验" || echo "OK: 测试任务无校验点"
# 评测 Job：应含校验点（在 eval_input.json 里，通过 input_files 下发）
kubectl get job <eval_task_id>-job -n task-pilot -o yaml | grep -i "EVAL_API_KEY"
```

---

## 7. 数据落库核查

```bash
sqlite3 data/tasks.db "SELECT id,status,passed,failed,errored FROM eval_runs;"
sqlite3 data/tasks.db "SELECT id,case_name,status,test_task_id,eval_task_id FROM case_executions;"
sqlite3 data/tasks.db "SELECT case_execution_id,order_no,passed,substr(reason,1,40) FROM check_results;"
# 评测任务角色标记
sqlite3 data/tasks.db "SELECT id,role,status FROM tasks WHERE role='eval';"
```

---

## 8. 常见问题

- **用例卡在 EVAL_RUNNING**：评测 Job 未完成，查 `kubectl get pods -l task-id=<eval_task_id>`；多为评测镜像缺失或评测 LLM 不可达。
- **用例 ERROR 且 message 含 "verdict.json not found"**：评测镜像未按契约写 `output/verdict.json`。
- **用例 ERROR 且 message 含 "parse verdict"**：评测 LLM 返回非法 JSON，需在判定程序内加严格 JSON 约束/重试。
- **results 里 check_results 为空**：用例可能未走完评测阶段（仍 RUNNING）或判 ERROR。

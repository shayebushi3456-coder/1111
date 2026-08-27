# 阶段二测试指南（执行任务派发 EvalRun）

> 对应实现：为用例集每条用例派发一个 **TestTask**（K8s Job），执行两条固定指令：
> 1. `lumi-model-setup switch claude --base-url <被测端点> --api-key <被测密钥> --model <模型>`
> 2. `claude -p "<任务描述>"`
>
> 关键隔离：TestTask 只收到「任务描述 + 输入文件 + 被测端点参数」，**绝不含校验点**。
> 阶段二无评测阶段——TestTask 成功即判用例 `PASSED`，失败判 `ERROR`。评测 LLM 在阶段三接入。

---

## 1. 单元测试（无需集群）

```bash
export EVAL_ENCRYPTION_SECRET=dev-secret
go test ./internal/util/... ./internal/service/... ./internal/job/... -v
```

新增覆盖：

| 测试 | 覆盖点 |
|------|--------|
| `service/eval_service_test.go` | 命令组装顺序（先 switch 后 claude -p）、api_key 只经 env 引用、单引号注入转义、快照 JSON 往返、file_ids→InputFileSpec |
| `job/template_test.go` | 附加 env（被测端点参数）注入到 Job 容器、基础 env 保留、额外 env 按 key 排序确定性 |

**安全断言重点**：`TestBuildTestCommand` 验证命令里只有 `--api-key "$TARGET_API_KEY"`（变量引用），不出现明文密钥；`TestBuildTestCommandInjectionSafe` 验证恶意描述被单引号转义。

---

## 2. 命令组装说明

TestTask 容器内执行的脚本（由 `buildTestCommand` 生成）：

```sh
lumi-model-setup switch claude --base-url "$TARGET_BASE_URL" --api-key "$TARGET_API_KEY" --model "$TARGET_MODEL_NAME"
claude -p '<任务描述>'
```

- `TARGET_BASE_URL` / `TARGET_MODEL_NAME` / `TARGET_API_KEY` 由 EvalService 从配置中心解密后，经 Job 容器 **环境变量**注入（见 `job/template.go` 的 extra env）。
- api_key 不写入命令字面量，避免出现在 Pod spec 明文命令或日志中。
- 任务描述用单引号安全包裹，防命令注入。

---

## 3. 端到端联调（需 K8s 集群）

> 前提：可用 kubeconfig；执行镜像 `default_image` 内含 `lumi-model-setup` 与 `claude` CLI（否则用例会因命令不存在而 ERROR，属预期）。

### 3.1 准备被测端点与用例集

```bash
export EVAL_ENCRYPTION_SECRET=dev-secret
go run ./cmd/server   # 另开终端

# 1) 建被测端点（默认端点）
curl -s -X POST http://localhost:8080/api/v1/config/target-endpoints \
  -H 'Content-Type: application/json' \
  -d '{"name":"claude-prod","base_url":"https://api.anthropic.com","model_name":"claude-sonnet-4-6","api_key":"sk-ant-xxxx","is_default":true}'

# 2) 建用例集
curl -s -X POST http://localhost:8080/api/v1/case-sets \
  -H 'Content-Type: application/json' \
  -d @examples/create-case-set.json
# 记下返回的 case_set.id
```

### 3.2 创建执行任务

```bash
curl -s -X POST http://localhost:8080/api/v1/eval-runs \
  -H 'Content-Type: application/json' \
  -d '{"case_set_id":"<CASE_SET_ID>","name":"回归执行"}'
```

预期 `201`：返回 `eval_run.id`（`er-...`）、`status:"RUNNING"`、`total` = 用例数。
未指定 `endpoint_id` 时使用默认端点。

### 3.3 查询进度与结果

```bash
curl -s http://localhost:8080/api/v1/eval-runs/<ER_ID>
```

关注：

- `case_executions[]` 每条含 `test_task_id`、`status`（`TEST_RUNNING`→`PASSED`/`ERROR`）。
- reconciler 每轮（默认 10s）同步 TestTask 状态并回写。
- 全部用例终态后 `eval_run.status` 变为 `SUCCEEDED`（无失败）或 `FAILED`，并写 `passed/failed/errored` 计数。

用 kubectl 观察实际 Job：

```bash
kubectl get jobs -n task-pilot -l app=task-pilot
kubectl logs -n task-pilot -l task-id=<test_task_id> -c executor
```

### 3.4 停止与删除

```bash
curl -s -X POST http://localhost:8080/api/v1/eval-runs/<ER_ID>/stop
# 未完成用例的 Job 被删除，状态置 STOPPED

curl -s -X DELETE http://localhost:8080/api/v1/eval-runs/<ER_ID>
# 先停止再软删除 run 与用例执行
```

---

## 4. 校验清单

| 场景 | 预期 |
|------|------|
| 无默认端点且未指定 endpoint_id | 创建 EvalRun 返回错误（resolve target endpoint 失败） |
| 指定不存在的 endpoint_id | 返回错误 |
| 用例集不存在 | 返回错误 |
| TestTask 命令 | Pod spec 中 `--api-key "$TARGET_API_KEY"`，无明文密钥 |
| 校验点泄露检查 | TestTask 的 env 与命令中**不含任何校验点文本** |
| 隔离验证 | `kubectl get job <name> -o yaml` 检查 env，只有 TARGET_* 与 TASK_*，无 checkpoint |
| 全部用例成功 | eval_run.status = SUCCEEDED |
| 任一用例失败/异常 | eval_run.status = FAILED |
| 停止后 | 未完成用例 STOPPED，run STOPPED |

---

## 5. 数据落库核查

```bash
sqlite3 data/tasks.db "SELECT id,status,total,passed,failed,errored FROM eval_runs;"
sqlite3 data/tasks.db "SELECT id,eval_run_id,case_name,test_task_id,status FROM case_executions;"
# TestTask 的角色标记与关联
sqlite3 data/tasks.db "SELECT id,role,case_execution_id,status FROM tasks WHERE role='test';"
# extra_env 应为密文注入前的 JSON（含 TARGET_*），核对 api_key 是否为解密后的明文——
# 注意：extra_env_json 存的是注入 Job 的明文端点参数，属运行期敏感数据，生产应评估是否加密该列。
```

> 安全提示：当前 `tasks.extra_env_json` 以明文存储被测 api_key（用于注入 Job）。这是已知取舍，
> 后续可考虑对该列加密或改用 K8s Secret 卷挂载。阶段二先保证功能闭环。

---

## 6. 常见问题

- **创建 EvalRun 报 "no default target endpoint configured"**：先建一个 `is_default:true` 的端点，或在请求里指定 `endpoint_id`。
- **用例全部 ERROR**：多半是执行镜像内无 `lumi-model-setup` / `claude` 命令。换用含这些 CLI 的镜像（可临时改 `kubernetes.default_image`）。
- **状态长时间 TEST_RUNNING**：检查 reconciler 是否运行、Job 是否 Pending（`kubectl describe pod`）。

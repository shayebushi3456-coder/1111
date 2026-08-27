# task-pilot

`task-pilot` 是一个基于 **Go 1.22 + Gin + GORM(SQLite) + Kubernetes `batch/v1 Job`** 的自动化任务调度执行系统 MVP。它不依赖 Argo Workflows，不需要安装 CRD 或额外控制器，直接通过 Kubernetes 原生 Job 启动远程执行器（executor）Pod 执行命令。

文件在服务与 Job 之间通过 **HTTP 上传/下载**传递（executor 容器内用 `curl` 回调本服务）。每个 Job 使用独立的 `emptyDir` 卷作为工作区，任务之间硬隔离；产物通过 artifacts HTTP 上传持久化，工作区随 Pod 销毁即清。后续可升级为 S3/MinIO 或 RWX PVC。

> 完整的模块职责、数据模型、扩展点与避坑清单见 [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)。
> 用例集评测能力（配置中心 + 用例集）见下文第 14 节；阶段一测试方式见 [`docs/TESTING-phase1.md`](docs/TESTING-phase1.md)。

---

## 1. 架构总览

```text
Client
  -> HTTP API /api/v1/tasks
  -> task-pilot Go Service ---- SQLite metadata
        |
        v
  Kubernetes batch/v1 Job
  -> executor Pod (sh -c 生成脚本)
        |-- curl 下载 input_files  <--\
        |-- 执行用户 command           |  HTTP 回调 (X-Task-Token 鉴权)
        |-- curl 上传 output.tar.gz  --/
        v
  reconciler 定时轮询 Job/Pod 状态 -> 回写 SQLite
```

组件职责：

- **API 层**：接收请求、参数校验、鉴权、文件上传下载。
- **Service 层**：任务状态机与业务编排（本仓库核心）。
- **Job 层**：`Task → batchv1.Job` 组装、executor 脚本生成、K8s clientset 调用、状态映射。
- **Scheduler**：后台 goroutine，周期性轮询未终态任务并同步状态。
- **FileTransfer**：文件对象落盘、sha256、元数据入库、下载。

> 说明：executor 通过 `service_base_url` 回调服务下载输入、上传产物，跨节点可用。每个 Job 挂载独立的 `emptyDir` 卷（`/workspace`），任务间内核级隔离，无共享文件系统。

## 2. 目录结构

```text
cmd/server/              服务入口：装配依赖、启动 reconciler、启动 HTTP
internal/api/            HTTP handler/router/dto
internal/config/         配置加载（Viper：默认值 + yaml + 环境变量 + APP_CONFIG）
internal/db/             SQLite 初始化和 AutoMigrate
internal/model/          GORM 模型：Task、FileObject
internal/service/        任务状态机和业务逻辑（心脏）
internal/job/            Kubernetes Job client、模板和状态映射
internal/scheduler/      Job/Pod 状态同步 reconciler
internal/filetransfer/   文件上传/下载（落盘 + sha256 + 元数据）
configs/                 配置示例（默认加载 config.example.yaml）
manifests/               Kubernetes 部署示例（namespace/rbac/deployment）
examples/                curl 示例和请求体
docs/                    开发指南（DEVELOPMENT.md）
```

依赖装配顺序（`cmd/server/main.go`）：
`config.Load()` → `db.Open()` → `job.NewClient()` → `service.NewTaskService()` → `filetransfer.NewService()` → 后台 `scheduler.Reconciler.Start()` → `api.NewRouter().Run()`。

## 3. 核心能力

- **创建任务**：提交镜像、命令、输入输出路径与输入文件清单，创建 Kubernetes Job。
- **查询任务**：从 SQLite 查询任务元数据和状态（单条 / 列表）。
- **自动同步状态**：reconciler 定时查询 Job/Pod 状态并回写。
- **取消任务**：删除对应 Kubernetes Job，置为终态 `CANCELLED`。
- **重试任务**：基于原任务参数创建**新任务**（新 Job，新 ID）。
- **查看日志**：通过 Kubernetes Pod logs 返回最近 200 行，并提供 kubectl 排查命令。
- **文件管理**：上传输入文件、下载文件、上传/列出任务产物（artifact）。

## 4. 任务状态机

```text
CREATED ──(Job 创建成功)──> SUBMITTED ──┐
   │                                     │ (reconciler 轮询)
   └─(Job 创建失败)──> FAILED            ▼
                                    RUNNING ──> SUCCEEDED
                                        │  └──> FAILED
                                        └──(cancel)──> CANCELLED
```

| 状态 | 含义 | 由谁写入 |
|------|------|----------|
| `CREATED` | 已落库，尚未提交 Job | CreateTask（瞬时） |
| `SUBMITTED` | Job 已创建成功 | CreateTask |
| `RUNNING` | Pod 运行中 | reconciler |
| `SUCCEEDED` | Job 成功完成 | reconciler |
| `FAILED` | 创建失败或运行失败 | CreateTask / reconciler |
| `CANCELLED` | 用户主动取消 | CancelTask |

要点：reconciler 只处理 `SUBMITTED`/`RUNNING`（未终态）任务；终态不再翻转（取消后即使 Job 实际成功也保持 `CANCELLED`）。

## 5. 环境准备

### 5.1 本地开发环境

- Go 1.22+
- kubectl
- 一个 Kubernetes 集群（kind / minikube / 已有集群）
- jq（可选，运行 `examples/curl.sh`）

检查：

```bash
go version
kubectl version --client
kubectl cluster-info
kubectl get nodes
```

## 6. 依赖准备

```bash
go mod download
go mod tidy
```

## 7. 本地运行

本地运行依赖当前机器的 kubeconfig 可访问集群。kubeconfig 解析顺序：配置 `kubernetes.kubeconfig` → InCluster → `$KUBECONFIG` → `~/.kube/config`。

```bash
mkdir -p data/input data/output
go run ./cmd/server
```

健康检查：

```bash
curl http://localhost:8080/healthz
```

## 8. Kubernetes 部署

### 8.1 应用 namespace 和 RBAC

```bash
kubectl apply -f manifests/namespace.yaml
kubectl apply -f manifests/rbac.yaml
```

验证权限：

```bash
kubectl auth can-i create jobs.batch \
  --as=system:serviceaccount:task-pilot:task-pilot-server -n task-pilot
kubectl auth can-i get pods/log \
  --as=system:serviceaccount:task-pilot:task-pilot-server -n task-pilot
```

期望输出均为 `yes`。

### 8.2 替换服务镜像地址

本工程不提供 Dockerfile，也不做 Docker 构建。部署前请将 `deployment.yaml` 中：

```yaml
image: <TASK_PILOT_IMAGE>
```

替换为具体镜像地址，例如 `registry.example.com/platform/task-pilot:v0.1.0`。

### 8.3 部署服务

```bash
kubectl apply -f manifests/deployment.yaml
kubectl get pods -n task-pilot
kubectl -n task-pilot port-forward svc/task-pilot 8080:8080
```

> 注意：部署样例的 SQLite 使用 `emptyDir`，Pod 重启即丢数据；生产环境需替换为 PVC。服务为单副本（SQLite 单实例约束）。

## 9. API 使用

完整的参数说明、字段类型、错误码见 [`docs/DEVELOPMENT.md` 第 6 节](docs/DEVELOPMENT.md)。下面是快速示例。

### 9.1 创建任务

```bash
curl -X POST http://localhost:8080/api/v1/tasks \
  -H 'Content-Type: application/json' \
  -d @examples/create-task.json
```

请求示例：

```json
{
  "request_id": "demo-001",
  "name": "hello-task-pilot",
  "image": "alpine:3.20",
  "command": "mkdir -p output && echo hello > output/result.txt && ls -R .",
  "timeout_seconds": 600
}
```

> 命令在每个 Job 私有 `emptyDir` 卷的 `$WORKSPACE`（`/workspace/tasks/<task-id>`）下执行；用相对路径写 `output/`，结束后自动打包上传为 artifact。

返回中重点关注：

```json
{ "task": { "id": "task-xxxx", "job_name": "task-xxxx-job", "status": "SUBMITTED" } }
```

### 9.2 查询任务

```bash
curl http://localhost:8080/api/v1/tasks/{task_id}
curl http://localhost:8080/api/v1/tasks
```

### 9.3 查看日志

```bash
curl http://localhost:8080/api/v1/tasks/{task_id}/logs

# 也可以用 kubectl
kubectl get jobs -n task-pilot
kubectl get pods -n task-pilot -l task-id=<task_id>
kubectl logs -n task-pilot -l task-id=<task_id> --all-containers=true
```

### 9.4 取消 / 重试任务

```bash
curl -X POST http://localhost:8080/api/v1/tasks/{task_id}/cancel
curl -X POST http://localhost:8080/api/v1/tasks/{task_id}/retry
```

### 9.5 文件上传 / 下载 / 产物

```bash
# 上传输入文件
curl -X POST http://localhost:8080/api/v1/files/upload \
  -F "file=@./local.txt" -F "purpose=input"

# 下载文件（带 task_id 时需 X-Task-Token）
curl -OJ http://localhost:8080/api/v1/files/{file_id}/download

# 列出任务产物
curl http://localhost:8080/api/v1/tasks/{task_id}/artifacts
```

## 10. 编译和测试

```bash
gofmt -w cmd internal
go test ./...
go build -o bin/task-pilot ./cmd/server
# 或使用 Makefile: make tidy / fmt / test / build / run
```

## 11. 文件传输与工作区隔离

文件传输走 HTTP；每个 Job 挂载**独立的 `emptyDir` 卷**在 `/workspace`，任务间硬隔离。executor 容器内脚本流程（由 `internal/job/template.go` 的 `buildScript` 生成）：

1. 在私有卷里创建工作区 `$WORKSPACE=/workspace/tasks/<taskID>` 下的 `input/output/tmp`。
2. 对每个 `input_files` 项：`curl -H "X-Task-Token"` 从 `/api/v1/files/{fileID}/download` 下载到 `input/`（仅信任 basename，防路径穿越）。
3. `cd $WORKSPACE` 执行用户 `command`。
4. 打包 `output/` 为 `tar.gz`，`curl -F` 上传到 `/api/v1/tasks/{taskID}/artifacts`。

隔离与限制：

- 每个 Job 的工作区是自己的 `emptyDir`，其他任务的命令无法访问——内核级隔离，非路径约定。
- 工作区随 Pod 销毁清空；产物已通过 artifacts 上传持久化，不依赖工作区存活。
- 服务必须在集群内通过 `service_base_url` 可达，否则 executor 传文件失败。
- `emptyDir` 占用节点磁盘，超大产物任务多时建议给卷加 `SizeLimit`，或升级 S3/MinIO 预签名 URL / RWX PVC。

## 12. 常见问题

### 12.1 Job 创建 forbidden

```bash
kubectl auth can-i create jobs.batch \
  --as=system:serviceaccount:task-pilot:task-pilot-server -n task-pilot
```

若不是 `yes`，重新 `kubectl apply -f manifests/rbac.yaml`。

### 12.2 Job 一直 Pending

```bash
kubectl get jobs,pods -n task-pilot
kubectl describe pod <pod-name> -n task-pilot
```

常见原因：镜像拉取失败、节点资源不足、节点磁盘不足（emptyDir）、ServiceAccount 配置错误。

### 12.3 无法读取日志

```bash
kubectl get pods -n task-pilot -l task-id=<task_id>
kubectl logs <pod-name> -n task-pilot -c executor
```

### 12.4 任务传文件失败

检查 `file_transfer.service_base_url` 是否为集群内可达地址，且 executor 能带 `X-Task-Token` 通过鉴权。

## 13. 交付验证说明

若执行环境未提供 Go 工具链（`gofmt: command not found`），本次跳过 Go 编译验证。源码已按 Go 1.22 工程结构组织，请在具备 Go 1.22 的环境中执行第 10 节命令完成依赖解析、格式化与编译验证：

```bash
gofmt -l cmd internal
go mod tidy
go test ./...
go build ./cmd/server
```

---

## 14. 用例集评测（阶段一：配置中心 + 用例集）

已实现评测能力的定义层与配置中心。完整设计见设计方案文档，测试方式见 [`docs/TESTING-phase1.md`](docs/TESTING-phase1.md)。

### 14.1 配置中心：被测模型端点（多套）

用户可管理多套被测模型端点，**仅** `base_url` / `model_name` / `api_key` / `name` / `is_default` 可写；评测模型、执行镜像、评测 prompt 等均内置写死不可改。`api_key` 加密存储（AES-GCM）、脱敏返回。

加密密钥来自环境变量 `EVAL_ENCRYPTION_SECRET`（对应配置 `eval.encryption_secret`），生产务必用 Secret 注入。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/config/target-endpoints` | 列出端点（api_key 脱敏） |
| POST | `/api/v1/config/target-endpoints` | 新增端点 |
| GET | `/api/v1/config/target-endpoints/:id` | 端点详情（脱敏） |
| PUT | `/api/v1/config/target-endpoints/:id` | 更新（api_key 留空则保留原值） |
| DELETE | `/api/v1/config/target-endpoints/:id` | 删除 |

```bash
curl -X POST http://localhost:8080/api/v1/config/target-endpoints \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod","base_url":"https://llm.example.com/v1","model_name":"gpt-x","api_key":"sk-xxxx","is_default":true}'
```

### 14.2 用例集

每条用例含：任务描述、关联文件（`file_ids`，需先经 `/files/upload` 上传）、**纯文本校验点**（仅评测阶段可见）。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/case-sets` | 创建用例集（含用例与校验点） |
| GET | `/api/v1/case-sets` | 列表 |
| GET | `/api/v1/case-sets/:id` | 详情（含用例与校验点） |
| PUT | `/api/v1/case-sets/:id` | 覆盖式更新（version 递增） |
| DELETE | `/api/v1/case-sets/:id` | 删除 |

```bash
curl -X POST http://localhost:8080/api/v1/case-sets \
  -H 'Content-Type: application/json' \
  -d @examples/create-case-set.json
```

> 后续阶段（二段式测试+评测 LLM、结果查询）见设计方案文档的分阶段计划。

### 14.3 执行任务 EvalRun（二段式：测试 + 评测 LLM）

为用例集每条用例执行**两段式**流程，各对应一个独立 K8s Job：

**阶段 A · 测试任务（TestTask）** —— 在容器内执行两条固定指令：

```sh
lumi-model-setup switch claude --base-url "$TARGET_BASE_URL" --api-key "$TARGET_API_KEY" --model "$TARGET_MODEL_NAME"
claude -p '<任务描述>'
```

被测端点参数从配置中心解密后经**环境变量**注入（api_key 不落命令字面量）。**测试任务只收到任务描述 + 输入文件 + 被测端点，绝不含校验点**（评测隔离）。

**阶段 B · 评测任务（EvalTask）** —— 测试成功后自动派发。服务把「任务描述 + 校验点 + 测试日志 + 测试产物」交给内置评测执行器镜像，调用**评测 LLM** 逐条判定校验点，产出 `verdict.json`。服务解析后：**全部校验点通过才判 `PASSED`，任一不通过判 `FAILED`**；测试或评测执行本身异常判 `ERROR`。

用例状态流转：`PENDING → TEST_RUNNING → TEST_DONE → EVAL_RUNNING → PASSED/FAILED`（异常 → `ERROR`）。测试方式见 [`docs/TESTING-phase3.md`](docs/TESTING-phase3.md)。

**全局并发控制**：创建 EvalRun **不再即时派发**所有 Job，而是把每条用例落库为 `PENDING` 排队。调度器（`ScheduleOnce`，挂在 reconcile 循环内）每轮按 `scheduler.max_concurrent_tasks - 当前运行中用例数` 的空闲额度，跨**所有** EvalRun 的队列 FIFO 出队派发；额度对测试任务与评测任务统一计数，优先派发待评测用例（尽快释放额度）。`max_concurrent_tasks<=0` 表示不限流。这避免了大用例集瞬间灌爆集群。

评测模型端点/镜像/prompt 全部内置写死；评测模型 api_key 从环境变量 `EVAL_MODEL_API_KEY` 注入评测 Job，不入库、不出接口。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/eval-runs` | 创建执行任务并派发（body: `case_set_id`, 可选 `name`/`endpoint_id`） |
| GET | `/api/v1/eval-runs` | 列表 |
| GET | `/api/v1/eval-runs/:id` | 详情（含每条用例的 test_task_id/eval_task_id 与状态） |
| GET | `/api/v1/eval-runs/:id/results` | **完整结果**（每条用例 + 逐条校验点 passed/reason） |
| POST | `/api/v1/eval-runs/:id/stop` | 停止（删除未完成用例的 Job） |
| DELETE | `/api/v1/eval-runs/:id` | 删除（先停止再软删） |

```bash
curl -X POST http://localhost:8080/api/v1/eval-runs \
  -H 'Content-Type: application/json' \
  -d '{"case_set_id":"<cs-id>","name":"回归执行"}'

# 查看完整评测结果（含每条校验点判定与理由）
curl http://localhost:8080/api/v1/eval-runs/<er-id>/results
```

> `endpoint_id` 省略时使用配置中心的默认端点（`is_default:true`）。
> 评测执行器镜像需内置 `task-pilot-judge` 判定程序，契约见 `internal/eval/prompt.go`：读取 `input/eval_input.json` + 产物，调用评测 LLM，写 `output/verdict.json`。



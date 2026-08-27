# 阶段一测试指南（配置中心 + 用例集）

> 对应实现：被测模型端点多套 CRUD（api_key 加密/脱敏）+ 用例集 CRUD（纯文本校验点）。
> 本阶段不涉及 K8s 执行，可完全脱离集群本地验证。

---

## 1. 前置准备

```bash
cd task-pilot
go mod download && go mod tidy

# 关键：设置加密密钥（用于加密被测端点 api_key）。不设则加密相关操作会报错。
export EVAL_ENCRYPTION_SECRET="local-dev-secret-please-change"

mkdir -p data
go run ./cmd/server
```

> 说明：阶段一即便没有可用的 kubeconfig，服务进程内 `job.NewClient` 会尝试解析 kubeconfig。
> 若本地无集群导致启动失败，可临时指向任意有效 kubeconfig，或在有集群的环境验证。
> 配置中心与用例集接口本身不触达 K8s。

健康检查：

```bash
curl http://localhost:8080/healthz
# {"name":"task-pilot","status":"ok"}
```

---

## 2. 单元测试

```bash
go test ./internal/util/... ./internal/service/... -v
```

覆盖内容：

| 测试文件 | 覆盖点 |
|----------|--------|
| `internal/util/crypto_test.go` | AES-GCM 加解密往返、随机 nonce、错误密钥失败、空密钥拒绝、脱敏格式 |
| `internal/service/config_service_test.go` | api_key 加密存储、脱敏、默认端点唯一性、更新时空 key 保留原值、必填校验 |
| `internal/service/caseset_service_test.go` | 用例集创建/查询、file_ids 往返、校验、覆盖式更新递增版本、删除级联 |

预期全部 `PASS`。

---

## 3. 接口冒烟（脚本）

一键跑通配置中心 + 用例集全链路：

```bash
BASE_URL=http://localhost:8080 bash examples/eval.sh
```

脚本依次执行：新增端点 → 列表（验证脱敏）→ 更新（验证保留 key）→ 创建用例集 → 查询详情 → 列表 → 清理。

---

## 4. 手工接口验证

### 4.1 配置中心：被测模型端点

**新增端点**（api_key 会被加密存储）：

```bash
curl -X POST http://localhost:8080/api/v1/config/target-endpoints \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod","base_url":"https://llm.example.com/v1","model_name":"gpt-x","api_key":"sk-secret1234","is_default":true}'
```

预期 `201`，返回体 `api_key_masked` 为 `****1234`，**不含明文 api_key**。

**列表 / 详情**：

```bash
curl http://localhost:8080/api/v1/config/target-endpoints
curl http://localhost:8080/api/v1/config/target-endpoints/<id>
```

验证：所有返回中 api_key 均脱敏；响应 JSON 无 `api_key` 明文字段（只有 `api_key_masked`）。

**更新**（不传 `api_key` 时保留原值）：

```bash
curl -X PUT http://localhost:8080/api/v1/config/target-endpoints/<id> \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod","base_url":"https://llm.example.com/v1","model_name":"gpt-x-turbo"}'
```

**默认端点唯一性**：再新增一个 `is_default:true` 的端点，列表中应只有最新那个 `is_default=true`。

**删除**：

```bash
curl -X DELETE http://localhost:8080/api/v1/config/target-endpoints/<id>
```

### 4.2 用例集

**创建**（校验点为纯文本数组）：

```bash
curl -X POST http://localhost:8080/api/v1/case-sets \
  -H 'Content-Type: application/json' \
  -d @examples/create-case-set.json
```

预期 `201`，返回 `case_set.id`（`cs-...`），`version=1`，每个 case 带 `checkpoints` 与 `file_ids`。

**查询详情 / 列表**：

```bash
curl http://localhost:8080/api/v1/case-sets/<id>
curl http://localhost:8080/api/v1/case-sets
```

详情应按 `order_no` 返回用例与校验点。

**更新**（覆盖式，version 递增）：

```bash
curl -X PUT http://localhost:8080/api/v1/case-sets/<id> \
  -H 'Content-Type: application/json' \
  -d @examples/create-case-set.json
```

再查详情，`version` 应变为 2，旧用例与校验点被替换。

**删除**：

```bash
curl -X DELETE http://localhost:8080/api/v1/case-sets/<id>
# 再 GET 应返回 404
```

---

## 5. 边界与安全校验清单

| 场景 | 请求 | 预期 |
|------|------|------|
| 端点缺 name | POST 端点省略 name | `400`，提示 required |
| 端点重名 | 两次同 name | 第二次 `400`（唯一索引冲突） |
| api_key 泄露检查 | 任意 GET 端点 | 响应绝无明文 api_key，只有 `****xxxx` |
| 无默认端点 | 未建 default 时内部取默认 | `DefaultEndpoint` 返回错误（阶段二消费） |
| 用例集无用例 | POST cases 为空 | `400` |
| 用例无校验点 | 某 case checkpoints 为空 | `400` |
| 用例缺描述 | 某 case 无 description | `400` |
| 删除后查询 | DELETE 后 GET | `404` |

---

## 6. 数据落库核查（可选）

```bash
# 用例集与校验点是否正确落库
sqlite3 data/tasks.db "SELECT id,name,version FROM case_sets;"
sqlite3 data/tasks.db "SELECT id,case_id,description FROM checkpoints;"
# 端点 api_key 应为密文（base64），而非明文
sqlite3 data/tasks.db "SELECT id,name,api_key_enc FROM target_endpoints;"
```

`api_key_enc` 字段应是一串 base64 密文，肉眼不可读，验证加密生效。

---

## 7. 常见问题

- **启动报 `encryption secret is empty`**：未设置 `EVAL_ENCRYPTION_SECRET`。加密/解密相关操作需要该密钥。
- **端点创建成功但 masked 为 `****`**：说明解密失败，通常是换过 `EVAL_ENCRYPTION_SECRET`——旧密文无法用新密钥解开。同一环境请保持密钥稳定。
- **本地无 K8s 集群导致启动失败**：阶段一逻辑不依赖集群，但进程启动会初始化 K8s client。在有 kubeconfig 的环境运行，或等阶段二一并联调。

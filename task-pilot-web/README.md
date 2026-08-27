# WorkEval

Agent 自动化评测平台前端控制台（TypeScript + Vite）。对接 task-pilot 后端的两段式评测流程（TestTask → EvalTask），所有数据均通过 task-pilot 的 REST 接口读写，不含任何 mock/示例数据。

## 功能

- 中文默认界面，支持 light / dark 主题切换（记忆于 localStorage）
- 评测执行（EvalRun）看板：概览、执行列表、执行详情（用例表格、进度、状态），支持创建/停止/删除
- 用例集（CaseSet）管理：新建/编辑（多用例表单 + 输入文件上传 + 校验点）、详情、关联执行记录展示、**软删除**（与后端快照语义保持一致，删除不影响历史执行）
- 配置中心：被测模型端点 / 评测模型端点 / 评测 Prompt 的增删改与默认值设置
- 产物浏览：测试/评测任务上传的 `output.tar.gz` 由浏览器本地解压（零依赖 gzip + tar 解析），展示内部文件树，支持 md / json / html / 图片 / 文本预览
- Agent 执行轨迹（trace.jsonl）可视化：从产物包中提取 trace.jsonl 后按真实 `stream-json --verbose` 格式解析 system/assistant/user/result 事件，思考心跳自动聚合折叠，工具调用与结果配对展示
- 批量导出：拉取所选用例的测试/评测产物包并本地解压，按用例分目录重新打包为一个 zip 下载（客户端零依赖 ZIP 编码器，STORE 无压缩）

## 后端依赖

本项目是纯前端，**必须**配合 [task-pilot](../task-pilot) 后端运行才能正常工作；没有后端时页面会展示接口错误状态。

task-pilot 默认监听 `:8081`（见其 `configs/config.example.yaml`），且**未内置 CORS 中间件**——浏览器直连跨域地址会被拦截，需要以下两种方式之一：

1. **开发环境**：Vite dev server 已配置好 `/api` → 后端的代理（见 `vite.config.ts`），默认转发到 `http://127.0.0.1:8081`。若后端监听其他地址，复制 `.env.example` 为 `.env` 并设置 `TASKPILOT_DEV_PROXY_TARGET`。
2. **生产部署**：前端静态资源与后端需同源（同域名同端口）对外提供，由网关/反代把 `/api/v1/*` 转发到 task-pilot；或后端自行加 CORS 中间件后，构建时设置 `VITE_API_BASE_URL` 指向后端绝对地址。

## 开发

先启动 task-pilot 后端（参考其仓库 README/`cmd/server`），再：

```bash
./start.sh
```

或手动执行：

```bash
npm install
npm run dev      # 本地开发服务器，默认 http://localhost:5173，/api 已代理到后端
npm run build    # 类型检查 + 生产构建，输出到 dist/
npm run preview  # 预览生产构建（不带开发代理，需要 VITE_API_BASE_URL 或反代）
```

需要 Node.js 18 及以上版本。

## 目录结构

```
src/
  types.ts        领域模型类型定义（字段与后端 model/dto 的 json tag 严格对齐）
  api/
    client.ts      fetch 封装：统一 base URL、错误解析
    caseSets.ts     用例集 CRUD
    evalRuns.ts     执行任务 CRUD + 停止 + 运行中用例查询
    endpoints.ts    被测/评测端点 CRUD
    prompts.ts      评测 Prompt CRUD
    files.ts        文件上传/下载、产物列表
  lib/
    minizip.ts      零依赖 ZIP 编码器（批量导出用）
    tarball.ts      零依赖 tar.gz 解压（解析产物包）
  main.ts           视图渲染、路由与交互逻辑
  styles.css        设计系统（CSS 变量，双主题）
public/
  favicon.svg       WorkEval 图标
```

## 已知限制

- 用例集编辑已有用例时，`file_ids` 无法反查原始文件名（后端没有 `GET /files/:id` 元信息接口），仅展示文件 ID；如需按文件名管理，需要后端补充该接口。
- 批量导出、产物预览都需要为每条用例分别拉取并解压 tar.gz，用例数较多或产物较大时耗时会明显增加，属于纯前端方案在没有专用批量接口时的固有代价。

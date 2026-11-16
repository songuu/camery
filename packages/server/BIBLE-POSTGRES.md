# StoryBible 应用宿主

API 与工作台支持小说/剧本来源的持久化提取记录、冻结原文定位、显式合并/拆分与确认/拒绝。确认保存独立知识快照，正式 IR 的采用仍需 ChangeSet。`project:read` 允许读取，`task:run` 允许开始，`candidate:review` 允许审阅；审核者和审计时间由认证服务器生成。

默认关闭。三个数据库连接池必须使用不同的 `NOINHERIT LOGIN`：原 auth 角色、Bible 角色、任务预算角色。Bible 角色仅 ingest documents/scripts SELECT，以及 Bible runs/chunks/candidates/reviews SELECT/INSERT；任务角色仅 durable 四表和 budget 三表的精确权限，由 `grantBibleTaskRuntimeRole` 在安装阶段授予。`verifyBibleRuntimeRole`/`verifyBibleTaskRuntimeRole` 会拒绝全非系统 schema 范围的额外表、列、序列、创建、角色成员及所有权能力。它们是受信服务身份，不能作为终端用户数据库账号。

安装身份显式执行 `migrateIngest`、`migrateDurable`、`migrateAgents`、`migrateBible`，并通过预算账本创建固定项目预算。Bible 新增 0002 目录索引；0001 checksum 不改。运行服务不自动安装、扩权、建预算或结算。

`readBibleConfig` 在首次 await 前捕获配置：

| 变量 | 含义 |
|---|---|
| `CAMERY_BIBLE_ENABLED=1` | 开启 API 模块；默认 0 |
| `CAMERY_TENANT_ID` / `CAMERY_BIBLE_PROJECT_ID` | 固定运行范围 |
| `CAMERY_BIBLE_DATABASE_URL_FILE` | Bible 最小角色的 PostgreSQL URL 文件 |
| `CAMERY_BIBLE_TASK_DATABASE_URL_FILE` | 任务预算最小角色的 URL 文件 |
| `CAMERY_BIBLE_TEXT_CONFIG_FILE` / `CAMERY_BIBLE_TEXT_TOKEN_FILE` | 成对提供的文本配置/令牌文件；均无时 API 允许只读及审阅，禁止新提取 |
| `CAMERY_BIBLE_WORKER_ID` / `CAMERY_BIBLE_POLL_MS` / `CAMERY_BIBLE_RUNS_PER_ROUND` | 默认 bible-worker / 1000 / 20；有界公平扫描 |

文件必须是有效 UTF-8 普通文件，实际读取不超过 8 KiB。部分配置、无效配置会拒绝启动。关闭时不得残留 Bible 配置。密钥不进入构建参数、HTTP 请求、UI 或日志。

文本配置 JSON 示例（示例端点与价格不代表实际可用服务；必须按实际供应方配置）：

```json
{
  "label": "项目文本模型",
  "baseUrl": "https://text.example/v1",
  "connectionId": "bible-text",
  "modelIdentity": "configured-text-model",
  "structuredOutput": "json_schema",
  "timeoutMs": 120000,
  "currency": "CNY",
  "reservation": {"tokens": 20000, "costMicros": 100000},
  "pricing": {"inputMicrosPerMillionTokens": 1000000, "outputMicrosPerMillionTokens": 2000000},
  "limits": {"steps": 100, "tokens": 2000000, "costMicros": 10000000}
}
```

接线是 `NodeHttpTransport → OpenAiCompatibleLlm → ModelSession`，固定 economy/live_model，不接受请求指定模型、URL 或 synthetic fallback。`modeDigest` 由宿主推导；配置变更后不能静默替换旧 run 的执行身份。默认 HTTPS 并拒绝私网；明确本地文本服务才同时配置 `allowPrivateNetworks` 和 `allowInsecureHttp`。ComfyUI 图像服务不是文本抽取服务。

预算是每块预留和运行上限，不能保证供应方账单硬上限；项目总预算由 installer 单独设置。未知计量和外部结果保留原状态，管理员对账后才恢复，不自动重发。持有预算的终态分配需要管理员显式结算。

本地构建后分别运行 `node packages/server/dist/main.mjs` 与 `node packages/server/dist/bible-worker.mjs`。worker 未配置文本时非零退出。SIGINT/SIGTERM 停止下一轮，等待当前有界任务后关闭连接池；强杀后由 durable 租约恢复。

容器：现有 `compose.private.yml + compose.api.yml` 上叠加 `compose.bible.yml` 可先部署审阅；提供实际文本配置、令牌和项目预算后再加 `compose.bible-text.yml` 并启动 bible-worker。运行文件见 `deploy/.env.bible.example`，原 API auth secret 仍独立。新镜像包含三个原生 JS 入口；只读、非 root、禁提权，worker 330 秒停机宽限覆盖模型超时上限。

验证命令：`pnpm check`，`pnpm test:bible:local -- --coverage`，`pnpm test:server:local -- --coverage`。PG 测试包含受限登录与真实 HTTP 协议夹具，不能作为真实模型十章质量或真实用户确认的证据。

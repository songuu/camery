# NestJS / Fastify 认证 API 骨架

## T1.1 来源服务与工作台

同一应用镜像现在包含[来源工作台](../web/README.md)静态资源。来源API以`CAMERY_SOURCE_IMPORTS=1`显式开启；默认0保留阶段0认证运行方式。静态目录由受信配置`CAMERY_FRONTEND_DIRECTORY`指定（镜像内固定`/app/public`），没有前端跨域或代理身份信任。

| 路由 | 权限 / 行为 |
|---|---|
| `GET /api/v1/projects/:projectId/sources` | `project:read`；50条一页的小说/剧本元数据目录 |
| `POST .../novels/:documentId/batches` | `candidate:write`；不可变显示标题、批次内容与revision；相同批次幂等 |
| `GET .../novels/:documentId` | `project:read`；当前用户游标和有界原文页 |
| `POST .../novels/:documentId/checkpoint` | `project:read`；只保存当前认证用户的单调游标 |
| `PUT .../scripts/:documentId/:format?title=...` | `candidate:write`；`application/octet-stream`最多8MB，格式`docx/fountain/csv/tsv`；原始字节与候选同事务保存 |
| `GET .../scripts/:documentId` | `project:read`；有界预览，不回传原始二进制或完整快照 |

`tenantId/readerId`从认证principal取得，不能由请求体替换。正文以候选保存，不调用模型、不采用到IR。预览默认12000、最大20000个UTF-16单元，最多200条相交结构；`offset`与`before`互斥，后者用于无历史状态的相邻上一段，不拆代理对。写入游标仍严格拒绝非法边界。普通路由所有内容类型保持16KiB；仅小说批次放宽到6.1MB、剧本字节到8MB，核心仍独立检查格式及资源上限。

来源开启前，可信安装者显式调用`migrateIngest(adminPool)`验证版本1并追加版本2；不得让API登录身份迁移或管理schema。对现有受限API角色只追加：

```sql
GRANT USAGE ON SCHEMA camery_ingest TO camery_api_runtime;
GRANT SELECT, INSERT, UPDATE ON camery_ingest.documents, camery_ingest.reading_checkpoints TO camery_api_runtime;
GRANT SELECT, INSERT ON camery_ingest.scripts TO camery_api_runtime;
```

这里的角色名是安装示例，须由实际受信安装流程替换。启动依次执行认证与来源两层权限检查，缺少任一必需权限、schema/table所有权、CREATE、migrations访问、脚本UPDATE或多余列级权限均失败。回滚可先关闭来源开关恢复认证服务，保留新表及原始数据；旧版严格小说快照读取器不能读取带可选title的新记录，导入数据恢复须使用兼容版本，不能删除字段或旧迁移记录来绕过校验。

`pnpm test:server:local --coverage`用真实独立LOGIN验证授权、各格式导入、每用户游标与重启。`pnpm test:private-api:local`分别以来源关闭/开启运行同一实际镜像，检查静态JS、Word解析、最小权限、重启后游标与会话撤销，不以宿主源码执行冒充镜像验收。

按 [ADR-002](../../docs/adr/002-backend-modular-monolith.md) 使用 NestJS 12 / Fastify 5。认证和角色规则见 [access](../access/README.md)，数据库权限见 [POSTGRES.md](../access/POSTGRES.md)。

| 路由 | 权限 | 行为 |
|---|---|---|
| `GET /health` | 公开 | 进程存活，未声称数据库健康 |
| `GET /api/v1/me` | 有效会话 | 返回受验证租户、用户及其项目角色 |
| `GET /api/v1/projects/:projectId/access` | `project:read` | 返回当前项目权限 |
| `POST /api/v1/auth/sign-out` | 有效会话 | 撤销当前会话，返回 204 |

`AccessModule.register({tenantId,store})` 注册全局 guard 和安全错误映射。嵌入该模块的业务 controller 必须声明 `@RequireAccess('authenticated')` 或具体项目权限；项目权限路由需提供 `:projectId`。没有策略的 handler 默认拒绝，不执行 controller。当前 HTTP 不直接暴露候选采用、任务调度或安装签发器；业务应用服务接入是独立验收项。

拒绝重复 `Authorization` 原始头，忽略身份代理头、Cookie 和 query token。响应设置 `no-store`；应用工厂设置安全响应头、16 KiB body 限制、随机请求 ID，不启用请求/凭据日志、CORS 或代理身份信任。错误仅返回固定 `code` 和服务端 `requestId`，不回显请求或底层驱动消息。停机先排空应用，再释放数据库连接，应用关闭失败也会尝试关闭数据库池。

## 本地启动

可信安装者先显式迁移认证 schema、初始化成员/会话，并配置只读认证表及列级撤销权限的独立 LOGIN 角色。启动器拒绝管理员、角色切换伪降权、任意其他角色成员身份、受保护 schema 所有权/CREATE、缺少权限或超额写权限。

通过受保护环境注入 `CAMERY_TENANT_ID`，数据库凭据二选一：`CAMERY_DATABASE_URL` 或 `CAMERY_DATABASE_URL_FILE`。文件必须是普通文件，最大 8 KiB，可有单个尾换行；实际读取有字节上限，拒绝双来源、控制字符和无效 URL，错误不包含文件内容。入口在首次等待前捕获五项配置，不受后续环境变更影响。可选 `CAMERY_API_PORT`（默认 3000）和 `CAMERY_API_HOST`（默认 `127.0.0.1`，仅允许另选 `0.0.0.0`）。开发环境运行：

```sh
pnpm start:api
```

数据库和租户缺配置会安全退出。不会自动迁移或创建用户/凭据，也不读取 `deploy/.env.phase0` 管理员连接。对外部署、TLS/反向代理、登录 UI、限流、完整审批管理和常驻 worker 编排尚未验收；上线仍需安全人工 gate。

`pnpm --filter @camery/server build` 生成 `dist/main.mjs`，`start:built` 使用 Node 原生运行。构建只把内部工作区代码打入 bundle，第三方包保持锁文件的生产依赖闭包；运行包裁剪在删除前验证包名及链接/解析路径均在隔离目录内，不携带工作区 TS 源码、测试或开发依赖。多阶段非 root 镜像及文件 secret 的 [私有化 Compose 用法](../../deploy/README.md) 已提供。

## 验证

`pnpm --filter @camery/server test:coverage` 运行真实 Nest/Fastify `inject` 测试，覆盖默认拒绝、租户/项目隔离、重复原始头、错误脱敏和停机失败。`pnpm test:server:local --coverage` 另以实际 PostgreSQL 和独立低权限 LOGIN 验证会话签发后的读取、角色降级、禁用及退出撤销；缺数据库配置明确失败。薄 CLI `main.ts` 不计入单元覆盖率，认证应用、配置及资源释放均在门槛内。

`pnpm test:private-api:local` 另启动已构建的实际容器，验证低权限文件凭据、重启后的撤销和 SIGTERM 退出；不以宿主进程覆盖率代替镜像运行证据。构建测试要求子进程自然安全退出，超时被杀不算通过；路径攻击负测只 mock 删除函数，不执行隔离目录外的删除。

框架接入遵循 [NestJS 全局 guard](https://docs.nestjs.com/guards)、[Fastify 适配器](https://docs.nestjs.com/techniques/performance)和[安全响应头](https://docs.nestjs.com/techniques/security)的官方接口。

## 阶段 0 章节 worker

同一应用镜像包含 `worker.mjs`，只注册 `phase0.chapter-research@1`，固定受信配置的 tenant/project/tree。它复用 AgentDispatchHost、实际 DurableWorker、章节方法及项目预算账本；只读预先创建的树，不从来源文本选择角色、供应商、脚本、预算或权限，也不自动迁移、创建项目或授予数据库权限。

本地先执行 `pnpm --filter @camery/server build`，再设置受保护环境并运行 `pnpm --filter @camery/server start:worker`：

- `CAMERY_TENANT_ID`、数据库 URL 或 URL_FILE，与 API 使用相同的配置读取边界。
- `CAMERY_WORKER_PROJECT_ID`、`CAMERY_WORKER_TREE_ID`、`CAMERY_WORKER_ID` 均必填；所有身份字段在任何等待前一起快照。
- 可选 `CAMERY_WORKER_CONTENT_DIRECTORY`，默认使用 bundle 相邻的 `content`。源开发者如自行运行 TS 入口，应显式设置为仓库内容根；标准脚本使用已构建入口和随附内容。

内容只带指定的 8 个角色/方法包数据文件。方法包声明的黄金评测文件是该 pin 的必要内容，保持其来源/许可与原始字节，不携带额外 corpus、baseline 或工作区测试。加载器将方法 pin 写入派生制片定义的 `methods`，因此持久化任务的制片 pin 同时锁定方法版本；换镜像后找不到旧 pin 会拒绝，不静默替换已排队项目的内容。该派生身份不改写仓库原角色或评测基线。

每轮核对固定路线、任务身份和单一 source 对象范围；每次返回的是已验证的冻结树快照。预算分配作为幂等日志步骤先于研究执行，固定预留 8 steps、0 tokens、0 cost micros（CNY）；回执须完整匹配任务/项目/角色且仍 held，项目无法预留时不执行方法。候选停在原 `producer.review` 人工闸门，信号由受信宿主提供，输出只投影为制片声明的 `state/candidateDigest`；完整候选留在日志/闸门中，不采用 IR。

停止信号停止新领取并等待在途执行排空，不冒充业务取消；已等待的闸门和预算可由新进程恢复。单树完成或 blocked 是正常进程结束（具体结果以数据库及固定状态日志为准），初始化/基础设施错误退出 1，Compose 最多重启三次。分配完成后不会自动伪造实际账单或释放 held：终态后仍由受信宿主按已有预算确认协议结算。

worker 必须使用不同于 API/安装者的[固定最小权限身份](WORKER-POSTGRES.md)。默认只创建进程内脱敏追踪，不输出来源/候选/凭据或安装网络 exporter。通用多树/角色调度、认证 HTTP 审阅入口及 UI 仍待应用服务接入；本入口是阶段 0 固定章节制片骨架。

阶段1另有独立[`bible-worker.mjs`](BIBLE-POSTGRES.md)：固定项目、真实文本模式、逐块预算任务与有界公平扫描。Bible HTTP/审阅UI复用现有认证并使用独立数据及任务连接池；与上述阶段0章节worker分别部署。新入口已编入同一镜像，默认不启用；没有文本配置时API允许审阅已有结果，worker拒绝启动，不能回退为合成模型。

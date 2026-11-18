# 大纲 API 与常驻宿主

`compose.outline.yml` 为既有 API 镜像追加大纲服务和 `outline-worker.mjs`。默认主配置不启用大纲；加入该 overlay 后可保存简报、发现已审阅来源、读取候选和显式人工审阅。`compose.outline-text.yml` 追加受信文本模型文件配置，允许开始新的模型运行。正式 IR 采用、页面和真实文本质量仍按 [T1.4 计划](../docs/plan/dramaturgy-phase1.md) 继续。

## 安装与身份

安装者先完成已有 access/durable/agents/ingest/bible/development 迁移及 `migrateOutline(adminPool)`，正常 API/worker 不安装迁移或角色。参考 [原创开发部署](development.md) 的三类独立 LOGIN 流程：

- auth LOGIN 沿用认证读权限及仅 `sessions.revoked_at` 更新权限；会话和项目成员由安装者显式建立。
- data LOGIN 使用 `grantOutlineRuntimeRole(adminPool, role)`，仅本域四表 SELECT/INSERT 和来源必需 SELECT；用 `verifyOutlineRuntimeRole(dataPool)` 校验。
- task LOGIN 使用 server 的 `grantOutlineTaskRuntimeRole`（既有 Bible task/budget 固定权限实现的 alias）；用 `verifyOutlineTaskRuntimeRole` 校验。它不读取大纲正文、认证数据，不允许结算、改预算上限或自行安装。

LOGIN 均采用既有 NOSUPERUSER/NOBYPASSRLS/NOCREATEDB/NOCREATEROLE/NOINHERIT 约束。安装者还须通过 `PostgresBudgetLedger.createProject` 建立项目预算；每次大纲是一份 reservation，不在运行中扩大上限。数据、任务和认证使用独立连接池。API 按真实会话 tenant/project grant 读写；模型 preset 和 worker 另外固定部署 project，配置 tenant 必须与认证 tenant 匹配。

## 配置与启动

只使用文件秘密，不把密码、token 或完整配置放在请求或命令参数中：

| 环境变量 | 含义 |
| --- | --- |
| `CAMERY_TENANT_ID` | 现有认证 tenant |
| `CAMERY_OUTLINE_PROJECT_ID` | 模型和 worker 的单一项目 |
| `CAMERY_OUTLINE_DATABASE_SECRET_FILE` | Compose 主机侧受限 data LOGIN URL 文件 |
| `CAMERY_OUTLINE_TASK_DATABASE_SECRET_FILE` | Compose 主机侧受限 task LOGIN URL 文件 |
| `CAMERY_OUTLINE_TEXT_CONFIG_SECRET_FILE` | 可选文本配置 JSON 文件 |
| `CAMERY_OUTLINE_TEXT_TOKEN_SECRET_FILE` | 与文本配置成对提供的 token 文件 |

沿用 `compose.api.yml` 的认证秘密和 loopback 端口。先验证组合配置：

```sh
docker compose --env-file deploy/.env.phase0 -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.outline.yml config --quiet
docker compose --env-file deploy/.env.phase0 -f deploy/compose.private.yml -f deploy/compose.api.yml -f deploy/compose.outline.yml up -d api outline-worker
```

完整配置类型与文件读取沿用既有 bounded secret reader：单文件 8KiB、环境在首个 await 前捕获、半配置失败闭合，错误不包含路径、URL 或 token。直接进程启动时用 `CAMERY_OUTLINE_ENABLED=1`，以 `CAMERY_OUTLINE_DATABASE_URL_FILE`、`CAMERY_OUTLINE_TASK_DATABASE_URL_FILE` 分别指向 data/task URL 文件。默认 worker ID 为 `outline-worker`，轮询 1000ms，每轮最多 20 个运行；显式覆盖限制为 50–60000ms、1–50 个运行。

准备真实模型时复制 [配置样例](outline-text.example.json) 并替换服务和模型字段，按项目预算设置 reservation/limits，可提供实际 pricing。样例无真实凭据，不证明模型能力或质量；私有网络和明文 HTTP 默认关闭。随后在上面命令追加 `-f deploy/compose.outline-text.yml` 并重新创建 API/worker。构造模型运行时和 session 均不发网络，实际未缓存的单次 decision 在预算分配后调用。

## 接口与恢复

接口前缀 `/api/v1/projects/:projectId/outlines`：`capabilities`、运行/简报列表、`sources?kind=development|bible`、单运行详情/status 为 `project:read`；写简报和 start 为 `task:run`；confirm/reject 为 `candidate:review`。请求不接 tenant/actor/time、执行画像、模型回执或授权谓词。来源选择只用于发现，start/人审由事务存储重新核验实际来源和当前性。

仅新 confirm POST 路由允许 2MiB body，输出仍独立限制 512KiB；旧路由和全局 16KiB 不变。ModelSession 输入 2MiB，传输请求额外预留 64KiB 固定 adapter/schema 封套；不改共享 transport 默认值。响应完整投影候选、人改结果、问题和审计，省略执行画像、回执和内部 Task 错误。正式采用 capability 保持 false。

GET 不创建任务、不调用模型。相同 start 重试必须使用原 run ID、简报修订和来源描述符；服务从实际原 run 取得 execution，核验同语义后沿用原日志，不因当前文本配置变化而替换画像。不同请求冲突，unknown、取消和失败终态不会用新任务 ID 自动重发。

不配置文本的 worker 仍可恢复已完成 decision 的原 journal，无需模型凭据。未缓存的新调用失败闭合，可能保留原已授权预算份额；终态后须由受信管理路径确认实际量再结算。unknown 保留占用并等待原始完整回执的明确对账。重设环境或重启不会重置任务、预算或人审。

worker 扫描全部运行，包括已审阅/过期但原日志尚未收尾的记录；停止时等待当前 attempt，再关闭池。SIGKILL 后依既有 lease 和 journal 恢复。API/worker 容器均非 root、只读根、drop ALL、no-new-privileges；最大模型请求及收尾使用 330s 停止宽限。

## 验证

```sh
pnpm --filter @camery/server test -- outline-http.test.ts outline-host.test.ts outline-config.test.ts outline-runtime.test.ts outline-task-role.test.ts
pnpm test:server:local --coverage
docker build -f deploy/Dockerfile.api -t camery-api:phase0 .
pnpm test:private-outline:local
pnpm check
```

PG 与覆盖率串行运行。顶层进程入口沿用既有 worker 的父进程覆盖率排除方式，由实际构建/子进程/镜像单独验证；API、host、config、runtime 全部保留 95% 门槛。镜像夹具只创建自己的随机租户、角色和 Compose project，使用明确合成模型 HTTP 响应，不能代替真实文本供应方推理、账单或真人质量签核。

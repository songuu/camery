# 私有化开发基础设施

基础档案提供 PostgreSQL 16 + pgvector；可选 API 和固定任务树 worker 档案已通过实际镜像验收。前端和媒体服务尚未编排，本档案不代表已经完成产品的一键部署。

2026-11-16已用当前冻结锁文件重建应用镜像，并在同一新镜像上通过API和worker两项真实Compose验收；先前npm元数据读取阻塞本轮已解除。镜像digest、输入摘要、旧镜像保留标签与测试边界见[本机镜像验收记录](../docs/validation/phase0-image-2026-11-16.md)。远端CI仍待与实际提交对应的结果。

API 使用 [认证骨架](../packages/server/README.md)，须单独配置租户和受限数据库 LOGIN；不会自动初始化业务成员或签发会话。

## 启动

1. 将 `deploy/.env.example` 复制为 `deploy/.env`。
2. 在本机编辑 `.env`，设置随机且足够长的 `CAMERY_POSTGRES_PASSWORD`；不要将该文件提交到仓库。
3. 从仓库根目录运行：

```sh
docker compose --env-file deploy/.env -f deploy/compose.private.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.private.yml up -d postgres
docker compose --env-file deploy/.env -f deploy/compose.private.yml ps
docker compose --env-file deploy/.env -f deploy/compose.private.yml exec postgres psql -U camery_admin -d camery -c "SELECT extname FROM pg_extension WHERE extname = 'vector';"
```

以上命令适用于 POSIX shell 和 PowerShell。如果修改了初始化用户或库名，扩展检查的 `-U`、`-d` 参数也要同步。

健康状态必须为 `healthy`，且 SQL 返回 `vector`，才能声称数据库已可用。`config --quiet` 仅验证配置展开，不验证 Docker 引擎、镜像下载或数据库启动。

默认端口只绑定回环地址。`camery_admin` 是初始化管理员，API 和 worker 分别使用独立的受限 LOGIN；不要将初始化管理员直接作为运行身份。

## 可选认证 API

1. 安装者先显式执行 [认证迁移与成员初始化](../packages/access/POSTGRES.md)，创建独立运行 LOGIN，授予三张认证表的 SELECT 和会话 `revoked_at` 列 UPDATE。安装身份、成员/会话签发与运行身份分开；发行安装器尚未实现。
2. 复制 `deploy/.env.api.example` 为本机 `deploy/.env.api`，填写部署租户、回环发布端口和数据库 URL 文件路径。
3. 在被 Git 和构建上下文排除的 `deploy/secrets/` 保存运行身份 URL，容器内数据库地址为 `postgres:5432`，特殊字符按 URL 编码。文件内容是一行 URL，可带一个尾换行，最大 8 KiB。不要把初始化管理员 URL、原始会话令牌或密码写入镜像参数/Compose 环境。
4. 保护宿主凭据目录；容器 UID 1000 必须能读取挂载文件。Linux 的文件来源 Compose secret 不会代设 uid/gid，可用私有 0700 父目录保护宿主访问，并给文件容器所需的读取权限；Windows 按本机 ACL 保护目录。不要依赖 secret 声明自动修改宿主文件权限。

```sh
docker compose --env-file deploy/.env --env-file deploy/.env.api -f deploy/compose.private.yml -f deploy/compose.api.yml build api
docker compose --env-file deploy/.env --env-file deploy/.env.api -f deploy/compose.private.yml -f deploy/compose.api.yml up -d --wait api
docker compose --env-file deploy/.env --env-file deploy/.env.api -f deploy/compose.private.yml -f deploy/compose.api.yml ps
docker compose --env-file deploy/.env --env-file deploy/.env.api -f deploy/compose.private.yml -f deploy/compose.api.yml stop api
```

API 镜像固定已验证 Node 24.22.2 bookworm-slim 摘要，构建读取冻结 pnpm 锁文件，运行时仅保留原生 JS bundle 和第三方生产依赖，不依赖 tsx 或工作区源码。以 UID 1000、只读根文件系统、capabilities 全移除和禁止提权运行。容器内监听 `0.0.0.0:3000`，宿主只发布到 `127.0.0.1`；反向代理和 TLS 尚未验收。

`/health` 只表示 API 进程存活；Compose 的数据库依赖检查仅控制启动顺序，不代表后续数据库始终可用。认证仍逐请求验证会话和角色；错误不回显连接串。停止时接收 SIGTERM、排空应用并独立关闭数据库池。

`pnpm test:private-api:local` 在已有 `camery-phase0` 本地数据库/网络和已构建 `camery-api:phase0` 镜像上进行真实验收：创建临时受限 LOGIN 与文件 secret，启动唯一临时 API 项目，检查认证/跨项目拒绝、退出及重启后的撤销、日志脱敏、只读/非 root 配置和正常停止退出码。测试重读动态发布端口；只清理自己的容器、空卷、租户/角色与临时文件，不重启现有数据库。CI 已加入相同构建和容器验收步骤，远端结果仍以实际 workflow 为准。

## 可选固定任务树 worker

worker 使用同一 `camery-api:phase0` 应用镜像的 `node worker.mjs` 入口，不公开网络端口。它只注册阶段 0 章节制片工作流，按显式租户、项目和任务树调度；完整多树/多角色服务和业务 HTTP 调度/审阅入口仍待接入。

安装者需先显式迁移 durable/agents schema，按 [worker 身份说明](../packages/server/WORKER-POSTGRES.md) 授予独立 LOGIN，并通过受信宿主预创建项目预算与任务树。使用 [章节 worker](../packages/server/README.md) 加载出的派生制片 pin 和固定路线；方法 pin 随该身份锁定。项目预算至少能预留 8 steps、0 tokens、0 cost micros（CNY）。worker 不自建项目、签发身份、修改限额或自动确认结算。

复制 `deploy/.env.worker.example` 为本机 `deploy/.env.worker`，填写三个作用域身份、worker ID 和受保护的 worker URL 文件。凭据文件要求与 API 相同；worker 账号不拥有认证表权限，也不应使用 API 或安装账号。该身份必须没有任何其他角色成员关系，受保护 schema 不得由其拥有或授予 CREATE；直接授权及运行检查由专用 helper 提供。

```sh
docker compose --env-file deploy/.env --env-file deploy/.env.worker -f deploy/compose.private.yml -f deploy/compose.worker.yml build worker
docker compose --env-file deploy/.env --env-file deploy/.env.worker -f deploy/compose.private.yml -f deploy/compose.worker.yml up -d worker
docker compose --env-file deploy/.env --env-file deploy/.env.worker -f deploy/compose.private.yml -f deploy/compose.worker.yml ps
docker compose --env-file deploy/.env --env-file deploy/.env.worker -f deploy/compose.private.yml -f deploy/compose.worker.yml stop worker
```

进程运行直到单树完成、blocked 或收到停止信号；完成/blocked 正常结束，结果以数据库状态为准，初始化/基础设施异常退出 1，Compose 对失败最多重启三次。停止不取消业务任务，不清空人工闸门或预算。候选等待 `producer.review` 信号，信号须来自已授权的宿主；本档案不提供匿名 HTTP 审批入口。预留在终态后仍 held，按原确认协议由受信宿主结算。

`pnpm test:private-worker:local` 使用现有本地 PG 网络和已构建镜像，验证实际章节方法、人工闸门、正常 SIGTERM 停止、SIGKILL 后新进程恢复、单份预算/方法日志、输出契约与较早无关任务未领取。探针仅为明确观察崩溃边界关闭自身临时 worker 的自动重启；发布档案仍保留有界失败重启策略。它不声称新增“容器在工具执行中途被杀”的证据；执行中故障注入仍由既有 durable/Agent 进程测试证明。

API 与 worker 都采用非 root、只读根目录、capabilities 全移除和禁止提权。worker 无专门健康端点；容器显示 running 仅表示进程存在，业务进展应查任务日志/闸门状态，不把 `up` 返回当作工作已成功完成。

## 数据与停止

- PostgreSQL 使用 Compose 命名卷 `postgres-data`；初始化脚本仅在空数据目录首次启动时执行。
- 普通停止：`docker compose --env-file deploy/.env -f deploy/compose.private.yml down`。命名卷保留；更改 `.env` 的初始化密码不会自动修改已有数据库账户。
- 当前使用上游 `pgvector/pgvector:pg16` 标签；发布镜像前需要锁定验证过的 digest，并完成备份/恢复测试。
- T0.1 后续的应用/媒体服务将挂载本地磁盘或 NAS；本档案暂不创建未被服务使用的媒体卷。S3 兼容存储在应用存储抽象落地时接入。
- 离线安装包、迁移、备份/恢复、完整服务健康检查属于后续阶段 0/发行任务，当前未完成。

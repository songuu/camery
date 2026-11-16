# 会话与成员存储

`@camery/access/node` 为阶段 0 单租户 API 提供 PostgreSQL 认证存储。`tenantId` 由受信任部署配置确定；用户、会话和项目成员查询均包含租户键。项目角色每次鉴权从数据库读取，角色降级、删除成员、禁用用户和撤销会话不会等待进程缓存失效。

## 安装与运行身份

安装者显式调用 `migrateAccess(adminPool)`，之后使用独立的受限运行身份。迁移使用事务级 advisory lock 和 SHA-256 历史校验；并发重复运行安全，已有迁移发生变化或出现未知版本会拒绝启动迁移。运行进程不自动迁移，不创建数据库角色。

以下权限由部署安装者授予实际应用角色；示例 `camery_api` 仅表示角色名，不包含密码或可用凭据：

```sql
GRANT USAGE ON SCHEMA camery_access TO camery_api;
GRANT SELECT ON camery_access.users, camery_access.memberships,
  camery_access.sessions TO camery_api;
GRANT UPDATE(revoked_at) ON camery_access.sessions TO camery_api;
```

该角色应为独立的 `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`，没有数据库和 `public/camery_access/camery_durable/camery_agents` schema 的 CREATE 权限或所有权，也不拥有这些 schema 中的关系；尚未安装的其他模块 schema 不要求存在。`verifyRuntimeRole(pool)` 检查 `session_user=current_user`，拒绝管理员连接切换角色的伪降权，并保守拒绝任何其他角色的 `MEMBER` 身份，涵盖 `SET FALSE` 下的 ADMIN/INHERIT 能力。仅禁止 SET ROLE 不能排除继承服务器能力或管理角色成员关系，因此本运行配置使用直接授权、无组成员身份的独立 LOGIN。它还检查必要读权限和列级撤销权限；拒绝管理员、缺少权限及可修改身份、角色或签发会话的运行身份。检查失败不返回连接串、SQL 参数或 PostgreSQL 原始错误。

这是服务端最小权限边界，**不是面向不可信数据库客户的 RLS 隔离**。受限角色仍可通过 SQL 读取认证表；数据库连接只能由内部应用持有。用户和请求不能获得连接凭据或直接运行 SQL。单租户配置之外的业务存储、数据库网络策略、TLS 与生产部署仍需各自验收。

## 身份操作

- `provisionMember({tenantId,userId,projectId,role})` 仅用于受信任安装/管理入口，事务写入用户及项目角色。已有禁用用户不会因增加成员身份而重新启用。支持 `viewer/editor/reviewer/admin`，角色语义由纯权限内核确定；项目管理员不自动获得其他项目或租户权限。
- `setUserEnabled(tenantId,userId,enabled)` 仅用于受信任管理入口。禁用期间所有会话鉴权失败；重新启用会恢复尚未过期、未撤销的会话。如需永久退出，应另外撤销对应会话。
- `createSession({tenantId,userId,sessionId,tokenHash,ttlSeconds})` 仅用于受信任签发器；要求已存在且启用的用户，寿命为 60–86400 秒。只接受 64 位小写 SHA-256 哈希，数据库从不接收或保存原始 bearer token。哈希全局唯一，拒绝跨租户复用同一凭据。
- `lookup(tenantId,tokenHash)` 用数据库时钟检查过期、撤销和用户启用状态，以单条 SQL 读取当前项目角色，返回身份中不含令牌哈希。
- `revoke(tenantId,sessionId,userId)` 只能匹配完整身份，重复撤销安全，不报告其他租户或用户是否存在。HTTP 调用者需由 `AccessService` 先验证身份。

运行身份不能调用前三项管理操作。运行身份的 SQL 列级 UPDATE 权限仅用于应用内撤销实现；它不是只允许单向修改的数据库能力令牌，不能把这种数据库连接暴露给用户。

## 验证

`pnpm test:access:local --coverage` 使用本机忽略的测试配置连接 PostgreSQL，不打印凭据。测试覆盖新连接读取持久身份、撤销/过期/禁用、即时角色变化、租户隔离、重复哈希拒绝、迁移并发/历史篡改、SQL 注入输入拒绝、连接错误脱敏和失败连接释放。

最小权限测试创建临时 `LOGIN` 角色和内存中随机密码，以独立凭据建立连接；通过 SQL 核对 `session_user=current_user` 和 `rolsuper=false`。该角色实际成功鉴权和撤销，实际拒绝创建表、迁移、签发会话、修改成员和禁用用户。启动检查另拒绝管理员连接加 `-c role`、全表 UPDATE、SET FALSE 下的 ADMIN/INHERIT 成员，以及受保护 schema 的 CREATE。schema 所有权使用目录谓词检查，不通过转移现有 schema 所有者或执行 DROP 进行测试。测试结束仅清理自己的用户、会话、成员及临时角色，不打印或保存密码。该测试不代表生产角色或生产数据库已部署。

# Worker 数据库运行身份

章节制片 worker 使用独立 `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`，不能复用初始化管理员或 API 的认证角色。安装者显式运行 durable/agents 迁移，创建项目预算与任务树，再调用 `grantWorkerRuntimeRole(adminPool, role)` 授权。worker 启动只调用 `verifyWorkerRuntimeRole(workerPool)`；不会创建角色、迁移、初始化项目或签发凭据。

授权 helper 只接受 1–63 字节的小写字母开头、字母/数字/下划线角色名，使用固定 schema/表/列语句，在事务中一次授予。失败回滚；回滚失败的连接会被丢弃。查询、回滚或释放异常均归一化，不携带 SQL 参数、密码、连接串或原始 cause。它不撤销目标角色已有权限，已有超额权限会被启动检查拒绝；安装者应使用新建专用角色。

## 固定能力

| 表 | 读取/追加 | 可更新列 |
|---|---|---|
| `camery_durable.tasks` | SELECT、INSERT | status、attempts、fence、owner、lease_until、available_at、failure_count、error、updated_at、output |
| `camery_durable.steps` | SELECT、INSERT | status、error、output、updated_at |
| `camery_durable.signals` | SELECT、INSERT | 无 |
| `camery_durable.events` | SELECT、INSERT | 无 |
| `camery_agents.agent_projects` | SELECT | project_id，仅供行锁 |
| `camery_agents.agent_trees` | SELECT | 无 |
| `camery_agents.agent_tasks` | SELECT | durable_task_id、job、revision、record |
| `camery_agents.agent_outbox` | SELECT、INSERT | last_selected_at、delivered |
| `camery_agents.agent_events` | INSERT | 无 |
| `camery_agents.budget_projects` | SELECT | project_id，仅供行锁 |
| `camery_agents.budget_allocations` | SELECT、INSERT | allocation_id，仅供行锁 |
| `camery_agents.budget_events` | INSERT | 无 |

PostgreSQL 的 `SELECT … FOR UPDATE` 需要至少一个列的 UPDATE 权限，因此项目和分配表保留最小标识列锁能力；运行代码不修改这些标识。角色不能更新项目 limit/currency/definition，不能更新预留、分配状态或结算回执，也没有 INSERT 项目预算/树定义的权限。预算和任务初始化、人工结算由另一个受信任应用/安装身份完成。

当前事件/命令 ID 为 `GENERATED ALWAYS AS IDENTITY`。真实运行已验证追加不需要单独授予序列权限，worker 不直接调用序列函数；启动检查拒绝直接 USAGE/SELECT/UPDATE 序列权限。角色不能 UPDATE/DELETE 既有事件，也不能变更 durable 输入、工作流、版本或步骤指纹。

## 启动拒绝条件

检查使用当前数据库目录中的实际有效权限，包含继承权限和 PUBLIC 权限，拒绝缺少权限和超额权限：

- 管理员、BYPASSRLS、CREATEDB/CREATEROLE、非独立登录、`session_user != current_user`、任何其他角色的 MEMBER 身份。不只检查 SET ROLE；即使 SET FALSE，ADMIN 或 INHERIT 能力也不属于这个固定服务身份。
- 数据库或 public/durable/agents/access schema 的 CREATE 能力，以及这些受保护 schema 的所有权；即使 schema owner 撤销了自己的 CREATE ACL，仍不能作为运行身份。另拒模块表/序列所有权、grant option。
- 全表 UPDATE、任何 DELETE/TRUNCATE/REFERENCES/TRIGGER、矩阵之外的列权限。
- 认证表和迁移表的直接权限，包括仅对单列授予 SELECT、即使认证 schema 暂无 USAGE。
- 缺少必要表或列、缺少声明的读写能力。认证 schema 可以尚不存在；目录查询按 OID 检查，不对不存在的认证表调用权限函数。

这些是内部服务能力约束，**不是不可信数据库客户的 RLS 隔离**。连接可以访问对应模块中的多租户数据，应用仍必须按部署租户/项目/任务树校验、使用参数化查询和既有 fence/版本约束。数据库 URL 只能通过受保护的运行配置交给内部 worker，不对用户或来源材料开放。信号表写权限也不等于人工审批授权；应用只应投递受信任、已验证作用域的命令。

## 本地证据

`pnpm test:server:local --coverage` 包含 `worker-role.integration.test.ts`。测试使用忽略的本机数据库配置，临时创建独立 LOGIN 和内存随机密码，核对真实 `session_user=current_user`，从实际授权连接执行：

- AgentDispatchHost 解锁/投递 → DurableWorker 领取 → 项目预算持久分配 → 候选步骤 → 闸门/信号 → 任务状态同步。
- 真实拒绝预算上限修改、结算状态修改、认证读取和应用 schema 中建表。
- 拒绝缺权限、不可变输入修改、全表 UPDATE、grant option、认证单列读取、迁移表读取、序列授权、认证 schema CREATE、管理员/伪降权，以及 SET TRUE 或 SET FALSE 下的 ADMIN/INHERIT 成员身份。成员负测只用新建无危险权限组，不授予预定义服务器角色。
- 受保护 schema 所有权的目录条件静态核对，并模拟目录拒绝结果；测试不转移现有共享 schema 的所有者，也不执行 DROP schema、文件读取或服务器程序。
- 安装非法角色名在访问 pool 前拒绝；驱动、回滚和释放失败不会泄漏原始诊断。

测试只清理自己的随机租户、角色及项目数据，逐项尝试资源清理，不输出数据库 URL 或密码。这个结果证明本地受限身份可运行指定调用链，不代表生产账号或网络策略已经部署。权限语义依据 [PostgreSQL 16 GRANT](https://www.postgresql.org/docs/16/sql-grant.html)；表级撤销同时撤销相应列授权，见 [REVOKE](https://www.postgresql.org/docs/16/sql-revoke.html)。

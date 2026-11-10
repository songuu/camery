# ADR-003：PostgreSQL 16、pgvector 与 Drizzle

日期：2026-11-10。状态：**设计决策已确认，实施按任务验收**。

## 背景与决策

来源、剧本、锚点、素材和取用之间存在大量关系引用，长文本与镜头卡还需要检索。按照 [实施计划 v2.1 第 2 章](../plan/implementation_plan_v2.md)，采用 PostgreSQL 16 + pgvector，使用 Drizzle ORM。

PostgreSQL 保存正式业务状态、版本和执行记录。向量检索服务于按任务取上下文，不取代关系约束、来源定位或权限检查。

## 代价与边界

需要管理数据库迁移、扩展安装、索引和备份恢复。向量召回质量需要评测，不能因扩展可用就声称语义检索正确。ORM 类型不能替代数据库中的事务与并发约束。

## 实施与验证条件

- T0.1：私有化基础设施能启动 PostgreSQL 16，健康检查通过，目标库可查询 pgvector 扩展。
- T0.5、T0.6：版本冲突、步骤持久化、租约竞争在真实 PostgreSQL 中验证；schema 迁移可重复执行并记录版本。
- T0.10 及后续业务模块：查询按 tenant_id 隔离，跨租户负向测试通过；使用应用最小权限身份而非初始化管理员。
- 发行验收：数据库与素材备份可恢复，失败迁移可按既定流程回滚。

关联：[ADR-005](005-postgres-durable-execution.md)、[ADR-006](006-ir-and-versioning.md)、[ADR-016](016-private-distribution.md)。

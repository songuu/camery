# 版本域 PostgreSQL 接入

`@camery/versioning/node` 是纯域库之外的内部服务端适配器，使用既定的 PostgreSQL 16、Drizzle 和 `pg`。数据库保存正式状态；调用方只能初始化受信已采用基线或提交 ChangeSet，没有 `save(clientVersionState)` 或整包覆盖接口。

## 验证

```sh
pnpm --filter @camery/versioning typecheck
pnpm --filter @camery/versioning test
pnpm test:versioning:local --coverage
```

最后一条命令复用本机 `camery-phase0` 的忽略凭据文件与动态回环端口。没有该环境时，准备专用测试库，通过环境注入 `CAMERY_TEST_DATABASE_URL`，再运行：

```sh
pnpm --filter @camery/versioning test:integration --coverage
```

缺 URL 明确失败，不跳过。集成命令包括纯域测试并覆盖全部 Node/域源码；语句、分支、函数、行各 ≥95%。普通 `pnpm check` 只跑无数据库部分，不证明存储验收。测试保留随机租户数据，故障触发器仅作用于该测试租户/项目，结束后移除；不要将测试命令指向生产库。CI 已配置必跑真实数据库验收，远端运行结果尚未验证。

## 接口

```ts
import { Pool } from 'pg';
import { migrateVersioning, PostgresVersionStore } from '@camery/versioning/node';

const pool = new Pool({ connectionString: process.env.CAMERY_DATABASE_URL });
await migrateVersioning(pool); // 部署时显式调用，生产迁移身份与运行身份应分开。
const store = new PostgresVersionStore(pool);
// key 的 tenantId/projectId 为规范 ULID，必须来自受信宿主上下文。
// 已授权导入的 adoptedBaseline、变更 request 和真实权限策略由宿主提供。
await store.initialize(key, adoptedBaseline);
const candidate = await store.submit(key, request, { newId: allocateUlid });
const result = await store.adopt(key, request.id, {
  actor: authenticatedUser,
  scope: reviewedScope,
  at: new Date().toISOString(),
  authorize: (actor, actualProject, scope) => trustedGrant(actor, actualProject, scope),
});
```

示例中的 `key`、基线、request、分配器和权限函数是宿主依赖，不是可直接执行的完整应用。库不会创建或关闭调用方的 Pool。根入口 `@camery/versioning` 保持纯域，不引入 Node/数据库执行。

| 方法 | 行为 |
|---|---|
| `initialize(key, adoptedSnapshot)` | 仅初始化匹配 projectId 的合法已采用基线；相同基线幂等，其他基线或 package 身份复用拒绝；不会重置已有 head |
| `read(key)` | 在 repeatable-read、read-only 事务中读取同一数据库快照的正式 head、候选、对象历史与采用记录；无项目返回 null |
| `submit(key, request, options?)` | 保存候选及预览分配的身份，保持正式 head 不变；复用纯域冲突、锁和引用检查 |
| `adopt(key, changeId, options)` | 项目行锁内读取最新状态、重新授权和求值；成功后完整提交正式快照、历史、候选决定和采用记录 |
| `adoptGuarded(key, changeId, options, guard)` | 同一 READ COMMITTED 连接先执行受信来源 guard，再锁版本项目行并采用；guard 使用传入 PoolClient，不自行开启或提交事务 |
| `reject(key, changeId, options, reason)` | 记录人工拒绝及理由，保持正式 head 和对象历史不变 |

修改返回 `PersistedChangeResult`，含原领域结果和 `writeVersion`。Promise 仅在数据库 COMMIT 成功后返回；数据库失败或 CAS 不满足会抛错，不能用先算出的结果对外宣称成功。领域拒绝/冲突需同时检查 `status` 与 `issues`；未改变状态的拒绝和幂等调用不会增加写入序号。`read`/`initialize` 返回 `{ state, writeVersion }`。

提交的`PersistedSubmitOptions`及采用/拒绝的`PersistedAdoptOptions`可携带`expectation={expectedSnapshotRevision,expectedWriteVersion}`。两个值必须是正安全整数，且只能包含这两个普通数据字段；访问器、未知字段和非有限数在数据库访问前以`INVALID_EXPECTATION`拒绝。适配器异步前捕获期望，在同一项目`FOR UPDATE`锁内核对，快照不符抛`SNAPSHOT_STALE`，写序号不符抛`WRITE_VERSION_CONFLICT`，失败不写任何版本表。省略expectation保持旧调用语义。

同一规范ChangeSet已存储时，精确提交重试可先找回原请求结果；同ID异内容不能绕过CAS。实际已采用的ACK也可恢复，仍由原引擎重新检查当前人类授权与范围，不因旧期望重复采用。guarded采用维持来源锁先于版本行锁，CAS不会提前反向取锁。拒绝没有这种CAS豁免：旧拒绝记录未固定完整原始请求范围，完整幂等回执须由后续持久application intent实现，不能仅凭同changeId和理由推断。

## 事务与历史

`adoptGuarded` 用于跨域来源仍须最新的正式采用。来源锁必须在版本行锁之前取得，例如原创开发采用中的 brief→排序 run；两个独立连接持锁不能代替同一事务，因为来源连接断开可能先释放锁。Node 适配器管理 checkout error listener、断连故障标记与连接销毁，guard/数据库错误会整体回滚。guard 只能由宿主构造，不能来自请求 JSON，也不应调用模型或在该连接上开始嵌套事务。

同 ChangeSet 已 adopted 时仍重新授权，允许来源后来变化后的响应恢复。并发请求先读到 candidate、等待来源锁期间另一请求已采用，随后被明确 `ADOPTION_SOURCE_*` 拒绝时，仅在健康连接成功回滚并释放后，再用一次新事务核对实际 adopted 权威并重新授权；不重跑 guard、不采用尚未采用的候选，也不吞数据库/COMMIT错误。完整服务仍须先验证持久 intent 与 ChangeSet 的语义绑定，库级恢复不能替代该业务边界。

- 固定 schema 为 `camery_versioning`。projects 保存正式 head 指针、初始修订和写入序号；snapshots 保存每次正式快照；changes、object_revisions、adoptions 分别保存候选决定、对象链/删除记录和人工采用记录。复合主外键都包含 tenantId/projectId。
- 修改事务先 `FOR UPDATE` 锁项目行，再从最新数据库内容调用版本内核；不同对象可重放到新 head，同一对象基版本变化报冲突。最终 UPDATE 同时比较原 head 修订与 writeVersion，影响行数不是 1 就回滚。
- head 修订只在正式采用时增加；writeVersion 对候选或决定的实际存储变化同样增加。二者不能混用为客户端对象基版本。
- 已采用快照、对象历史和采用记录通过此 API 只追加；候选记录可更新决定，但原 request 不可更换。发生任何 SQL/完整性/提交失败，候选状态、正式快照、历史和采用记录一起回滚。
- `initialize` 的基线保留导入对象版本，不虚构导入前父链。以后再次传入同一初始基线会返回当前数据库状态，不能覆盖已经采用的新内容。
- 输入、key 和授权元数据在等待数据库前捕获；授权函数拿到冻结的实际租户/项目及主体/范围。候选拆并生成的 ID 在采用时复用，不在重试时重新抽取另一批身份。
- 迁移显式执行，以事务级 advisory lock、版本和 checksum 管理；应用过的迁移被修改或出现未知版本时拒绝。SQL 迁移由仓库 LF 规则保护跨平台 checksum。

数据库异常只暴露操作、项目和安全 SQLSTATE，不附带 Drizzle 的查询参数；领域错误保留原错误码。读取会验证正式快照结构与身份；历史表是受信数据库内容，当前不是数据库管理员篡改或介质损坏的完整取证恢复器。

## 受信宿主与剩余边界

此接口没有公网端点、会话认证、RLS 或 RBAC 查询。调用方必须先取得真实身份、最新权限与租户上下文；`authorize` 必须同步明确返回 true，返回 Promise、拒绝或抛错均不授权。误传 Promise 时会观察其拒绝，避免未处理拒绝导致进程退出；不会等待后改判为授权。不能把客户端自报的 tenantId/actorId 或“我有权限”当作授权；完整返回的项目状态也需要宿主按读取权限过滤后再给客户端。

基线初始化仅供已有授权的导入/恢复流程，不能作为 Agent 或客户端直接采用内容的入口。迁移需要 DDL 权限，运行角色的最小权限与正式认证仍由 T0.10 完成；数据库管理员不作为未来业务应用身份。

本地验收覆盖并发候选、同对象竞争/不同对象重放、幂等、租户隔离、授权拒绝、删除历史、拆并引用与 ID、事务故障回滚、CAS、输入捕获和迁移历史。大项目性能尚未验收：当前对象历史逐行 INSERT，项目锁持有期间有多次数据库往返；服务接入前需批量写入和压测。常驻服务、Agent/模型连接器、生产权限及备份恢复仍待后续任务。

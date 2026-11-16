# 原创开发追加存储与阶段执行

`@camery/script/node`提供`PostgresDevelopmentStore`、`PostgresDevelopmentCatalog`、显式迁移/最小角色检查，以及`createDevelopmentStageWorkflow`和`enqueueNextDevelopmentTask`。这不启动常驻进程，不启用HTTP或UI，也不采用正式IR。

## 安装边界

受信installer显式运行`migrateDevelopment(pool)`，目前为0001四表与目录索引、0002创意外键引用侧索引。已登记版本必须连续且checksum逐项相同；未知版本、缺口或改写均拒绝，事务失败回滚。0001不会因补索引被重写。运行服务只校验，不迁移或扩权；回退代码不删除历史记录。

installer创建独立`LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`身份，再调用`grantDevelopmentRuntimeRole`。其权限仅为`camery_script` USAGE和briefs/runs/candidates/reviews SELECT、INSERT。`verifyDevelopmentRuntimeRole`拒绝额外非系统表/列/序列、schema创建/所有权/USAGE转授权、表列转授权、数据库CREATE、角色成员及身份提升能力。不能把该受信服务账号交给终端用户。

认证、开发数据、任务/预算必须分池；任务/预算池使用既有durable四表与budget三表的最小权限，installer预先创建项目预算。数据池不读认证/任务/预算表。未来HTTP宿主从principal注入tenant/project/actor，不能把请求中的审核快照或授权当事实。

## 数据与重试

| 操作 | 结果与边界 |
|---|---|
| `putBrief({...idea,episodeCount,targetSeconds,expectedRevision,actorId})` | 在brief锁下追加revision+1。完整快照≤8KiB，写入作者与DB时点分开保存；同目标修订/同内容/同作者重试返回原记录，不因后续已追加而重写 |
| `getBrief({tenantId,projectId,briefId,revision?})` | 读明确历史或最新修订；完整校验作用域、摘要、作者和时间 |
| `start({...key,briefId,expectedRevision,expectedBriefDigest,methods,execution})` | 首写固定最新brief、两阶段方法pin和模型/价格/预留/总上限；同语义runId重试返回原run，即使最新brief已改变。重做使用新runId |
| `read(key)` | 从固定brief重建run、原始候选和独立人工编辑审计，验证阶段、模型tuple、原始请求/输出摘要、durable callId、审阅引用与全部内容；自报digest不构成审核授权 |
| `saveCandidate(key,candidate)` | 每阶段首个原始结果追加；同digest幂等，不同结果冲突。episodes必须关联本run实际存储的reviewed foundation。已付旧brief结果允许保留，不代表新版本可继续 |
| `review(key,stage,{candidateDigest,output},host)` | 真实host重新授权，锁顺序brief→run，首次提交核对最新brief；原模型输出不改写。已提交同作者/同语义重试重新授权后只读原审计，返回原时间 |
| `reject(key,stage,reason,host)` | 可明确拒绝历史候选，仍需真实宿主权限。每阶段首次review/reject胜出，不允许覆盖旧审计 |

每个存储入口在数据库等待前捕获数据与宿主身份，关闭异常、回滚失败和驱动详情均脱敏。不同运行共享的锁始终brief先于run；仅保存原始结果的run事务不会再反向获取brief锁。

## 任务恢复

固定`original.development-stage@1`，每阶段独立Task与原始`agent.0.decision`回执。队列仅放project/run/stage/runDigest/upstreamDigest引用，不把完整创意/候选塞进任务input。模型会话来自可信宿主工厂，构造时不请求模型；完整执行身份必须匹配run。当前方法固定balanced，客户端不能提供模型URL或密钥。

开始时用BigInt检查两份reservation不超过run limits；每阶段先通过既有预算账本预留一份，再由AgentRuntime计量。上限不是供应方账单硬承诺，unknown usage不伪填；终态分配仍由受信管理员显式结算，不自动释放或冒充实际费用。

新外部执行前检查最新brief；已缓存的付费decision不重新检查后丢弃，继续访问同一journal并保存旧快照结果。已经存档的candidate通过原output/receipt只读重建完整budget/bind/decision/persist步骤，不重新请求模型，也不能跳过尾日志提前finish。

调度器先用`durable.get`检查同一deterministic任务的物理状态，再处理待审阅/已审阅/过期业务状态。这样保存丢确认、显式对账后的旧brief任务仍能排空原journal。`queued/running/waiting`由宿主精确`runTask`处理；`reconciling`必须等待operator完整回执对账，不自动重发；失败/取消不换ID自动重试。后续常驻宿主也必须扫描未排空的durable引用，不能只用业务`pendingOnly`目录跳过已审阅运行的物理尾部。

目录只读有界元信息，每页20，时间游标保留PG微秒并绑定tenant/project/filter；排序与C collation索引一致。`sourceChanged`是目录提示，确认时仍做完整新鲜度校验，不能用列表摘要代替可信候选/审计重建。

```sh
pnpm --filter @camery/script test:coverage
pnpm test:script:local -- --coverage
pnpm check
```

这些验证仅在显式本机测试DB安装schema并清理随机自有租户/角色。最小角色验证还拒绝REPLICATION集群能力；真实PG先红复现该身份可越过旧检查，再验证修复，角色能力探针共24项。真实文本供应方、语义质量与人工评分仍待配置；协议夹具、PG恢复和阶段审阅不证明正式IR采用或真实模型质量。认证应用、可编辑工作台与正式开发对象的ChangeSet接线按完整阶段1计划继续。

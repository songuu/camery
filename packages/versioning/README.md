# @camery/versioning · 版本域核心

T0.5 的纯域库：候选提交、对象基版本冲突、字段/对象锁、人工采用与拒绝、版本链和拆并引用联动。复用 `@camery/ir` 与 `@camery/timeline`，不执行数据库、文件、网络或模型副作用。

```sh
pnpm --filter @camery/versioning test
pnpm --filter @camery/versioning test:coverage
pnpm --filter @camery/versioning typecheck
```

## 集成顺序

1. `createVersionState(adoptedSnapshot)` 从受信存储中的已采用快照建立基线。导入版本的父版本为 null，不伪造导入前历史；迁移输出的 candidate 不能直接充当已采用基线。
2. `submitChangeSet(state, request, { newId })` 校验并保存候选决定，返回的新 state 保持 `head` 不变。成功候选的 `preview` 供差异审阅，不能直接替换正式内容。
3. `adoptChangeSet(state, changeId, options)` 从当前 head 重新求值，核对人工身份、宿主授权、作用域、锁及全部基版本，成功后返回新的 head、ObjectRevision 和 AdoptionRecord。
4. `rejectChangeSet(state, changeId, options, reason)` 只记录此候选的人工拒绝，不回滚 head。其作用域来自候选原影响对象与提交时的历史归属证据；内容已被另一候选实现或对象已被删除，都不能免除权限检查。

`options` 要求受信宿主提供 `actor`、场/集/项目 `scope`、规范 UTC `at` 和同步 `authorize` 回调。Agent 身份、缺少授权、授权服务抛错或返回非 true 均拒绝。锁操作的实际采用者还必须与人类锁请求作者一致；解锁校验锁所有者。

这些参数必须由认证后的服务构造，**不能从请求 JSON 中读取“我是用户”的自报信息作为身份或授权**。本库没有实现会话认证、RBAC、租户查询过滤或网络端点，不能单独作为对外授权边界。候选的 request 是保留的原始声明，真实采用者另记在 AdoptionRecord。

## 并发、历史与不可变性

- `base_revisions` 包含每个写对象，以及调用方实际读取的上下文依赖。显式与自动联动的已有对象写入都必须有基版本；读取依赖变动同样导致 conflicted。
- 快照 `base_revision` 用于来源/未来版本校验。快照落后但全部相关对象未变化时，可在当前 head 上重放候选，保留别处已采用的修改；不能用旧 preview 覆盖整包。
- 一个 ChangeSet 内，多次改同一对象只增加一次对象版本；正式采用只增加一次快照修订。删除记录 tombstone。`snapshot_revision` 绑定对象历史与同一提交时点，供审计及历史作用域证明。
- 相同 ChangeSet ID 和相同规范 JSON 请求可重复提交，重复采用不追加历史；相同 ID 不同内容拒绝。当前/历史内容 ID、嵌套位置 ID 与 ChangeSet ID 不得复用，位置也不能换父地点冒充同一实体。
- 输入不被修改；任一操作、引用、锁或最终 IR 检查失败时，不产生部分 head。返回 `status` 和 issues 是结果依据，不能只看到 state/preview 非空就认为已采用。

当前状态是内存中的领域值。生产接入必须由 T0.6/服务层在事务中读取最新 state、重新授权和计算、以 head 修订作并发条件写入全部对象/历史/决定，事务提交后才能对外报告采用成功。不能把本库返回的新值当作数据库已经提交的证据。

## 操作与锁

IR 提供 `add / update / replace / remove / move / split / merge / lock / unlock / unlock_line`。`update` 是受校验的字段替换；`replace` 要提供完整对象并保留原身份/版本；版本由引擎统一递增。`move.before_id` 是同场/同版本中的稳定镜头 ID，null 表示末尾。

`lock.fields=[]` 锁整个内容对象，非空时使用存在的字段路径，例如 `camera.movement`。父子路径均参与保护，不能靠替换上层对象绕过。锁不能锁住锁元数据，也不能指向不存在的对象。只有显式人类请求能创建/释放锁；新台词不能通过 `add locked:true` 绕过锁操作。

`DialogueLine.locked` 保护台词文字。`unlock_line` 用于无显式文本锁的台词状态；已有显式锁必须先由所有者执行 `unlock`。所有步骤按顺序检查，不能先改字再在后面解锁。

## 拆并与素材

拆并复用时间线代数，联动关键帧位置、cue 起止锚点、素材取用和 lineage。仅跨切点的取用分配新 ID，预览时保存分配结果，采用时重用这些 ID。新增依赖导致分配或基版本条件变化时，要求重新提交候选，不重新抽取另一批身份后悄悄采用。

`newId` 是宿主提供的 ULID 分配器，不传时需要分配身份的操作会明确失败；调用方不应把分配器本身当作业务采用。普通 IEEE 舍入在绝对误差 ≤1ns 时保留 `TIME_ROUNDED` 诊断，超过范围或区间舍入成零则拒绝。关键帧、cue 和取用的自动变化仍接受基版本、锁与采用范围校验。

绑定已移除镜头的集末快照不能猜测重写；同一 ChangeSet 中需先明确删除或重算依赖快照。对于内容关联变化后仍不合法的候选，最终完整 IR 检查会拒绝，不能通过丢弃难处理数据来通过验收。

## 契约与剩余项

本轮将早期 v0.5 草稿的 `read_set` 明确改为 `base_revisions`，`move.order_key` 改为 `before_id`；当前草稿严格拒绝旧字段。锁现有自己的 version。更新后的 [ChangeSet JSON Schema](../ir/contracts/changeset.schema.json) 与 Zod 同源并受一致性测试约束。

库级采用、锁及历史行为已做本地测试和独立代码/安全审查。实际 PostgreSQL 持久化、进程故障恢复、真实用户/租户权限及 UI 工作流，仍需在 T0.6、T0.9、T0.10 和后续阶段逐项验收。T0.5 的库测试不替代阶段 0 整体验收。

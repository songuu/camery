# 持久化协作与审查

这是受信宿主库。租户、项目、角色、actor 和工作流路线由宿主授权后传入；库校验身份绑定和状态，不签发登录身份或对外暴露接口。所有写操作使用同一项目行锁，事务内不调用模型、工具或 durable API。迁移顺序见 [PostgreSQL 说明](POSTGRES.md)。

## 任务树与投递

PostgresCollaborationStore(pool, agents) 使用已有 AgentRegistry。createTree(definition, actorId) 固定 tenantId/projectId/treeId、初始 queued 任务树及 routes。每个 route 包含完整 agent pin、workflow/version/maxAttempts 和 outputKind（raw 或 agent_report）；路线与任务引用的角色集合必须一致。相同声明幂等，改变输入或路线拒绝。项目内逻辑 taskId 唯一，单个任务输入上限 1MiB。

queueReady(treeKey) 只为显式 dependencies 全部 succeeded 的 queued 任务产生 enqueue outbox；parentId 表达树关系，本身不隐含执行依赖。逻辑任务与物理 durable task 的稳定身份在同一事务写入。宿主反复调用 relayOutbox(collaboration, durable, scope)，它执行有界批次、目标幂等写入、最后 ACK。提交成功但 ACK 丢失时重投不会重复 enqueue 或 signal；失败保留待投递项。选择按上次读取时间轮转，避免有限失败前缀永久挡住后续工作；选择不表示独占领取。

syncTask(logicalKey) 从实际 durable 日志同步状态，核对租户、物理任务身份、工作流版本、输入、重试上限及初始入队时间。raw 输出必须匹配角色契约；agent_report 还须为 candidate 且完整 agent pin 一致，blocked 或损坏报告转为失败。waiting/reconciling 不解锁依赖，终态不复活。assignment(physicalKey) 可将 worker 任务映射回逻辑分配。tree/loadTask 返回冻结快照。

## Issue 与人工 Question

putIssue(key, issue, actorId) 保存不可变 Issue 身份，同内容幂等，不同内容冲突；scope/task/object 必须属于任务。listIssues(key, {afterId?,limit?}) 返回 `{items,nextCursor}`，默认及最大页长 100。继续用 nextCursor 作为 afterId，直到 null。

openQuestion(key, input, actorId, gateKey?) 创建开放 Question，不生成答案。省略 gateKey 时仅保存收件箱记录；有 gateKey 时任务必须已经 queueReady，记录固定物理任务及开放 Question 输入摘要。工作流须用同一个开放 Question 作为 waitForSignal 的输入。

answerQuestion(key, questionId, actorId, answer, expectedQuestionDigest) 校验范围、选项和可信摘要，原子保存回答及 signal outbox。同一回答/actor 重试幂等，改答或冒用旧摘要拒绝。signal.value 为 `{questionDigest,answer}`，actorId 独立传递。answered 表示回答已持久化；delivery 另为 none/pending/delivered。relay 在实际 gate 的类型和输入摘要匹配后才发送，ACK 再核对该 gate 与实际 signal 回执；同名错误 gate、未开始 gate 或无回执都不算投递成功。终态后仍可确认此前成功且仅丢失 ACK 的投递。

createCollaborationQuestionInbox(store, actorId) 将通用 AgentRuntime 的 Question 接入上述流程，传入运行时构造器第五个参数。RunBinding.taskId 为物理 durable 身份，logicalTaskId 为 assignment 返回的逻辑身份；适配器核对这对映射、角色完整 pin、项目与对象范围。先保存原始开放 Question，再创建完全相同输入的 durable 闸门。actorId 固定于宿主配置，适配器 descriptor 进入运行时绑定日志。已答 Question 可以用于入箱确认丢失后的精确重试，不会重置为开放或改掉回答。

启用/修改 inbox 须升级宿主工作流版本；其管理步骤也需计入 DurableWorker.maxSteps。带预算的工作流通过 planFor 返回 logicalTaskId，预算账本仍绑定实际物理任务。示例与限制见 [Agent 运行时说明](README.md)。

## 两轮 ReviewLoop

PostgresReviewStore(collaboration, agents) 提供 create(key, reviewId, input, actorId, gateKey?)、get 和 apply。制作角色须等于任务角色，方法须为其声明的完整 pin，候选须匹配角色输出契约；独立审查身份、证据范围、对象与候选摘要由既有纯域状态机校验。

apply 接受 operationId、actorId、expectedRevision、expectedDigest 及 round/revision change。同一操作完整重试返回当时的历史快照，即使当前记录已前进；同 ID 换请求拒绝。新操作同时核对 revision 和 loopDigest，在同一事务保存审查状态、本轮 Issue、升级 Question、操作回执和事件，任何失败完整回滚。首轮问题须明确修订后才可第二轮，第二轮失败产生开放 Question；人工回答不会自动将审查改为通过或采用 IR。

## 验收与边界

真实 PostgreSQL 用例覆盖依赖解锁、并发/ACK 丢失、提前回答与错误 gate、队列轮转、完整分页、跨作用域拒绝、损坏数据、审查 CAS/操作幂等及触发器故障回滚。通用运行时还验证了预算份额、Question 入箱、人答投递，以及入箱已提交但日志未确认时实际杀进程再恢复。模型/审片响应均为合成数据，未产生真实付费调用。

宿主仍需驱动 queueReady/relay/worker/sync 循环、提供认证/RBAC、前端、保留/归档与性能验收。本库未自动选择角色、启动常驻服务、验证实际媒体或采用正式 IR。

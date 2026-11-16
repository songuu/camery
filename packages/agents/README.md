# @camery/agents · Agent 执行与制片骨架

T0.9 的内部宿主库，建立在现有 PostgreSQL durable 日志和方法包上。包含不可变角色/工具定义、白名单与对象权限检查、受限决策循环、项目预算、持久化 Task/Issue/Question、两轮审查、事务 outbox、逐步追踪，以及制片→研究→章节方法→人工闸门的确定性回放流程。尚未提供常驻调度服务、业务认证或前端。

```sh
pnpm --filter @camery/agents typecheck
pnpm --filter @camery/agents test:coverage
pnpm test:agents:evals
pnpm test:agents:local --coverage
```

最后一条复用 [本机阶段 0 PostgreSQL](../../deploy/README.md) 配置；也可注入 CAMERY_TEST_DATABASE_URL 后运行包内 test:integration --coverage。缺少数据库 URL 明确失败，不跳过。集成测试只使用随机测试租户，实际创建日志、等待闸门、执行对账并杀子进程再恢复；模型/付费工具均为合成内存夹具，无供应商外呼或计费。CI 已配置同一数据库验收，远端尚未执行。

## 注册与宿主权限

AgentRegistry 只接受声明数据：角色说明、精确方法/工具 pin、模型档位、可写对象类型、预算及输出 schema。同一 id/version 内容变化拒绝。ToolRegistry 将受信宿主 handler 与版本化定义分开，定义不接受脚本；输入/输出契约复用 methods 的严格 JSON Schema 子集，工具根节点须为 object。toMcp 导出 name/description/inputSchema/outputSchema；未实现 MCP 传输、会话或对外服务。

`@camery/agents/node` 的 loadAgentDefinition(directory) 读取严格 JSON 子集的 agent.yaml，字段为 AgentDefinition 去掉 instructions 并加入 `files:{instructions:'instructions.md'}`。元数据和正文经注册校验后返回冻结副本，不执行脚本或自动发现角色。复用 methods 的 dataDirectoryReader：拒绝目录逃逸、链接、重复 JSON 键、非法 UTF-8、文件身份/快照变化，单文件 1MiB、总量 2MiB；methodPackReader 仍保留原专用路径白名单。这些检查不替代 OS 沙箱，目录由受信宿主选择。

磁盘定义见 [资料研究](../../agents/research/agent.yaml) 与 [制片](../../agents/producer/agent.yaml)，正文均自写。研究定义锁定现有章节方法/工具 pin，balanced 档与零费用预算用于合成验收；真实调用须由宿主提供已核实连接及有授权预算的新定义版本。当前确定性制片骨架保留代码内的默认角色；宿主可独立加载/注册磁盘定义，已接通的是磁盘研究角色的模型决策路径。

工具声明 read/candidate/paid/publish 副作用、对象类型、币种与保守报价。运行时从 Agent 的精确 pin 白名单选择工具；对象 ID 由宿主同步 resources 回调从参数提取，必须属于分配范围。非只读工具还需角色声明可写该类型，且当前阶段的单写者映射指定本角色。candidate 工具必须有 outputResources，产物目标只能落在本次输入对象范围内；恢复/对账结果也再次检查契约与范围。误传 async/thenable 提取器被拒绝，并观察迟到拒绝。

paid/publish 执行时必须经宿主 ApprovalAuthority.tokenFor/verify。请求绑定租户、项目、任务、阶段、Agent/tool pin、输入摘要、对象及实际 durable 调用身份；只有布尔 true 放行。宿主负责鉴权、令牌签发、完整绑定核对及原子消费，不能只返回模型自报的 approved:true。令牌不进入模型上下文、步骤输入、报告或工具参数；缓存回放不重复验证/消费。未实现正式认证、签名令牌服务或发布适配器。

## 循环、预算与恢复

AgentRuntime.run(pin, source, binding, workflowContext) 接受受信宿主的 RunBinding；租户/任务必须匹配 durable 新增的只读 context.task，不能从来源输入推断。项目、阶段、对象、单写者和预算分配须由宿主授权后提供。绑定检查点保存定义/工具/方法 pin、宿主策略、输入摘要和 driver 身份，变更后不能静默复用旧步骤。

运行时构造器第五个可选参数为 QuestionInbox。使用 Node 入口 createCollaborationQuestionInbox(collaboration, actorId) 时，RunBinding.logicalTaskId 必填，taskId 仍为实际 durable 物理任务；宿主从 assignment(context.task) 取得逻辑身份。适配器核对角色完整 pin、租户/项目、对象范围与物理任务映射，再将模型提出的原始开放 Question 持久化。actorId 来自宿主配置，模型不能代填。createBudgetedAgentWorkflow 的 planFor 同样支持 logicalTaskId，仍以物理身份分配预算。

Question 先经 replayable 的 agent.N.question.open 步骤入箱，再建立 agent.N.question 闸门。入箱提交后丢失步骤确认可以精确重试；期间已保存的人答继续保留，待同一 Question 闸门存在后由 outbox 投递。入箱失败不继续开闸门，取消前后均检查。descriptor 与 logicalTaskId 纳入绑定日志，启用或更换 inbox 的宿主须升级工作流版本，不能静默复用旧历史。未配置 inbox 的既有直接闸门行为保留。

DecisionDriver 返回 tool/finish/question 三类结构化动作。createModelDecisionDriver(agents, tools, pin, modelSession, options) 使用现有 OpenAI 兼容连接器与 ModelSession；options 显式指定 modelTier、币种、每次预留和可选 pricing。角色档位必须匹配，连接/模式/模型由受信宿主显式选择，不自动降档或挑供应商。可信指令和工具 schema 从注册表重建，原始请求中的同名字段必须完全匹配。模型仅返回 action，不接受自报 usage 或 approved；所有动作仍由运行时权限检查。

源正文单独标作 untrustedSource，工具结果/人答只放在不可信 user 消息封套，决策中不包含凭据或审批令牌。工具动作参数及最终输出再次本地验证，Question 不代填答案。调用前限制上下文至 128KiB；结果保持 candidate，不修改已采用 IR。无自动修复/重试。宿主可继续使用确定性 DecisionDriver，不要求所有任务调用模型。

每次决策和工具调用各占一个 durable 步骤，live 决策、paid/publish 工具为 external，本地/合成调用为 replayable。已知未发送/拒绝/完成失败记结构化安全错误；未知外部结果抛给 durable 进入 reconciling，不自动修复或重提。工具输出、用量、结果类型及 outcome 在恢复时重新校验。错误不回显任意供应商消息。取消、租约与时限由 durable 传播，迟到写入被 fence 阻止；忽略信号的服务仍需对账。

预算取角色、任务和宿主项目预分配份额三者最小允许值，分别限制步数、token 和整数微币成本。模型驱动必须有正 token 预留；live 模型的价格未知或任一价格为正时，费用预留也必须为正。只有明确声明输入/输出均免费时才允许零费用预留。先预留保守报价，再记已知用量；未知总量保持 null/usageUnknown=true，按 max(预留, 已知部分下限) 占用，不能把已知 1000 token 因另一项未知而压回 50 的预留。超报价立即停止后续调用，保留消耗。

pricing 用 inputMicrosPerMillionTokens/outputMicrosPerMillionTokens 表示整数微币/百万 token，BigInt 乘加后整体向上取整，溢出拒绝。未知价格保留 null，合成回放费用为零。价格是宿主配置的估算，不是供应商账单或单次真实费用上限证明；保守报价、tokenizer 与供应商端限额仍由模型网关提供。需要跨任务份额上限时，使用 [PostgreSQL 预算账本](POSTGRES.md) 与 createBudgetedAgentWorkflow；直接调用 AgentRuntime.run 仍由宿主保证项目份额来源。

账本在同一项目锁下串行分配完整份额，以实际 durable 任务身份/指纹和精确 Agent pin 绑定，重复请求不会重复占用。任务等待、失败、取消或外部结果未知时不自动返还预算；任务终态后仍须受信宿主明确确认实际用量才能结算。结算不放在工作流尾部 step 内。预算分配本身以 replayable 步骤记录，数据库提交后丢失日志确认也可安全重试；源输入在等待计划/分配之前即复制冻结。

每个 span 记录稳定身份、输入/结果摘要、工具/driver pin、已知用量、预算占用及外部状态。管理检查点不计 Agent 行为步数；宿主应将 DurableWorker.maxSteps 配为 Agent 步数上限加管理步骤，包括 agent.bind、可选 budget.allocate，以及每个 Question 的额外入箱步骤（Question 闸门本身已占一个行为 span）。章节骨架默认上限 8，远低于 worker 默认 1000。工作流、驱动或 handler 逻辑变化必须显式升级版本，函数源码不作为摘要证明。

模型 span 保存 ModelReceipt；其 callId 使用 durable 公共 stepIdempotencyKey，输入摘要由纯 requestDigest 与实际调用共享 prepare 构建。新执行、缓存或人工对账结果均核对调用身份、原始 API 请求/输出摘要、租户/连接/模式/模型/证据及用量；费用按锁定价格重算。恢复从保存结果重建消耗，不依赖 ModelSession 的进程计数。回执仍是受信宿主记录，不是远程签名证明。

## 任务、问题与制片路径

validateTaskTree 检查完整树、唯一根、父/依赖无环、租户/项目一致及子任务对象范围不扩大。transitionTask 只允许显式状态转换，终态不能复活；成功须输出，失败只含安全错误码。Issue 包括位置、严重度、观众影响、改法、连带影响及 text/media 证据范围。Question 创建不生成答案；submitQuestionAnswer 核对宿主身份作用域、可信存储摘要及选项，返回新的 answered 记录。

`@camery/agents/node` 的 PostgresCollaborationStore 将这些契约接入跨工作流存储。createTree 固定初始 queued 树及每个角色的完整 route；queueReady 仅为显式依赖全部成功的任务写入 enqueue outbox。relayOutbox 将命令投递到现有 durable store，syncTask 再从实际日志核对任务身份、路线、输入及角色输出契约。错误或 blocked 报告不能解锁下游。Issue 用 listIssues 的 items/nextCursor 分页完整读取，Question 可独立留在收件箱，也可绑定精确 durable 闸门。详见 [持久化协作接口](COLLABORATION.md)。

createChapterResearchWorkflow({name, version, methods, method, bindingFor}) 使用宿主已注册的章节方法 pin。bindingFor 根据实际 durable TaskKey 返回可信分配。工作流保存制片/研究任务树，运行研究循环，将章节候选交给 producer.review 闸门。研究子任务使用固定长度摘要身份，允许合法的长父任务 ID。该骨架在一个 durable 工作流内顺序执行逻辑子任务，尚不是通用跨任务并行调度器。

宿主读取该任务的 waiting 步骤，人工决定后调用 store.signal，value 为 `{decision:'accept'|'reject',candidateDigest}`，actorId 来自已认证身份。accept 返回 reviewed_candidate，reject 返回 rejected_candidate；二者都不采用 IR。Question 闸门则使用 `{questionDigest,answer}` 并核对选项，不能替代 paid/publish 审批。

已验证案例见 [制片流程测试](test/producer.test.ts) 与 [PostgreSQL 故障验收](test/durable.integration.test.ts)：实际磁盘方法包、人工信号/错租户拒绝、方法完成后杀 worker、另一进程恢复不重复方法，以及未知合成付费调用对账后不重复提交/审批。

[模型决策回放](test/model-replay.test.ts) 通过实际磁盘角色/方法、真实 OpenAI 兼容连接器与进程内协议响应，录制两次决策并离线回放相同报告；无网络 fallback。PostgreSQL 用例以全新模型会话恢复已完成决策，模型会话与供应商调用计数均不增加。合成响应不代表真实推理、艺术质量或真实计费验收。

[运行时收件箱数据库验收](test/runtime-inbox.integration.test.ts) 将项目预算分配、通用 Agent Question、人工答复/outbox 和任务同步接在一起；另实际杀掉已提交 Question 但尚未确认入箱步骤的子进程，另一进程恢复时不重复决策、不重复创建 Question，保留提前回答并继续等待/投递。未调用真实模型或支付服务。

## 两轮审查与人工升级

createReviewLoop 绑定租户/项目/任务/对象范围、方法 pin、候选摘要、制作/审查身份及 text/media 证据范围。submitReviewRound 只接受绑定的独立审查 Agent/model/mode，Issue 须属于该任务和对象范围，包含位置、观众影响、改法及连带影响。空问题列表只产生 reviewed_candidate，不采用 IR。

首轮有问题返回 revision_required；必须经 submitReviewRevision 明确提交内容已改变且摘要匹配的新候选，才允许第二轮。第二轮仍有问题则 needs_human，生成开放 Question，不生成答案；通过/升级后拒绝继续增加轮次。每次提交需宿主可信存储的 loopDigest，不能用模型自报摘要替代授权。见 [审查回路测试](test/review-loop.test.ts)。

PostgresReviewStore 在同一个项目/任务事务内持久化状态、Issue、第二轮失败产生的开放 Question、操作回执与审计；revision 和 loopDigest 双重 CAS 防止并发覆盖。相同 operationId 和完整请求返回原历史快照，不能以新内容重用。审查方法须属于制作角色声明的完整方法 pin。绑定闸门的 Question 回答经 outbox 投递，answered 与 delivered 分开记录，详情见 [持久化协作接口](COLLABORATION.md)。

审片模型调用、前端收件箱和真实媒体证据验证仍待实现；text/media 与模型身份是宿主声明，元数据检查不等于实际观看成片。

[行为评测基线](EVALUATIONS.md) 运行十个固定合成案例，报告完成率、决策/工具/Question/审查次数、人工升级和已知/未知成本，并精确比较 oracle、计数和轨迹摘要。通过断言与业务任务完成分开统计，未知费用保持 null，预算占用单列。根 pnpm check 已纳入只读基线检查；这不代表真实模型质量或账单验收。

[任务树调度宿主](HOST.md) 提供 tick 与可停止的 run 轮询，将状态同步、依赖解锁、范围内 outbox 和精确目标 worker 接通。已验证制作/研究分支、并发宿主、同租户其他任务隔离及人工等待后的新宿主恢复；不自动选择角色、采用 IR 或启动部署服务。

[本地 OpenTelemetry](OBSERVABILITY.md) 用工作流装饰器生成真实 SDK 父子 span，区分实际执行、日志回放和中断，按作用域与字段白名单保留有界内存快照。元数据摘要化，不记录正文或凭据；不会改写日志步骤、候选或基线。宿主可明确传递已有 parent，实现恢复后的关联；默认不配置网络 exporter 或自动跨进程传播。

[固定章节 worker](../server/README.md) 已将宿主、实际项目预算和原制片方法接入[同镜像 Compose](../../deploy/README.md)，通过受限 LOGIN、停止/强杀后的闸门恢复验收；[认证骨架](../access/README.md)另提供入口权限。认证 HTTP 调度/审阅服务与完整用户管理仍待接入，完整制片角色调度按计划属于阶段 1。Collector/持久化追踪与完整诊断包按部署/发行任务实施，真实模型、账单核实与供应商限额验证待配置后补。完整任务状态见 [阶段 0 进展](../../docs/plan/phase0-progress.md)。

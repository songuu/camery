# 阶段1 · T1.2 StoryBible

依据：[v2.1实施计划](implementation_plan_v2.md) T1.2。来源导入与工作台已于`2b1ea3d`落地；本任务继续分块抽取、跨块实体合并、原文定位和用户确认。外部编辑器、法务、设计伙伴确认依用户指示后补，不阻塞本任务。

<!-- design-authority:start -->
## Design Authority（shadow）

- 用户价值：长篇的人物、关系、世界规则、时间线与伏笔必须能返回具体来源核对，用户能纠正模型猜测及同名异人。
- 范围：完整来源快照→有界抽取块→逐块结构化候选与执行回执→跨块合并建议→人工决定的Bible快照。领域及单块模型适配已在`1f5b3aa`交付，持久化与预算任务恢复已在`4d2ee54`交付；revision 3补齐认证HTTP、审阅界面和可配置常驻宿主。真实文本模型质量及人工评分仍待实际配置与验收，协议测试通过不代表它们完成。
- 取舍：新增`@camery/bible`知识域，复用ingest校验和methods/ModelSession；现有IR尚无Bible集合，不能把关系与伏笔塞入`role`或自由locator字符串。Bible确认不等于正式IR采用；未来生成IR对象仍走既有ChangeSet。现有ingest普通ID也不强行当成IR ULID。
- 来源与分块：宿主提供已经授权读取的完整来源、tenant/project/document/kind/revision；文档绑定精确UTF-8摘要、原始文件摘要及UTF-16位置。默认12000字符/48000字节一块，优先结构边界，过长结构继续切分，保留所有原文且不拆代理对。计划不得从分页读数拼凑。
- 抽取与合并：结构化模型只处理单块不可信正文，局部引用必须能逐字回切。输出只含候选，不接受模型自报授权、费用或已确认。所有原始块记录保留；同kind名称/别名精确相遇产生合并建议，不能自动消除同名异人或选择矛盾描述。人工显式分组后再重映射关系与事实引用。
- 状态与恢复：计划/块/候选/确认各自内容摘要。缺块、重复块、旧来源/方法、非法引用明确失败；同一输入顺序无关地得到同一候选。确认需要受信宿主提供真实人类、作用域、时点和同步授权，完整决定所有实体，引用被拒实体的关系或事实不得被静默截断。纯域返回值不是数据库提交或真实人工评分证明。
- 执行安全：复用固定方法pin、MethodRunner和ModelSession，无新URL/凭据入口、无隐藏重试。revision 2以一块一个真实durable任务接现有AgentRuntime/预算账本，不把普通循环当成预算或恢复保证；单块原始回执和未知外部结果保留。会话、定时pump和认证服务仍由受信宿主配置；ComfyUI已有图像能力不能代替文本抽取模型。
- revision 2（2026-11-16）：新增显式`camery_bible`迁移及四类追加记录；固定来源快照、逐块任务引用、原始方法回执和人工审阅审计分开保存。每块1个Agent decision，整次run的份额总数在开始时校验，阻塞/未知时停在同一个任务。来源锁先于run锁、同一连接读取，确认首写核对当前来源；已经确认的同身份同语义重试重新授权后只读原审计，不制造新采用。AC语义保持不变。
- revision 3（2026-11-16）：补齐认证HTTP、轻量列表/状态查询、冻结原文窗口与显式审阅UI，以及独立文本模型常驻宿主。请求不得提供模型/凭据/人类授权；固定项目的宿主配置决定新提取是否可用，未配置时仍能读取并审阅已有候选。列表时间游标保留数据库微秒，状态轮询不重载完整原文；确认仍执行原有事务新鲜度校验。API、Bible、任务预算使用不同连接池和最小角色；pump有界公平扫描，只精确执行同一块任务，未知外部结果不得自动重发。AC语义保持不变。
- Acceptance Criteria：
  - SB-1: WHEN 完整来源被分块 THE SYSTEM SHALL 完整覆盖精确原文、遵守字符和字节上限，并绑定来源作用域/版本/摘要与不可变计划。
  - SB-2: WHEN 单块产生人物、关系或事实候选 THE SYSTEM SHALL 校验严格结构、局部身份引用及精确原文引文，再转换为同一快照中的全局位置；引用不证明语义正确。
  - SB-3: WHEN 所有块汇总 THE SYSTEM SHALL 拒绝缺失/重复/过期记录，保留每条来源与模型回执，仅提出可拆分的同名/别名合并建议，并在用户决定前保持candidate。
  - SB-4: WHEN 用户确认候选 THE SYSTEM SHALL 核对受信人类身份、项目授权、当前来源及候选摘要，要求每个实体明确分组或拒绝，保留冲突描述并完整重映射选中关系/事实，不改变正式IR。
  - SB-5: WHEN 已提交的应用任务重启或来源变化 THE SYSTEM SHALL 从持久化计划/逐块日志恢复，避免重复付费，未知结果走对账，旧来源候选不得静默成为新版本正式内容。
  - SB-6: WHEN 用户通过工作台抽取及审阅 THE SYSTEM SHALL 经认证项目权限读写，能从候选跳回原文、解决合并歧义并确认/拒绝；真实模型十章质量与人工确认另留实际证据。
<!-- design-authority:end -->

## 有序实施任务

| 任务/文件 | 前置 | 风险 | 证据 |
|---|---|---|---|
| [P] 分块：`packages/bible/src/chunks.ts`与定向测试 | 共享contracts/data | L2 | SB-1十章、巨型章、Unicode/UTF8字节、计划篡改与完整覆盖 |
| [P] 模型适配：`src/extraction.ts`与协议测试 | 共享契约；组合验证待分块/引用完成 | L2 | SB-2真实连接器合成录制/回放、固定方法、错误outcome/取消及回执 |
| [P] 候选归并：`src/candidate.ts`与测试 | 共享契约；组合验证待逐块记录校验完成 | L2 | SB-3别名链、同名异人、缺/重复块、旧scope及稳定摘要 |
| 引文与人工确认：`src/evidence.ts`、`src/confirmation.ts`及测试 | 候选契约/组合实现 | L3 | SB-2/4伪造引用、跨版本、人类gate、完整决定、矛盾保留 |
| 应用持久化/任务：`src/node/{contracts,store,migrate,runtime-role,workflow}.ts`/新SQL；ingest同连接helper；methods编译器与agents方法driver | 上述领域；预算和durable现有接口 | L4 | SB-5真实PG并发、SIGKILL/未知结果恢复、租户隔离；见包内PG测试与本轮进展记录 |
| [P] 轻量catalog/可信DTO：`bible/src/node/{catalog,read-model,migrate}.ts`及0002索引 | 冻结HTTP契约/既有持久化 | L4 | 微秒游标、租户过滤、严格投影与冻结原文；不改0001校验和 |
| [P] 独立文本宿主：`server/src/bible-{config,runtime,host,task-role,worker-main}.ts` | 冻结catalog结构/既有workflow | L4 | 文件密钥、未配置只读、精确任务/公平恢复、最小数据库角色 |
| [P] 审阅组件：`web/src/BibleWorkbench.tsx`及显式决定状态 | 冻结HTTP契约 | L3 | 不自动合并、拒绝引用不静默丢弃、冻结源定位、320px布局 |
| 认证API与工作台集成、部署镜像 | 上述接口；三项完成后组合验证 | L4 | SB-6权限/身份隔离、浏览器操作、真实PG、构建和远端CI；真实模型质量与人审另留实际证据 |

前三项仅在共享接口冻结后可并行编辑互不相交文件；完整类型检查与组合测试串行验收。新增普通包参与根类型/覆盖检查；不修改其他用户正在编辑的产品与接入方案。

## 契约与消费者

| 之前 | 之后 | 消费者/一致性证据 |
|---|---|---|
| ingest完整快照或分页展示 | `SourceIdentity`+不可变`ChunkPlan`；正文仍属原来源 | 抽取器、来源定位；结构边界及字节摘要测试 |
| 单块模型JSON | 严格`ChunkOutput`+`ChunkRecord`+实际ModelReceipt | 汇总候选；Zod与受限JSON Schema一致性/协议测试 |
| 无跨块知识候选 | `BibleCandidate`与可拆分合并建议 | 人工确认；重建校验与错引用测试 |
| 无Bible正式集合 | 独立`ConfirmedBible`；正式IR仍保持既有采用服务权威 | 后续T1.4/T1.5；确认/重映射/来源过期测试 |
| 方法回执仅绑定raw方法输出，Agent仅识别action封套 | 可信driver显式`receiptOutput:finish-output`只接受finish，缺省保留旧封套；共用请求编译器 | AgentRuntime/ModelSession；旧协议字节与新原始回执/单次计量回归 |
| 领域值尚未存档 | 独立runs/chunks/candidates/reviews追加记录，运行身份只读来源，installer与运行账号分离 | BibleStore、future API；真实PG并发/恢复/角色canary |
| 整份来源可能超过durable 1MiB上限 | 任务只传run/chunk/digest引用，逐块模型/日志有界，整体candidate留PG | 宿主pump/worker；refs尺寸、实际SIGKILL及无重复调用测试 |

未知：尚无经过本任务核实的文本模型、模式pin、价格与凭据配置。可完成确定性边界及合成协议测试；不得把它们表述为真实抽取质量或真实用户已确认。新迁移仅由测试installer显式安装到现有本机测试库；运行服务不自动迁移、扩权或启用Bible任务。卸载代码不删除数据；新schema迁移失败整事务回滚，既有其他域迁移不改写，未来版本回退不能忽略已登记checksum。

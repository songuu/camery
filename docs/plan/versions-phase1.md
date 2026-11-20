# T1.9 多版本对比与局部采用

基线：`6d2fe85005a49746534ed6d96f50551066e7c7c8`。继承 v2.1 T1.9、VCA-002/007 的项目映射、来源与过期约束。认证 HTTP/UI 接入及外部验收按当前授权后补；内部授权、来源收据、锁、版本和引用校验保持生效。

<!-- design-authority:start -->
## Design Authority（shadow）

- **问题与价值：**同一集的候选需要可解释地对比并保留局部修改。现有 adoption scope 只是完整变更的授权范围，不能表达选择。直接过滤正式 JSON 会绕过引用、锁和来源约束。
- **范围：**先交付现有正式版本域上的只读比较与独立局部候选，复用共享应用的真实身份映射、冻结意图和事务回执。原候选及手稿不可改写。当前可写来源为共享应用已验证的 manual/development；Outline、SC 有各自来源证明，未接适配器前只能只读，不能借此取得 manual 权限。
- **选项与决定：**拒绝直接裁剪 adopted JSON、将 scope 当筛选器、另建版本账本。选择原始 operation ID，保持原始顺序与全部读依赖，形成新 ChangeSet，执行完整原生预览和采用校验。拆并、锁和 schema 迁移需要独立业务决定，首轮局部选择显式拒绝；完整候选原入口不变。
- **组件与接口：**versioning 纯比较/选择；IR 有界工作台契约；ProjectApplication 比较、预览选择、准备选择；现有 candidate_intents 增加可选来源链接，不修改历史迁移。新候选沿用真实源策略，不能由调用者提交源证据。认证新路由和浏览器消费另一个切片交付。
- **状态与错误：**比较区分 current/candidate/adopted/rejected/conflicted；过期依赖显示但不隐式重基。非法选择、悬空引用、源缺失、锁、base/CAS 及传输超限显式返回；响应未知恢复同一 applicationId/原请求，旧回执恢复仍先核实当前权限。
- **AC-VERS-01：**WHEN 比较两个同项目候选或当前正式稿，THE SYSTEM SHALL 返回有界、完整且确定排序的对象差异，标识精确来源、状态与当前版本，超限拒绝，不截断或写入。
- **AC-VERS-02：**WHEN 预览选择原始操作，THE SYSTEM SHALL 保留原始顺序和全部显式读依赖、建立新身份并执行完整校验，不写入、不分配身份、不调用模型或改变原候选。
- **AC-VERS-03：**WHEN 准备局部候选，THE SYSTEM SHALL 从同项目真实持久意图和原生请求核对来源，绑定原请求摘要与所选操作，保留原候选，经现有持久意图和事务回执提交；重试恢复原命令，变化同键冲突。
- **AC-VERS-04：**WHEN 采用局部候选，THE SYSTEM SHALL 继续核实当前人类权限、源策略、全部读依赖、锁、引用及双 CAS；源已过期、只读、伪造 actor、跨项目、无来源 native 候选和特殊操作不得绕过原入口。
- **AC-VERS-05：**WHEN 后续接入 Outline/SC、素材/锚点或浏览器，THE SYSTEM SHALL 使用真实来源适配与当前对象版本；未完成部分保持明确未验收，不虚构就绪、法务、模型或编辑器证据。
- **AC-VERS-06：**WHEN 共享宿主准备或决定 SC 整集候选，THE SYSTEM SHALL 从真实已审来源确定映射，以来源专用的无正文意图冻结命令与全部身份，复用原生 submission/adoption hooks；响应未知恢复原身份，采用和拒绝保存同事务真实回执，来源变化、权限撤销及跨项目请求失败闭合。
- **AC-VERS-07：**WHEN 共享消费者列举、读取、比较或决定来自 manual/development/Outline/SC 的候选，THE SYSTEM SHALL 识别唯一真实来源并委托对应权威；多来源认领拒绝，已托管候选不得降级 unmanaged，大候选通过有总数和绑定游标的完整证据页消费，采用范围保持来源的真实原子单位。
- **AC-VERS-08：**WHEN 读取 SC 已采用结果和四账交接，THE SYSTEM SHALL 核对真实 native binding、采用证明及当前 writing dependencies，区分剧本已采用、ledger_pending 与 handoff_ready；未采用四账或缺失原证明不能被摘要、成功文本或共享回执替代。

<!-- design-authority:end -->

## Revision 2：共享来源宿主（2026-11-20）

第一切片已由 `936e7c5` 在远端 CI 28/28 验证；新增 AC-VERS-06/07/08，原有 AC 不变。本修订继续完成 T1.9 的真实来源消费，不改变认证和外部验收后补的约定。

| 契约 | 原状 | 本修订 |
|---|---|---|
| 普通 Workbench v1 | manual/development，500 operations/differences/messages | 保持兼容，不扩容，不赋予 Outline/SC 来源权限 |
| 来源回执 | Outline 已有 compact ACK + message pages | 提取同形中性契约；旧 Outline export 保留，SC 复用完整回执及有界消息页 |
| SC 预提交身份 | native binding 仅在提交后存在；尚无宿主 journal | 专用 2 MiB 无正文 journal，最多 40,000 ordered IDs，固定 source/review/preparation/slot digests，不复制原文或正式版本 |
| SC 正式采用 | domain 已有整集 mapping、来源 guard、locked-line 与 native proof | 宿主调用现有权威并把共享决定回执写在同一原生事务；拒绝独立保存真实 rejection，不伪造 adoption proof |
| 来源消费者 | 通用目录会将 Outline 原生项标为 unmanaged；无 SC 来源消费者 | 来源适配组合既有应用和 SC 宿主，标识唯一 owner；分页差异、消息及来源状态，所有页重新核实权限和基线 |

有序任务：

1. `[P, L2]` SC 按真实 formal target/changeId 反查 committed binding 的授权公开包装及测试；文件限 `script/src/screenplay/node/intent.ts`、其 export 与专属测试。AC-VERS-05/08。
2. `[P, L2]` 中性来源回执及 SC 命令/紧凑候选契约，保持旧 Outline export 兼容；IR 专属文件和契约测试。AC-VERS-06/07。
3. `[L4]` SC 身份/决定意图、来源 FK、双 CAS、事务回执、显式迁移与最小运行角色；`server/src/projects/screenplay-*` 及相应测试。依赖 1/2，AC-VERS-06/08。
4. `[L3]` SC 宿主 prepare/read/adopt/reject/receipt/handoff；只在真实 guard 前保持 upstream→native 锁序，历史 ACK 不伪造缺失证明。依赖 3，AC-VERS-06/08。
5. `[L3/L4]` 共享来源 catalogue/详情/分页比较/明确决定，来源应用保留独立 pool 与权威，闭合白名单只增加必要 header SELECT；依赖 4，AC-VERS-07。

接口细化（Revision 2a）：既有 producer 可能已写入真实 SC native binding 而没有本次新增的宿主 journal。此类候选必须可读取与明确采用/拒绝；详情 `applicationId` 明确为 null，不虚构准备命令或回执。新 SC 决定意图以实际 binding 的 ordinary scope + formal target/changeId 为外键，既支持旧 producer 也支持新 journal；准备命令遇到已有 binding 只引导读取原候选，不能另分配 ID 或冒认原准备 ACK。新预提交 journal 仍为 append-only 来源/身份准备，不成为采用授权的替代。

原生锁约束细化（Revision 2b）：SC mapping 包含 line text lock，原生引擎要求采用者与这些锁操作的 request author 为同一个真实人类。新宿主的“定稿候选准备”因此属于已有受审文本的 `candidate:review` 定稿权限，不允许编辑者提交自由正文或替另一位 reviewer 冒名创建锁请求；随后采用仍需该准备者的当前 review 权限。其他 reviewer 仍可明确拒绝。详情分别给出 `authorId`、`canAdopt` 和 `canReject`，不能用一个可审阅标记承诺两种动作都可执行；绝不移除原生 LOCK_AUTHORITY 规则。

并发细化（Revision 2c）：预提交命令按 applicationId 固定身份，来源 key 只建索引，不将未执行意图误作“已正式提交”的来源唯一锁。确定无 native binding 且旧 CAS 已失败时，可由新的明确命令重新准备；已有命令及其 IDs 保持不变。实际 `camery_screenplay.native_bindings` 继续以 source candidate 唯一约束决定唯一正式提交，双键竞争的失败方必须原生事务整体回滚；已存在 binding 时拒绝新分配，并指向原候选。pending generation 只显示真实 pending origin，不能降为 manual 或进入采用。

交付切片细化（Revision 2d）：本次先完成任务 1–4，即 T1.6 定稿锁及四账消费所需的 SC 内部宿主，使用独立、预先安装并校验权限闭包的 reader/adopter LOGIN；没有认证 HTTP/UI 路由。AC-VERS-07 的统一来源目录和比较消费者保留为依赖此宿主的下一切片，当前不计完成。内部 `readBundle` 含真实完整源材料和宿主能力，仅供可信组合；外部入口必须投影有界 DTO，不能直接序列化此对象。

SC 真实 PG 专项已经覆盖：实际准备/采用写后 COMMIT ACK 丢失、重新打开连接池恢复、旧生产者无 journal、缺失 SC 原生采用证明失败、不同 applicationId 竞争唯一实际 binding、另一位审阅者只能拒绝锁作者候选、来源更新阻断采用，以及真实四账采用后下一集完整读取约束。独立受限 LOGIN 已验证超过普通 V1 的 500 operations 容量；列权限、PUBLIC 视图、成员角色、凭据表读权限和 grant option 超出闭包均被拒绝。此为合成写作内容的实际存储证明，不代表真实模型质量或外部验收；仍需完成整仓、本次全部受影响 PG、评审及精确提交 CI 门。

备选取舍：不扩容普通 candidate_intents、不把 SC 存成 manual、不复制完整 context/draft/request、不裁剪整集 mapping 复用旧证明、不新建执行/费用账本。SC 整集和完整四账分别是既有原子单位；更小的场景混编需要新的人审与来源证明，当前不假装支持。回退关闭新增宿主/capability 并回退组合接线；新增 append-only 表保持可读，已采用 native/ledger 历史不回滚；迁移、授权仅由显式 installer 执行。

验证门：TDD；契约/纯边界→来源/锁/引用/同键恢复→真实 PG（包括写后 COMMIT ACK 丢失、新 pool、撤权、missing-proof、上限容量、跨来源分页）→受限 LOGIN 正反授权→整仓 check/真实受影响 PG→代码/TS/数据库/安全复核→提交推送→精确提交远端 CI 全绿。禁止修改历史迁移或降低既有门槛。认证新路由/UI 和外部验收保持待交付，不以内部 host 测试替代。

## 交付顺序与验证

1. 纯域比较与原操作选择（TDD）；共享契约及宿主内部方法（TDD），聚焦权限/来源/引用/锁/幂等负例。
2. 来源适配与统一目录、剧本比较消费、就绪/共享引用影响；在相关生产者具备实际证明后接入，不把 native 原生请求视为来源授权。
3. 认证 HTTP/UI、真实浏览器和外部验收继续后补，不作为第一切片内部接口的完成证据。

首个切片验收：相关纯域/应用测试、包覆盖率与类型、整仓 check、真实 Server/Versioning PG 回归；评审通过后提交推送，核对精确提交的全部远端 CI。不得降低 95% 门槛、跳过测试或改五份用户文档。回退采用向前提交恢复新增入口；既有原生版本和历史收据保持可读。

## 当前状态

- 第一切片 `936e7c5` 已核对精确提交远端 CI 28/28 全绿。T1.9 尚未判定整体完成。
- 已落地：当前稿/候选只读比较、真实 project 计数与 locks 差异、原操作元数据、独立候选及摘要关联、完整读依赖保留与过期阻断、来源继承、回执恢复、资产路径脱敏。无 schema/运行角色迁移，无新增认证路由。
- 明确边界：跨 schema 和改变 shot_lineage 的比较返回显式拒绝；局部选择不处理拆并、锁、schema 迁移、嵌套选择或历史墓碑复活。原完整候选入口保持可用，不把这些边界标记为 T1.9 全量完成。
- 后续切片及外部依赖无实际验收证据，不能以纯函数测试替代。
- 第二切片已落地 SC 内部准备、详情、明确采用/拒绝、完整消息分页及真实四账交接：来源专用 append-only journal、同事务 domain/shared receipts、旧生产者兼容、真实锁作者和双 CAS、写后 ACK 恢复、严格 reader/adopter 运行角色。未接主 bootstrap、认证 HTTP/UI；统一跨来源目录与比较消费者（AC-VERS-07）继续后补。

第二切片本地验收（2026-11-20）：`pnpm check` 通过，14 包共 8,431 项普通测试、20 项 tooling 测试及 Methods 6/Agents 10 项基线匹配；Server 真 PG 全量 1,435 项，覆盖率 97.74/96.04/99.34/99.90%；Script 剧本真 PG 文件 37 项通过。代码、TypeScript、数据库和安全复核通过。真实受限 LOGIN 已覆盖超过 500 operations 的完整定稿，以及 PUBLIC/列/视图/成员角色/SECURITY DEFINER 与 SQL operator 遮蔽攻击拒绝；四账采用后下一集读取完整实际约束，缺原生 SC proof 的共享 ACK 恢复失败闭合。显式安装先运行 `migrateScreenplayProjectIntents`，由 installer 授予既有 identity reader 和新的 SC adopter 能力，再调用 `createScreenplayAdoptionRuntime`；请求路径不迁移或授权。日志、SHA 清单及随后精确提交的 CI 证据位于忽略目录 `artifacts/delivery/screenplay-*`。

第一切片本地验收（2026-11-20）：`pnpm check` 通过，14 包共 8,069 项普通测试、20 项 tooling 测试及 Methods 6/Agents 10 项基线匹配；Server 真 PG 全量 1,141 项，覆盖率 97.76/95.69/99.67/99.82%；Versioning 真 PG 全量 350 项，覆盖率 98.29/96.71/99.49/99.85%。真实持久化用例覆盖 COMMIT ACK 丢失、新连接池恢复、部分采用、原候选保留、撤权及来源变化原子拒绝；模型来源使用明确标识的 synthetic fixture，不代表实际文本效果或外部验收。日志与 SHA 清单保存在忽略目录 `artifacts/delivery/versions-local-verification.json`。

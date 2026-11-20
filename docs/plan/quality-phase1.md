# 阶段1 T1.8 结构闸门与三角色审阅

2026-11-19：前一回合属于已验证进展。`5e7f5d612d96a00959c5c1b20e8ed8608b5499c8` 的[远端CI](https://github.com/songuu/camery/actions/runs/44520491770)28步全成功；T1.6与T1.7工程交付不代替整阶段1验收。接续工作树中的v2.1任务、产品5.4及ADR-014，认证新接线、真实模型质量与编辑器/法务/设计伙伴确认后补。原有五份用户文档不编辑、不纳入提交。

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与价值：把可复现的结构问题、配置经验与主观模型审阅分开记录，先执行免费结构闸门，再依故事（审片）→连贯（场记）→可拍性（制作）检查；每个问题能定位、解释观众影响、给改法及连带影响，最多两次修订周期后交给人。
- 范围：script新增quality纯域/Node子入口；复用真实Outline与Screenplay/四账检查、既有Issue/Question及Methods/Agent/Durable预算和恢复。包含可配置俗套分级、起名黑名单/主要人物重姓、13类原创反模式，完整文本/证据覆盖、三阶段方法及独立模型绑定、持久来源/结果/理由豁免/修订与升级、实际共享问题投递和PG/进程验收。接口UI认证按用户后补，不自动改稿、解锁、采用或发布。
- 备选：扩展法律预检会混淆法律建议与创作品质；通用ReviewLoop仅单审查者/两轮且候选为小JSON，不能伪造人类写作者的model identity或承载完整剧本来源。选择script独立quality流程，复用检查器与Issue/Question契约、保留三阶段/两周期的领域状态，不改旧ReviewLoop的摘要或语义。原候选/人改稿及实际已锁定稿均可显式选择。
- 数据与消费者：实际源只由同连接仓库读取；完整大纲、剧本、真实说话者/四账上下文形成稳定只读材料和分批目录。规则配置显式版本化，经验初值为unvalidated。模型原DTO/收据、派生Issue分开；缺材料、漏批、越权、过期、错模型、unknown不算审过。原始Source与结果保持历史，首次调用及首次当前消费重新检查。Methods2MiB、输出512KiB及Durable1MiB不扩大，完整请求预检，超额明确拒绝，不裁剪正文伪造覆盖。
- 审阅与恢复：先deterministic，后story→continuity→production；每阶段覆盖全部已登记材料/规则后才能完成，前阶段原结果摘要进入后阶段绑定。实际生成来源的审片模型必须与产出模型不同；人工稿明确标人类，不能捏造生产模型。每周期每批固定任务/调用/预算。首次问题可带明确人类理由豁免或提交实际新候选进入第二周期；第二周期未解问题产生真实持久Question，不自动第三次重写/重调。所有报告只说明文本逻辑，不签成片质量。
- 共享黑板：质量结果与投递outbox原子保存；之后以固定身份向现有逻辑任务/Issue/Question服务幂等投递，读取实际共享结果确认完成。避免持有源锁时开启另一套project事务，避免丢ACK导致重复问题或伪造升级。历史Issue附源摘要；当前消费仍要求源当前。若选择同连接能力，须先核对现有事务接口并记录revision，不能嵌套另一pool事务。
- Acceptance Criteria：
  - AC-QL-1: WHEN 准备审阅 THE SYSTEM SHALL 从实际持久大纲/剧本候选、人改或显式native proof读取完整来源及实际产出模型；JSON/摘要不能冒充来源、身份或当前性。
  - AC-QL-2: WHEN 运行确定性闸门 THE SYSTEM SHALL 复用结构/钩子/模块/时长/四账检查并检查配置卡点轮换、情绪与伏笔；完整位置/观众影响/改法/连带影响随Issue保存，结构错误不由模型自报或经验配置放行。
  - AC-QL-3: WHEN 使用规则库 THE SYSTEM SHALL 提供原创13类反模式及明确可配置俗套分级、起名规则与阈值；保留验证状态、全部命中/位置与分级计分，豁免须绑定实际问题及人类理由，不能静默删除旧问题。
  - AC-QL-4: WHEN 调用审阅模型 THE SYSTEM SHALL 按故事→连贯→制作执行完整稳定批次，核对独立性、原请求/DTO/收据及全部覆盖，先于调用检查免费闸门/预算/授权/来源；缺批、未知或缺证据不能成为通过。
  - AC-QL-5: WHEN 修订或结束审阅 THE SYSTEM SHALL 保留两周期及每周期三阶段的原结果；第一次带问题需人类处置或绑定真实新稿，第二次未解须升级为持久Question，不能自动第三周期或修改正式正文/锁。
  - AC-QL-6: WHEN 并发、丢ACK或进程终止 THE SYSTEM SHALL 用原task/call/预算/DTO及幂等问题投递恢复；旧源已完成付费结果保留，过期源阻止新调用与当前消费，不换身份补调unknown。
  - AC-QL-7: WHEN 读取或人类处置结果 THE SYSTEM SHALL 逐项重放来源/规则/阶段/证据/豁免，并证明共享Issue/Question实际持久结果，保持租户/项目范围及text证据边界，不冒称成片质量/真实模型质量/法律签核。
<!-- design-authority:end -->

| 契约 | 既有现状 | 新增与一致性 |
| --- | --- | --- |
| Outline/Screenplay | 结构、轮换/情绪、首集五模块、四声音、估时、四账及人改/native proof | 只读组合，不改变旧候选/审核/迁移摘要；错误与提醒分别映射Issue |
| Issue/Question | mandatory位置/严重度/观众影响/改法/ripple、text/media边界、真实共享黑板 | 导出同一Issue schema供新领域组合；有界outbox确认实际投递，不制造人答复 |
| 审阅回路 | 单producer/reviewer、最多两次审查 | 不改旧回路；新增三角色顺序、两修订周期和明确人类来源 |
| 模型/预算 | 既有Method/Agent/Durable及实际PG账本 | 固定方法/模型/完整分批，调用前完整预算与请求预检，历史付费输出与unknown恢复 |

| 有序任务 / owner | 文件、前置、风险 | 完成证据 |
| --- | --- | --- |
| 根：冻结纯契约/投影 | script quality contracts/boundary/projection、agents Issue schema公开；前置T1.6/T1.7；L3 | 全文本四声音/命名/定位/容量/opaque边界 AC-QL-1/2/3 |
| [P] 规则库/命中 | quality catalog.ts及独立test，冻结contracts之后；L2 | 原创13项、版本/配置、重叠/Unicode、分级/命名/容量反例 AC-QL-3 |
| [P] 结构检查组合 | quality gates.ts及独立test，冻结contracts之后；L2 | 复用既有checker、阈值/伏笔/知情与Issue转换、无错误放行 AC-QL-2 |
| 根：纯阶段/周期状态与方法 | quality state/model/方法资产，前述契约；L3 | 全矩阵/阶段顺序、独立模型、两周期、理由豁免、text-only AC-QL-4/5 |
| 根：实际来源/持久存储/黑板投递 | quality node source/store/migrations/outbox，与实际SC/Outline/Agents组合；L4 | 同client源锁、真实身份、不可变保存、并发/回滚/丢ACK/实际Issue与Question AC-QL-1/5/7 |
| 根：预算任务/恢复与全交付 | quality node workflow/dispatch及PG/child/说明、workspace/CI；L4 | 原预算/unknown/新pool/SIGKILL、四类复审、串行覆盖/整仓、授权commit/push及精确CI全绿 AC-QL-4/6/7 |

风险/回滚：新增入口和任务可撤出注册，保留所有源、结果、Issue/Question、预算与原生历史；不删旧表或迁移。真实文本模型/人体评分与媒体验收无证据则继续未知，不以合成回放替代；不因外部后补而缩成纯规则演示。PG、coverage、整仓串行，实施状态以下方验证记录为准。

计划核对：AC仅由design-authority区定义，无placeholder oracle；结构/经验/模型三类证据不混用；三角色与两周期含义独立；所有必需来源、持久黑板、付费恢复和外部后补边界保持。

## Revision 1 · 核心与实际来源

纯域已组合通过，原Issue schema仅公开同一schema实例；大纲/剧本检查器、规则配置、真实位置/四声音/沉默参与者姓名与三阶段两周期控制复用。首周期免费hard gate允许明确新稿进入第二周期，保留错误而不伪造首周期模型调用；第二周期仍hard则升级且禁止第三周期。

新增Outline/SC generation同client只读口，原接口与SQL迁移不改。实际Source从库读取原候选/人改/显式native锁定稿及原ModelReceipt，保留直接人改与产出模型；不从请求接收模型身份。generation已开始但未delivery不能冻结为人工来源。25项真实PG源组合通过（180.10s），包括旧22例与3个新增质量来源例；日志SHA-256 `c70e181f47e570b5dd9b7f57aab4bab6edfe1e1d5b487c3743f91ea45fb44e35`。当前尚未完成质量Store/共享黑板投递/三角色预算工作流，不判完整T1.8完成。

## Revision 2 · 模型传输与领域证据

不扩大既有Methods OutputContract支持子集。模型raw证据start/end改为非负整数；quote=null时必须0/0，clear必须空evidence；uncertain仍需真实可见path。派生QualityFinding继续用null偏移表达无引文。完整矩阵、原DTO/回执摘要与Issue语义不变；同path的不同长字符串slice必须不重叠，完整Plan另外证明全材料覆盖。模型finding身份绑定phase/unit/topic，避免多个unit引用同一common文字时碰撞。三角色方法使用原supported integer/string-null schema，不扩通用运行时或修改旧方法摘要。

## Revision 3 · 大纲修订对象

大纲质量对象按实际仓库的tenant/project/briefId标识创意简报流，来源仍逐一绑定具体run、候选、人改稿及完整摘要。已审核稿不可改写，下一版需新run；同一简报的新run因此可以显式进入第二周期，不同简报不能借此混入。Source保存实际outlineBriefId并在历史读取时重查，单纯重算JSON摘要仍不能冒充库中来源。剧本对象继续绑定实际episodeId。

## Revision 4 · 实际持久结果与并发发布

增加独立quality schema：run、两周期来源/免费报告、完整模型批次、三阶段证明、逐问题人类理由、最多9次控制追加与共享outbox。先实际源锁后本域锁；历史已付保存不拿current源锁。RC历史重放用单条SQL的发布token包围整次读取，成功和失败都核对，变化才重读（最多12次），稳定的真实损坏继续失败。真实双连接屏障确认了旧controls/新stage误报，并经修复转绿。

outbox先原子随质量结果保存；释放源/quality事务后写实际Agents黑板并读回，再以最多100项的一页原子确认。丢确认可以重放共享写，固定Issue/Question与原actor保持。消费除了已确认标志，还读实际共享记录、核对完整派生数量并重新检查当前源；逻辑黑板anchor不冒充模型任务完成状态。确认一次有界页只重放一次完整历史，保留逐项实际核对。

## Revision 5 · 预算、模型协议与恢复

三角色执行画像同币种，实际项目预算余额/币种仍由逐批原allocation核对，不声称排他预留整个项目。故事审阅与所有实际产出模型的identity和mode均独立；人类稿保留真实人类作者。连接名沿用既有Methods Name，项目/对象继续domain ID。所有Node helper按组件严格捕获；material/plan/root自有冻结缓存仅优化完整性重放，不赋予数据库来源或当前权限。

固定周期/角色/批次task/call/allocation；driver digest绑定原请求与来源，授权/源/阶段在决定前及session await后重查。原DTO保持原序与receipt摘要，漏矩阵、错证据、unknown不修复补调。持久尾部只存小引用；actual read回原批结果。35项真实PG回归通过（227.30s），包含原有回归与unknown显式对账、实际COMMIT丢确认、新pool和真实SIGKILL恢复，模型调用/预算增量为0。相关响应为合成协议，不是实际供应方质量或真人验收。

实际大上下文分批、模型Issue人工处置/实际黑板缺行拒绝、免费hard→第二blocked周期的补充验收已通过：完整37项真实PG回归，314.58s。未出版阶段合法缺批返回INCOMPLETE，已出版证明缺覆盖仍拒为STORAGE_FAILED；已确认共享Issue缺失给明确storage上下文，不能仅凭ACK消费。代码/TS/安全/DB复核通过；当前仍须串行PG覆盖率与整仓验证，再按授权提交推送并确认精确commit的远端CI。原五份用户文档保持不改。

## 验证状态 · 2026-11-20

T1.8 内部宿主链路已实现：实际来源读取、免费闸门、故事→连贯→制作三角色、两周期人工处置、预算任务恢复、共享 Issue/Question 投递及当前结果消费。正式正文和锁由原生采用流程管理，质量回路只保留来源、问题、理由与证明。

| 本地自动化门禁 | 已验证结果 |
| --- | --- |
| `pnpm check` | 20项工具测试、8029项普通测试；14包类型门禁与14包实际执行的覆盖率通过；Methods 6项、Agents 10项 golden evaluation匹配 |
| Script 普通测试 | 3756/3756；statement/branch/function/line为97.24%/95.07%/99.25%/99.45% |
| 完整 Script PG + coverage | 147文件、3914/3914（3756普通+158个PG集成用例），1781.62秒；97.47%/95.33%/99.65%/99.73% |
| 真实SIGKILL恢复定向 | 6/6，31.68秒；原decision已COMMIT、真进程终止、新pool恢复、零新增调用及原allocation断言保留 |
| 人工豁免与当前消费定向PG | 1/1，27.53秒；实际共享记录缺失与来源过期继续拒绝 |
| 完整 Compliance PG + coverage | 461/461（424普通+同一37项真实来源PG），842.02秒；98.19%/96.41%/100%/100% |

完整37项剧本存储PG包含真实来源/原生锁与四账消费、并发阶段发布、两周期Question、实际大上下文全批次、人类逐问题理由、共享缺行拒绝、unknown显式对账、COMMIT丢确认及真实SIGKILL。普通SQL/共享接口内存夹具仅证明协议和故障处理；实际SQL、FK、隔离、锁、事务和共享持久结果由PG另证。模型HTTP为合成协议回放，不能代替供应方效果或真人质量评分。

执行预算有实测依据：完整V8来源回放的三阶段约44秒、两周期约52秒、超过1MiB实际来源全批次约283秒。基线远端普通文件约本机3倍、Script PG约2倍；新完整本地PG约30分钟，Compliance配置还复用同一完整剧本存储PG文件；两包都保留全部新增来源证明。CI有界总预算为150分钟，集成默认120秒、复合证明240秒、大上下文900秒；单测全局10秒不变，仅16个已测较慢声明增加预算。所有材料、参数矩阵、断言、串行规则、95%四项门槛和生产SDK/Worker截止时间保持。

进程夹具将冷导入纳入120秒检查点/240秒外层预算；子进程使用正常30秒租约及180秒fixture运行期限。实际失败堆栈曾仅到`child-started`，尚未到`fixture-loaded`；短租约不是已证实根因。杀进程后仍以显式SQL使租约过期，再从原COMMIT决定恢复，不靠自然短租约或新的提供方调用制造通过。

新增迁移固定LF，原始字节SHA-256为 `3bdfb42d7e745dcc6e65789f8944adda54f1fda628e3e0fb376d88a30e93e50a`；旧Screenplay迁移 `233a42cc77d6497b1cb63bb86a56e9076a41ee73a8ea5a5dde66b7e2dd553321` 保持。质量schema须由安装者显式安装，运行构造器不迁移或授权。五份既有用户文档与无关研究文件保持原样且排除暂存。

新增认证HTTP/UI、真实文本模型效果、编辑器、法务及设计伙伴验收继续按用户安排后补。推送后须按准确提交SHA读回全部CI job/step；交付回执独立记录完整commit、run链接和最终状态。

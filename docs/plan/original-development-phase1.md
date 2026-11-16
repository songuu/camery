# 阶段1 · T1.3 原创开发

依据v2.1 T1.3及产品3.0/3.1：一句话创意→世界观/人物/主线→分集，每步可修改、重做、恢复；产出保持候选，关键节点经用户决定。T1.2应用已提交`1ffbd27`且远端CI成功。本任务不缩减为几个生成函数，完整范围包括领域、预算持久化、认证应用和实际模型质量；编辑器、法务、设计伙伴确认依用户要求后补。

<!-- design-authority:start -->
## Design Authority（shadow）

- 用户价值：从创意建立可修改、可追溯、可继续写剧本的完整故事设定与分集梗概，避免重开页面重新付费或新分集沿用过时设定。
- 选择：新增`@camery/script`，复用方法/Agent/预算/durable，不依赖Bible的块、来源或提取语义。将世界观、人物、主线放在同一有界foundation候选中，允许跨字段一致性检查；其显式审阅后才能生成整份episodes候选。每阶段独立durable task，不在同一context重复固定步骤名。
- 数据：不可变brief绑定tenant/project/brief/revision、原始创意和分集约束；foundation包含世界设定/规则、人物欲望/阻力/弧光、人物关系与主线冲突/推进/结局。episodes包含严格连续集号、梗概、目标/冲突/转折/收尾及设定引用；它们不是已经写好的场景剧本。题材配方、五件套、钩子类型库及四本账按T1.4/T1.5继续，不能提前伪填完成。
- 预算：brief逻辑JSON≤8KiB，foundation≤32KiB，episodes≤64KiB，完整候选/审阅有界。数量上限不能替代总字节预算；默认10集、最多100集，超限明确拒绝且不截断。上游输入不累计全部历史；组合请求需实测满足Agent完整DecisionRequest≤128KiB、durable≤1MiB。
- 修改与身份：模型原始候选、模型回执、人工编辑后的阶段审阅快照分开保留。下游绑定已审阅上游摘要；改brief或foundation后旧下游保持历史、不能悄悄续用。host提供人类身份、当前范围、规范时点和同步授权，请求不得自报授权。未提供真实文本模型时仍可完成协议/边界实现，但不能冒称真实质量。
- 正式采用：当前IR缺完整开发对象，普通应用ID也不是IR ULID；不把世界观塞进role/title，不把阶段审阅当正式IR采用。完整正式开发对象与ChangeSet、引用/范围、生成JSON Schema的一致接线需要后续阶段1版本应用增量；该要求保留为未完成，不能据独立候选判定完整T1.3或阶段1完成。
- 恢复与应用：追加存储brief/run/阶段结果/审阅，有界目录与独立最小角色；每阶段先预留预算，保持实际原始回执，未知结果显式对账且不自动重发。认证HTTP绑定principal，UI展示待办与过期条件、允许编辑/确认/拒绝，恢复只读取已有状态；生产模型固定于宿主，客户端不能提供URL/凭据。
- revision 2（2026-11-16）：以`camery_script.briefs/runs/candidates/reviews`追加存储实现OD-5。brief按expectedRevision追加，run固定brief/两阶段方法pin/模型与两份预留上限；审阅每阶段首写胜出，人工编辑保留在独立审计。重做使用新run，修改创意产生新修订。锁顺序固定brief→run，已付候选保存不要求最新brief；首次审阅校最新，已提交同身份同语义重试重新授权后返回原审计。任务仅传run/stage/digest引用，未知不重发。目录微秒游标独立于完整数据重建。AC语义保持不变，认证应用与正式IR/真实质量仍不提前判完成。
- revision 2补充：正常调度先读取同一durable任务，排空已付结果的物理尾日志，再处理过期/待审阅/审阅终态。业务`pendingOnly`不能代替未排空任务扫描；后续常驻宿主必须保留这一路径。0001已安装校验和不改，引用侧索引用0002追加；最小角色同时拒绝schema USAGE转授权。
- Acceptance Criteria：
  - OD-1: WHEN 创意进入开发 THE SYSTEM SHALL 保存严格有界的不可变brief、用户分集约束及作用域/版本摘要，不执行正文指令或接受其自报授权。
  - OD-2: WHEN foundation候选生成 THE SYSTEM SHALL 保留世界观、人物、人物关系和主线，严格验证唯一局部身份、完整引用、主角与主线绑定及原始模型回执，不自动确认或伪造来源引文。
  - OD-3: WHEN 用户明确审阅foundation THE SYSTEM SHALL 校验当前brief/候选摘要及真实宿主授权，保留原始候选和人工编辑审计，后续只消费这份已审阅快照。
  - OD-4: WHEN 分集候选生成 THE SYSTEM SHALL 精确满足brief集数、连续顺序与设定引用，绑定上游审阅摘要；旧brief或旧设定不能静默进入新下游。
  - OD-5: WHEN 执行中断或结果未知 THE SYSTEM SHALL 以独立阶段任务、预算账本和原始回执恢复，避免重复付费；不能用普通函数循环冒充恢复。
  - OD-6: WHEN 用户在工作台开发创意 THE SYSTEM SHALL 经认证项目权限开始、查看、修改、确认/拒绝及重做，恢复已存状态，并明确呈现未配置模型或上游已变化。
  - OD-7: WHEN 将开发成果用于正式剧本 THE SYSTEM SHALL 保持完整开发对象与ChangeSet采用权威、作用域和基版本一致；真实模型连贯质量及人工评分必须另有实际证据。
<!-- design-authority:end -->

## 有序任务

| 任务/文件 | 依赖 | 风险 | 完成证据 |
|---|---|---|---|
| 共享有界JSON快照：methods/json，Bible保留原错误映射 | 两个实际消费者；不改方法旧canonical语义 | L3 | 已有Bible对抗回归+新公共接口测试，浏览器入口无Node |
| 冻结script contracts/data及brief | 上述边界 | L2 | OD-1严格字段、摘要/作用域、恶意数据、真实字节限 |
| [P] foundation验证：script/foundation.ts及tests | 冻结契约 | L2 | OD-2重复/悬空/主线/总预算；不把语义质量当结构通过 |
| [P] episodes验证：script/episodes.ts及tests | 冻结契约 | L2 | OD-4精确数量/集号/设定引用/上游绑定 |
| [P] 固定输出契约与原创方法资产 | 冻结契约 | L2 | 两阶段DSL结构一致、原始方法pin、边界模型协议 |
| 阶段候选、回执与人工审阅 | 前三项组合 | L3 | OD-2/3/4原始模型输出、exact请求摘要、单次调用与outcome，人类gate与变更审计 |
| 逐阶段持久化/预算宿主 | 领域完成；现有durable预算 | L4 | OD-5真实PG、重启/未知、权限与无重复调用 |
| 存储实现：`script/src/node/{contracts,store}.ts`及同包测试 | 冻结revision 2接口 | L4 | 追加brief、并发幂等、首写审阅、最新输入、完整重建与无额外授权 |
| 阶段workflow：`script/src/node/workflow.ts`及测试 | 同一冻结接口；组合验证待store | L4 | 实际预算/Agent/durable、SIGKILL、丢确认、unknown与已付旧快照恢复 |
| 显式SQL迁移及最小角色：`node/migrate.ts/runtime-role.ts/migrations/0001-development.sql` | 冻结四表列与权限 | L4 | checksum/回滚/范围FK、全非系统权限闭包和自有canary |
| 有界catalog：`node/catalog.ts`及测试 | 冻结四表列与目录索引 | L2 | 完整scope/微秒游标/有界元信息，不替代确认时完整新鲜度校验 |
| 认证HTTP/可编辑工作台与部署 | 持久化宿主 | L4 | OD-6权限/迟到响应/恢复、真实浏览器、镜像和远端CI |
| 正式开发IR/ChangeSet映射与真实质量 | 上述应用；阶段1版本接线与真实配置 | L4 | OD-7新旧schema、采用/锁/范围/基版本、真实模型及人工证据；未完成不得勾销 |

当前无显式Harness绑定，由本仓测试、PG、浏览器和实际外部结果作证据，不启动外部验收服务。新增package参与根任务图；所有并行任务独占文件且不提交。安装/运行角色分离；迁移显式执行、checksum不改历史，回退代码不删除历史数据。保留用户5份方案脏文件及研究文件。

## 契约与消费者

| 之前 | 之后 | 消费者/一致性 |
|---|---|---|
| Bible私有有界JSON复制 | methods浏览器安全公共primitive，Bible保持错误类型和语义 | 新script、Bible；同边界红绿与回归 |
| 任意创意文本 | 冻结brief及两阶段严格候选/审阅 | 方法、任务、后续API；内容摘要和精确引用测试 |
| 同一次调用内随意串行开发 | 每阶段独立Task及已审阅上游摘要 | 预算/durable/宿主；完整请求预算及恢复测试 |
| 当前IR最小人物/集骨架 | 完整开发对象待显式扩契约与采用接线 | 后续阶段1版本服务；不能猜映射/宣称已采用 |

## OD-1..4 核心交付证据（2026-11-16，7fb8f45）

- 已有OD-1..4领域/方法证据：不可变brief、完整foundation/episodes校验、精确两次原始回执、人工编辑快照和上游过期拒绝；不是OD-6应用或OD-7正式采用/真实质量完成。
- `pnpm check`退出0：2458项（20工具+2438普通），13包类型与覆盖率、478文件策略、6方法golden/10 Agent基线通过。script126项、覆盖率100/98.52/100/100%；共享JSON新增33项，Bible真实PG275项兼容通过。代码/TS/安全复审闭合。
- 实际组合通过AgentRuntime+预算wrapper+公开DurableWorker：每阶段独立task，进程内journal复用不新增provider/allocate；近32KiB设定和128KiB/1MiB边界实际执行。该内存夹具不证明OD-5的PG/强杀/unknown恢复，保持未完成。
- 下一个实施点是独立`camery_script`追加存储与阶段任务：保存brief修订、固定run、逐阶段原始候选、审阅审计；从可信存储读取当前brief及已审阅上游，确认前重新核对，已付旧快照结果仍留存。再接最小权限宿主、认证API、工作台与正式IR采用，不将本轮库级交付改写成完整T1.3完成。

## OD-5 持久化与恢复证据（2026-11-16）

- `@camery/script/node`已实现四表追加存储、显式checksum迁移/引用侧索引、独立SELECT/INSERT角色、有界微秒目录及逐阶段预算/Agent/DurableWorker组合。两份reservation以BigInt核对总上限，方法/model/profile固定；不接受客户端自报批准或替换模型回执。
- 最终`pnpm check`退出0：2569项（20工具+2549普通），524文件策略零问题、lint、13包类型检查（12缓存/1实际）与13包覆盖率全部实际执行；6方法golden和10 Agent基线匹配。script普通237项，覆盖语句99.49%/分支98.58%/函数100%/行100%。
- 最终`pnpm test:script:local -- --coverage`退出0：16文件252项，覆盖99.62/98.78/100/100%。这些252项包含普通237项，不重复累加。真实PG验证并发/隔离/篡改/首写审核与重新授权、最小角色24项能力探针、两阶段丢确认、实际SIGKILL及新pool恢复、unknown不重发与显式对账；经正常dispatcher保留原task、付费旧brief结果，恢复不新增模型调用。
- 已关闭复审问题：getter验证前读取、schema USAGE转授权、引用侧FK索引，以及REPLICATION运行角色能力（真实PG先红后绿）。已有服务端构建子进程曾超时，最终整仓检查包含同一用例通过；没有提高超时或弱化断言。代码/TypeScript/安全复审通过。
- 本机最终日志：`%TEMP%/camery-development-persistence-check-final.log` SHA-256 `b13301719a44b9b513cb10831c78568c1e4cf9222e4f6385eac0d181295613d9`；`%TEMP%/camery-development-persistence-pg-coverage-final.log` SHA-256 `412e7b5af3c7db18d2a526fccfa014366d601a3829ef63ce8cc1a6ca4bde0dc9`。远端结果以最终提交实际Actions为准。
- 下一实施点为OD-6认证HTTP、可编辑工作台和配置型常驻宿主，须同时扫描未排空durable引用；之后继续OD-7正式开发对象/ChangeSet及真实文本模型质量。当前没有安装生产宿主，协议夹具不构成真实模型推理、账单或人工评分。编辑器、法务、设计伙伴后补；完整T1.3和阶段1均未判完成。
- CI补验：`e5ba0cd`新增PG步骤因测试提前引用未安装的access表而失败；改为测试显式安装探针所需迁移、保持42501权限拒绝断言。独立随机空库完整252项与覆盖99.62/98.78/100/100%通过且清理自身库；测试不再依赖既有本机schema或CI套件顺序。日志`%TEMP%/camery-development-fresh-db-final.log` SHA-256 `88baacd7c72362a4cd46fb8edb128cf49cd74f639c29c1f1b3e863898121ca43`。

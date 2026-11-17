# 阶段1 · T1.3 原创开发

依据v2.1 T1.3及产品3.0/3.1：一句话创意→世界观/人物/主线→分集，每步可修改、重做、恢复；产出保持候选，关键节点经用户决定。T1.2应用已提交`1ffbd27`且远端CI成功。本任务不缩减为几个生成函数，完整范围包括领域、预算持久化、认证应用和实际模型质量；编辑器、法务、设计伙伴确认依用户要求后补。

<!-- design-authority:start -->
## Design Authority（shadow）

- 用户价值：从创意建立可修改、可追溯、可继续写剧本的完整故事设定与分集梗概，避免重开页面重新付费或新分集沿用过时设定。
- 选择：新增`@camery/script`，复用方法/Agent/预算/durable，不依赖Bible的块、来源或提取语义。将世界观、人物、主线放在同一有界foundation候选中，允许跨字段一致性检查；其显式审阅后才能生成整份episodes候选。每阶段独立durable task，不在同一context重复固定步骤名。
- 数据：不可变brief绑定tenant/project/brief/revision、原始创意和分集约束；foundation包含世界设定/规则、人物欲望/阻力/弧光、人物关系与主线冲突/推进/结局。episodes包含严格连续集号、梗概、目标/冲突/转折/收尾及设定引用；它们不是已经写好的场景剧本。题材配方、五件套、钩子类型库及四本账按T1.4/T1.5继续，不能提前伪填完成。
- 预算：brief逻辑JSON≤8KiB，foundation≤32KiB，episodes≤64KiB，完整候选/审阅有界。数量上限不能替代总字节预算；默认10集、最多100集，超限明确拒绝且不截断。上游输入不累计全部历史；组合请求需实测满足Agent完整DecisionRequest≤128KiB、durable≤1MiB。
- 修改与身份：模型原始候选、模型回执、人工编辑后的阶段审阅快照分开保留。下游绑定已审阅上游摘要；改brief或foundation后旧下游保持历史、不能悄悄续用。host提供人类身份、当前范围、规范时点和同步授权，请求不得自报授权。未提供真实文本模型时仍可完成协议/边界实现，但不能冒称真实质量。
- 正式采用：早期IR缺完整开发对象，revision 5补齐类型与版本基础；普通应用ID仍需持久映射IR ULID，不把世界观塞进role/title，不把阶段审阅当正式IR采用。完整开发对象到ChangeSet的认证应用接线继续实施；OD-7保留未完成，不能据领域类型和事务能力判定完整T1.3或阶段1完成。
- 恢复与应用：追加存储brief/run/阶段结果/审阅，有界目录与独立最小角色；每阶段先预留预算，保持实际原始回执，未知结果显式对账且不自动重发。认证HTTP绑定principal，UI展示待办与过期条件、允许编辑/确认/拒绝，恢复只读取已有状态；生产模型固定于宿主，客户端不能提供URL/凭据。
- revision 2（2026-11-16）：以`camery_script.briefs/runs/candidates/reviews`追加存储实现OD-5。brief按expectedRevision追加，run固定brief/两阶段方法pin/模型与两份预留上限；审阅每阶段首写胜出，人工编辑保留在独立审计。重做使用新run，修改创意产生新修订。锁顺序固定brief→run，已付候选保存不要求最新brief；首次审阅校最新，已提交同身份同语义重试重新授权后返回原审计。任务仅传run/stage/digest引用，未知不重发。目录微秒游标独立于完整数据重建。AC语义保持不变，认证应用与正式IR/真实质量仍不提前判完成。
- revision 2补充：正常调度先读取同一durable任务，排空已付结果的物理尾日志，再处理过期/待审阅/审阅终态。业务`pendingOnly`不能代替未排空任务扫描；后续常驻宿主必须保留这一路径。0001已安装校验和不改，引用侧索引用0002追加；最小角色同时拒绝schema USAGE转授权。
- revision 3（OD-6应用接线）：新增浏览器安全`script/http`请求/视图契约、node投影与同源`/api/v1/projects/:projectId/development`。brief写入/开始需task:run，读取需project:read，逐阶段确认/拒绝需candidate:review；principal独占tenant/actor，宿主独占methods/execution。保存创意不依赖已配置模型；只有明确开始才入队。只读状态不入队或调用模型，公开投影不含原始模型回执/执行配置。确认foundation成功后显式调度episodes；重做用新run，修改创意用新revision，旧结果可读且过期不可首次确认。常驻宿主有界轮询全部运行并精确runTask，不能用pendingOnly漏掉物理尾部。配置默认关闭，显式启用独立存储/任务角色，密钥仅服务端文件。前端采用现有会话/项目失效边界、同源API及人工可编辑字段；正文/凭证不写浏览器存储。接口/宿主/工作台需真实HTTP、PG、构建镜像和浏览器验证；未配置真实文本模型仍不得宣称语义质量。
- revision 3.1：补全未开始运行的已保存创意发现入口，`GET development/briefs`每页最多20个最新修订元信息（短预览/作者/时间），scope绑定游标按briefId的C顺序定位；点击后鉴权读取完整最新brief。复用既有brief追加表与最小角色，无新迁移。状态读取先取两Task，再读单调追加审计，避免并发确认把旧上游快照与新episodes任务组合而误报不可用；新鲜度仍由首次review事务判断。原OD验收语义保持不变。
- revision 4（逐阶段重做）：采用新run加追加origin引用，保留旧run/Task/回执/审计/预算字节；不在子run伪造foundation候选或审阅行。重做foundation创建完整新计划；仅重做episodes从可信源解析真实已审阅foundation，扁平固定实际生成owner/profile及candidate/review摘要，另保留直接parent谱系。继承内容只读，原作者/时点/回执不变，源模型凭据无需仍可用；新episodes可用当前受信模型。分支显式使用workflow@2，旧workflow@1、digest和journal不改；episodes-only只预留一份预算、不得创建伪foundation任务。HTTP主体只含新ID与预期摘要，principal与宿主独占作者/profile；trusted Task+steps检查拒绝active/reconciling及cancelled仍有unknown external的源目标，不以新分支绕过对账。数据事务核对实际source和最新同brief、固定brief→排序run锁、原子插入child/origin，相同语义丢ack重试返回原分支。源目标尚未执行不可称重做；改brief后走完整新开发。公开谱系明确受影响阶段及旧内容是历史分支，正式采用后的跨对象失效仍由后续IR版本权威完成。0001/0002不改，仅追加0003与第五表最小SELECT/INSERT；运行时不迁移，回滚先关闭development功能并保留新历史。
- revision 5（OD-7正式开发对象）：引入v0.6完整typed World、Character开发字段、CharacterRelationship、DevelopmentPlan和EpisodePlan；规则/问题key属于明确的world/plan命名空间，人物及对象引用使用ULID，不按名字合并。Plan完整保存brief、主线、未决问题及已审阅来源；EpisodePlan完整保存分集目标/冲突/转折/收尾和来源。RevisionRef固定实际依赖版本，过期依赖在正式校验/预览中明确提示，后续生成消费者须拒绝静默使用。阶段审核与正式采用继续分开，应用仅将完整已审核的两阶段结果预览成ChangeSet，用户另行采用/拒绝。
- revision 5兼容：冻结v0.5 schema/validator，公开读取严格按版本分派，新建正式项目用v0.6。旧head和旧pending保持原语义；exclusive `upgrade_schema` ChangeOp只允许0.5→0.6、精确当前base_revision、project范围，复用采用/快照/审计。其他live pending存在时拒绝升级且原状态不变；先审核旧候选再升级。升级仅加空新集合、旧对象ID/version不改；升级后拒绝新增v0.5写入，历史和已采用ACK仍可读/恢复。v03迁移仍明确输出/校验v0.5；生成JSON Schema同时描述两版，不重写历史请求或靠隐式defaults伪造开发内容。
- revision 5采用权威：普通tenant/project/user及来源局部身份先独立持久化映射ULID；每个application intent固定来源摘要、映射、IR基版本及完整ChangeSet摘要，重试不重新分配身份。桥接器拥有项目内稳定plan/episode槽位，source人物/world/关系按实际foundation owner+局部身份映射；全量新设定不按姓名覆盖旧人物，已有正式对象经对象base与锁重新检查。空planning baseline不造Scene/Shot/Media，也不提前填未来T1.4/1.5内容。
- revision 5事务与权限：来源latest guard与正式采用必须在同一个PG连接/事务中执行。VersionStore新增node-only `adoptGuarded(key,changeId,options,guard(client))`，先来源brief→排序run advisory locks并完整重建审核，再version project行锁和原engine/快照/历史/采用COMMIT；普通adopt/read维持旧路径。两个连接的锁桥因来源连接断开会释放锁而拒绝采用。独立最小adoption LOGIN只读script、具备identity/intent必要追加和versioning必需DML；不提升已有append-only身份，不授予认证/预算/任务/迁移能力。已adopted重试先核对intent和版本权威、重新授权后恢复原记录；尚未采用者必须重新校最新来源。连接断开整体回滚，提交ACK丢失按同intent/changeId恢复；锁序不能反向。
- revision 5.1（共享身份/CAS，2026-11-17）：依据VCA-002/LIN-006，普通tenant/project/principal到版本域的绑定由`server/src/projects`唯一维护，script只维护其来源局部对象身份。共享绑定采用独立`camery_projects`迁移：tenant、project、principal三张追加表；project映射以真实版本域二元key作FK，不创造空项目或悬空项目表。显式受信注册者提供规范ULID；同语义注册幂等，不同绑定冲突，禁止别名映射和重绑。principal按tenant+kind+普通key区分user/agent_run/system，不把Agent映射成人类。读取仅解析既存绑定，缺失返回PROJECT_BINDING_MISSING或PRINCIPAL_BINDING_MISSING，不分配身份、不初始化IR。安装者和独立只读LOGIN分离；先有实际版本项目再注册，运行角色不能注册/迁移或访问认证/预算/任务/正文。
- revision 5.1并发契约：VersionStore提交/采用/拒绝可选接收`expectation={expectedSnapshotRevision,expectedWriteVersion}`，严格为正安全整数，异步前捕获。旧调用不变；带期望的首次写入在version project行锁内核对，失败不改任何表。精确同ChangeSet重试和已采用ACK先识别不可逆结果，再走原有引擎的当前授权/范围检查，不因旧CAS把成功误报为失败；异内容同changeId不获重试豁免。guarded采用仍先source锁再version锁，不能为了CAS反向锁序。拒绝的完整幂等回执留给后续持久intent，不把无记录scope的旧拒绝冒称可恢复。共享绑定与版本CAS各自独立测试；当前尚不暴露新的HTTP/正式采用UI，也不宣称完成P-APP/G-PROJECT。
- revision 5.2（完整映射与持久意图，2026-11-17）：普通身份继续由共享projects注册表解析；script新增0004仅保存来源局部到IR对象的追加身份。按真实foundation owner+localId绑定World/Character/Relationship，按普通项目稳定绑定DevelopmentPlan与1..100集Episode/EpisodePlan槽位。准备命令使用已校验的来源四摘要和既存版本key，自己的READ COMMITTED事务借用readForAdoption先锁brief→真实owner runs，再锁项目映射；所有身份先独立提交且重试复用，不按姓名合并。target只是受信宿主解析结果，重复准备须核对已有稳定plan锚点的同一target；此表不成为第二个普通项目权威。旧5表数据角色不扩权，所有旧迁移保持。
- revision 5.2映射：`prepareDevelopmentDraft`纯函数重建run/原候选/回执/已审核快照，核对owner、scope、四摘要、完整局部映射及真实原审核者绑定；拒绝旧v0.5目标而不自动升级。World/人物欲望阻力弧光/关系/主线/问题/各集全部正文与来源完整写入新类型，不造Scene/Shot/Media；保留同身份人物的配音/既有role。对象base涵盖全部已读取依赖，父/人物/规则引用固定预计写后版本。完整新设定使用新owner对象并保留旧对象；缩减集数只移除本桥接器已映射的旧EpisodePlan和Episode，不删除人工场景或媒体，悬空/锁由原版本引擎拒绝。规则/问题局部key不当对象字段名；无差异返回空draft且持久保存unchanged意图，不伪造空ChangeSet。`finalizeDevelopmentChangeSet`只接受已固定changeId/逐slot operationId及映射人类author，不自行分配ID或宣称授权。
- revision 5.2共享意图：`camery_projects`新增0002追加candidate intent/prepare receipt/decision intent/decision receipt四表，原0001不改。scope+applicationId固定提交命令摘要、来源manifest/局部身份/原审核者、目标key、作者、双版本base与完整ChangeSet；同命令竞争按去除新分配change/op IDs后的业务摘要复用首条，异语义冲突，不在重试重新编译。prepare/noop回执保存原基线含义，不冒称当前head仍相同。adopt/reject意图按scope+实际actor+请求ID绑定动作、candidate、scope、理由与首次宿主时点，先独立提交；精确已有回执仍须每请求重新鉴权，换作者或主体不继承授权。共享表引用真实普通/版本项目与principal绑定，不要求外部供应商schema。没有回执不把其他相似拒绝猜为本次成功。
- revision 5.2回执原子性：VersionStore新增node-only `submitWithReceipt(key,request,options,receipt(client,result))`、`rejectWithReceipt(key,changeId,options,reason,receipt)`，`adoptGuarded`可选第五参数receipt。回调仅受信宿主构造，在同一checked-out连接/事务中完成原engine/快照/历史/采用写入后、COMMIT前追加实际结果回执；回调失败整体回滚，COMMIT ACK丢失靠独立保存的intent及同事务receipt证明恢复。guarded的来源锁→version行锁和仅ADOPTION_SOURCE_*的受限并发ACK恢复保持。普通旧方法保持语义；不把“版本提交后再单独写回执”当原子成功，也不把请求JSON函数当受信回调。
- revision 5.2.1（复审关闭边界）：已有映射由完整原子prepare创建，allocator前必须验证旧plan锚点、当前owner完整组及连续完整分集pairs；残缺/旧锚点零分集明确拒绝，不能静默换ID。回执回调增加VersionStore提供的第三参数执行context：submit动作；或adopt的真实捕获actor/scope/at及在project行锁内判定的replayed；或reject的真实actor/scope/at/reason。回执器核对冻结决定与实际context；首次采用还核原AdoptionRecord，历史ACK保留原记录不冒称当前actor重新采用。拒绝成功须原rejection与intent的actor/reason/at一致，scope由实际context证明；任何错绑整体回滚，原子同连接不能代替此语义核对。第三参数由版本宿主构造，不接受请求自报。
- revision 5.2.2（完整执行信封）：context同时携带实际捕获的版本域二元project key和CAS expectation，submit绑定实际requestSignature，adopt/reject绑定实际changeId。回执器必须逐项核对固定intent，不能只比较head.project.id或替换旧CAS；跨租户同ULID项目亦拒绝。所有callback未知异常只按安全own data descriptor读取cause/code，不触发getter或泄露driver内容。决定回执first-wins还须与本次结果一致；已有拒绝/失败回执不能在后续同intent调用里静默变成新成功决定。若冲突，回滚本次新决定；只有无新写入的实际adopted重放可保留同一原采用事实的旧回执。prepare/noop保留原基线语义，不能与决定回执混用。
- revision 5.3（认证采用应用，2026-11-17）：共享`ProjectApplication`统一身份、scope/RBAC、版本读取/纯预览/候选/决定及来源策略；普通GET与preview不分配ID、不保存意图、不调用模型。显式POST准备原创候选绑定已审核run四摘要及双版本，先查同命令旧intent/receipt，再准备局部身份/完整映射和原审核者绑定、保存完整intent后提交；不把准备当采用。采用/拒绝先重新认证并核review权限，固定requestId与实际scope/CAS/理由，依原intent恢复，development采用始终使用该intent的source guard，拒绝可处理旧来源。未注册主体/项目明确拒绝，原native候选可读但无来源策略者不擅自当manual管理或采用；兼容缺口保持可见。
- revision 5.3公共契约由`@camery/ir/workbench`单一浏览器安全导出，success是`{data,requestId}`。新增GET `P/workbench/state`、`P/workbench/candidates`与`/:id`；POST `P/workbench/changes/preview`、`P/workbench/candidates`、`P/workbench/candidates/:id/adopt|reject`、`P/workbench/schema-upgrade`及`P/development/:runId/candidates`。非preview写入要求单个规范Idempotency-Key；prepare/submit/upgrade与body.applicationId一致，决定ID独立绑定actor/route/body。所有身份仅真实会话提供，候选body不得自报source/授权/执行配置，manual不能新造或改写已审核开发source。只有明确升级候选可由5升6，GET/prepare不自动升级。public差异最多500、列表最多50，仅操作列表限制body上限，不扩大所有路由16KiB默认。
- revision 5.3运行边界：独立readonly身份pool与最小adoption pool，source五表仅SELECT、局部身份/intent/receipt仅SELECT/INSERT、版本projects仅SELECT及UPDATE(head_revision,write_version)、快照/历史/采用仅SELECT/INSERT、changes仅SELECT/INSERT及UPDATE(status,record)、必要sequence仅USAGE；禁止auth/预算/tasks/迁移/DDL/成员/复制/转授权等能力。API启动只verify，不迁移/grant；默认关闭`CAMERY_PROJECTS_ENABLED`，启用读取两个有界secret文件`CAMERY_PROJECTS_READER_DATABASE_URL_FILE`与`CAMERY_PROJECTS_ADOPTION_DATABASE_URL_FILE`，tenant沿CAMERY_TENANT_ID。没有文本模型也可审阅既存完整成果，宿主不创建ModelSession或外部付费任务。
- revision 5.3用户流程：已有原创工作台仅在正式采用feature可用时提供准备入口，显示来源过期/项目绑定/旧格式等条件；准备后展示可核对diff/基版本/锁或冲突，用户另行采用或填写理由拒绝。候选按run恢复目录，权限/会话/项目/run改变同步清理，迟到响应不串项目；网络失败沿原application/requestId重试，不重新分配语义。schema5仅提供独立升级候选，不隐式转换。确认仍是明确的人类动作；真实编辑器/法务/设计伙伴后补及模型质量未知不改写。
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
| 逐阶段回退重做与受影响范围 | 已保存人工上游与正式开发身份/版本权威 | L4 | revision 4支持完整设定重做与仅分集分支：原上游/回执/审计保持、单份新预算、unknown门禁及直接来源/真实owner谱系；正式IR跨对象版本影响仍随OD-7继续，不以本批分支交付判整项完成 |

revision 4执行分工：root负责contracts/origin绑定、v1/v2工作流/调度/投影/目录、trusted redo gate与HTTP契约/API及组合验证；数据库worker负责store的origin解析/fork事务、0003/migrate/runtime-role与对应PG/内存driver测试；UI worker负责原创界面/APIclient及重做/谱系/确认预算的实际交互；runtime worker负责可信单阶段profile派生适配、双workflow注册与构建容器/部署测试。契约在实施前冻结，子任务不提交；PG和覆盖率仍串行。门槛包括旧v1重放、源profile不同与旧secret不可用、零新增foundation调用/预算、仅一份新episodes allocation、unknown/cancelled拒绝、并发fork/丢ack/强杀、scope/篡改、HTTP与真实浏览器及最终远端CI。正式IR另需完整类型对象、普通ID→ULID持久映射、旧0.5 head/候选兼容和原子采用来源权威，不将本批重做假定为OD-7完成。

revision 5任务与顺序（均L4，依赖完成前不标并行）：

| 文件集合/owner | 前置 | 完成证据（OD-7） |
|---|---|---|
| root：ir frozen-v05/schema/validator/node生成器与相关测试 | 本revision契约 | 旧fixture/迁移输出逐字语义保留；完整新对象及跨对象/命名空间引用、来源/总预算；生成schema一致 |
| version事务worker：versioning/node/store/types及独立guard测试 | node-only guard签名冻结；不依赖新对象 | 普通路径回归；同client guard先于version行锁、并发/断连全回滚/ACK恢复、重新授权；不启动PG/覆盖率由root串行 |
| root：versioning engine/evaluate/objects升级与新对象范围 | 新IR | exclusive升级、pending冲突、精确base/project权限；新集合对象版本/锁/范围/过期依赖，新旧历史重放 |
| root随后分配：script/node source guard、identity/intent与纯映射 | 新IR+guarded adopter | 实际owner身份、同intent/不同摘要冲突、旧记录不改、source并发/篡改、实际最小LOGIN；不改已安装迁移 |
| root随后分配：server/web preview→adopt/reject及部署 | 上述能力与HTTP契约冻结 | 认证scope/actor/权限、只读GET、过期/锁/基版本提示、丢ACK、真实PG/浏览器/镜像/最终CI |

revision 5.1执行边界（L4）：共享身份worker独占`server/src/projects/{contracts,identity-map,migrate,identity-role}.ts`、`projects/migrations/0001-identity-bindings.sql`及`server/test/project-identity*.ts`；版本CAS worker独占`versioning/src/node/{store,types}.ts`及新CAS测试/该包说明。两项前置已冻结，互不依赖、不交叉文件，均先红后绿且不提交；根负责`projects/authority.ts`及测试、server已有workspace依赖/锁、部署构建与串行PG、整仓及组合复审。宿主authority先用真实会话权限再解析映射，固定普通scope/映射user及版本域key；采用回调再次核对actor/key/scope和宿主权限，不把绑定当grant或允许Agent伪装人类。运行时不修改已有数据角色或旧迁移；回滚关闭未来共享采用入口，保留追加绑定与历史。此任务继续OD-7和共享VCA-002/LIN-006的基础能力，其他应用、intent、完整映射与质量条件保持原范围。

revision 5.2文件责任/有序验证（均L4，不按低风险标记并行）：root冻结`script/node/adoption-contracts.ts`并负责共享projects intent/receipt存储、0002及组合；纯映射worker独占`script/node/development-mapping.ts`及`script/test/development-mapping*.ts`；局部身份worker独占`script/node/ir-identities.ts`、0004、migrate及相应迁移/新身份测试；事务worker独占`versioning/node/{store,types}.ts`、新receipt测试及该包说明。三个实现的冻结接口无文件交叉、互不依赖未实现的内部逻辑，子任务不提交；包清单、barrel/锁、API/UI接线由root串行。单测先红后绿；root串行PG/覆盖率，验证真实owner/LOGIN、并发/丢ACK/实际终止、来源变更/锁/base、完整对象采用与无伪造回执，再整仓/镜像/远端CI。独立采用LOGIN与认证工作台仍须接入后实测，库/组件交付不提前判完整OD-7、P-APP或阶段1完成。

revision 5.3责任：root独占IR/workbench DTO与单一回执schema复用、server projects应用/投影/catalog/controller/options、app/main/Development capabilities接线、显式追加catalog索引迁移、HTTP/PG组合；运行worker独占`projects/{adoption-role,config,runtime,ids}.ts`及对应测试、`deploy/projects.md`，runtime返回`{options:ProjectApplicationOptions,close}`不改main。前端worker独占web新`DevelopmentAdoption*.tsx/ts/css`、`api.ts`、DevelopmentPane/Workbench/App必要接线及web对应测试；沿现有视觉，不改root DTO或server。边界已冻结，文件互不相交；worker先红后绿、不提交/安装/PG/coverage，root串行组合及最小LOGIN/HTTP/浏览器/镜像/CI。完整P-APP其他工作台投影/补偿/媒体字节、T1.9其余能力和阶段1后续任务继续，不以此切片缩减整个目标。

revision 5.4（共享读取，2026-11-17）延续OD-7与上位AC-VCA-02/06/10，不复制验收语义：补`readSnapshot`、`readObjectHistory`、`readReadyAsset`及正式内容浏览，保留既有候选/决定权威。只读PG适配器从原versioning快照与对象历史查询，不新增表/迁移/权限；普通读取不加载全部候选与全部历史，不分配身份、不写或调用模型。选择直接SELECT现有追加记录而非第二套投影主表，回滚只移除读取/UI接线，既存正式数据与意图保留。

revision 5.4冻结契约：`GET P/workbench`输入episodeId/sceneId/renditionId/collection/expectedRevision/cursor/limit，最大200完整对象；页游标绑定普通与IR项目、真实用户、过滤及snapshotRevision，head变化明确SNAPSHOT_STALE，不拼接不同快照。范围只从已采用快照解析真实归属，返回实际版本引用、精确取用数值、业务关系与锁；跨范围的引用作为context对象，来源边不被标为generation_input。每页关系只随本页from对象返回，显式版本pin与当前版本分开，旧pin标stale而不改写。响应以完整行按字节预算分页，单对象超限明确拒绝，不截断正文。

`GET P/workbench/objects/:collection/:objectId/history`最大50历史版本、包含删除墓碑和实际snapshot/changeId；游标另绑定collection/object及当前快照，读取在同一SQL视图核对版本头，已删除对象仍可读历史。`GET P/workbench/assets/:assetId/versions/:version`先认证、普通映射与实际资产版本校验，未装配归档/字节能力明确ASSET_NOT_READY；ready元信息也不伪造可读媒体句柄，公共快照/历史移除asset.file.path。所有成功沿统一envelope，HTTP新路由仍默认16KiB，browser DTO仍只IR/Zod；不把UI正文持久化浏览器。

有序责任/证据（读取授权整体L4，不能以纯投影通过代替组合）：root拥有公共DTO、应用/HTTP/运行端口接线和真实PG/权限/稳定分页组合；只读存储worker仅`projects/read-store.ts`、独立reader测试；纯投影worker仅`projects/read-projection.ts`、独立projection测试；前端worker仅`FormalProject*.tsx/ts/css`、api方法、DevelopmentAdoptionPane必要入口与前端测试。接口先冻结，三个子模块无文件交叉且不调用彼此未实现内部逻辑，子任务只定向测试、不安装/提交/PG/coverage。root完成后串行组合、typed lint/13包/coverage、真实LOGIN/并发head更新/游标错绑/墓碑/素材未就绪、真实浏览器及镜像和远端CI。完整P-APP补偿/原生来源登记、T1.9剩余能力和阶段1后续任务仍保持未完成。

回滚边界：新项目/显式升级后不能用只识别v0.5的旧镜像读取，先关闭新采用入口并保留新版历史，不能删除新集合或降版本伪装回退。完整OD-7真实文本质量仍需实际配置；新对象/桥接通过不能代替真人评分。实现前已检查placeholder、内部一致性、scope及歧义，本revision保留OD-1..7原有AC语义，未绑定外部Harness。

OD-6文件责任：主agent负责`script/http`及node投影、`server/development*.ts`中的HTTP/options、`app.ts/main.ts`、包清单/锁、CI与组合验收；宿主worker仅负责新`server/development-config/runtime/host/task-role/worker-main.ts`及对应测试、build入口/构建测试、Dockerfile与宿主部署说明；前端worker仅负责`web/src/Development*.tsx`、development状态/样式/API-client方法与`App.tsx`及对应测试。共享契约先冻结后供前端消费，文件不得交叉修改，子任务不提交。API与worker连接池分离、运行时不迁移/授予权限；回滚以关闭功能和回退镜像为界，保留追加历史。L4组合由主agent执行，PG/覆盖率串行。

当前无显式Harness绑定，由本仓测试、PG、浏览器和实际外部结果作证据，不启动外部验收服务。新增package参与根任务图；所有并行任务独占文件且不提交。安装/运行角色分离；迁移显式执行、checksum不改历史，回退代码不删除历史数据。保留用户5份方案脏文件及研究文件。

## 契约与消费者

| 之前 | 之后 | 消费者/一致性 |
|---|---|---|
| Bible私有有界JSON复制 | methods浏览器安全公共primitive，Bible保持错误类型和语义 | 新script、Bible；同边界红绿与回归 |
| 任意创意文本 | 冻结brief及两阶段严格候选/审阅 | 方法、任务、后续API；内容摘要和精确引用测试 |
| 同一次调用内随意串行开发 | 每阶段独立Task及已审阅上游摘要 | 预算/durable/宿主；完整请求预算及恢复测试 |
| 早期IR最小人物/集骨架 | v0.6完整类型、双版读取与同事务来源guard已补；持久映射和采用应用继续 | 后续阶段1版本服务；不能猜映射/宣称已采用 |

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

## 原创开发应用交付证据（2026-11-17）

- 白名单`script/http`契约、公开投影、已保存但尚无run的创意目录和同源认证API已接入；principal绑定租户/作者，宿主固定balanced两阶段方法/模型/预算。前端逐字段编辑、原始候选对照、同ID网络重试、过期/unknown提示及同步作用域清理已落地。常驻宿主有界扫描全部运行，排空原Task后再处理业务状态；默认关闭，无文本配置仍可保存/恢复创意与审阅历史。
- 最终`pnpm check`退出0：2632项=20工具+2612普通；558文件策略零问题、lint、13包类型检查（11缓存/2实际）与13包覆盖率全部实际执行，6方法golden/10 Agent基线匹配。script247项覆盖99.23/98.10/100/100%，server156项98.96/95.84/100/100%，web103项99.72/100/100/100%。web纯TS覆盖率不替代TSX交互证据。
- 串行真实PG：`pnpm test:script:local -- --coverage`263项（含普通247）覆盖99.34/98.28/100/100%；`pnpm test:server:local -- --coverage`171项（含普通156）覆盖98.27/96.72/100/100%。新增验证latest brief元信息/分页/空白预览、独立认证/数据/任务LOGIN、两阶段人工编辑/API重启/预算/过期/撤销，及共享task角色拒绝REPLICATION和schema USAGE转授权。重叠普通测试不重复累计。
- 最终镜像`sha256:8d75b4b71fa31b1096a96fefcd038b3fb6e8f97c14a6f6bf496ef6e346cd7f12`构建成功，`pnpm test:private-development:local`退出0：同镜像API/worker经独立HTTP合成协议夹具完成两次请求，人工设定进入分集、预算预留200tokens、无关任务保持queued、日志无凭据/正文，API重启后读取同一审计。容器SIGKILL发生在设定候选已保存且待审阅边界；核心PG另覆盖decision SQL提交后、candidate保存前的强杀，不混称同一触发点。新镜像的原API两档2项及章节worker1项也通过。
- 真实Chromium验收`node artifacts/delivery/development-browser/verify.mjs`退出0，12项（3轮完整两阶段+9边界）全过；覆盖同ID丢ack重试、所有业务字段/结构/引用、总字节/集号闸门、10集分页、整体新run重做、无模型保存恢复、迟到status/start/review、401/403、过期/unknown及A→B→A清理。所有context无JS pageerror，核心旅程无非故障注入console error/未访问Bible请求。320px scrollWidth=320，桌面/窄屏/unknown截图由E2E与主agent看图；4 traces和[本机报告](../../artifacts/delivery/development-browser/report.html)保留。此层为真实React/Nest HTTP加typed内存协议存储，不冒称PG或真实模型质量。
- 关闭先红后绿问题：并发确认组合旧audit和新Task误报503、合法正文的全空白短预览、保存后标签定位、未访问页面后台404，以及缺favicon。代码/TypeScript/安全审查通过，新增配置例外只允许无密钥的development示例入库。真实文本供应方/语义质量/人工评分未配置，正式IR/ChangeSet、逐阶段单独重做及失效影响仍须继续；完整T1.3与阶段1未判完成。Resolve编辑器验收、法务、设计伙伴依用户要求后补，未改动既有ComfyUI图像接线。
- 最终证据SHA-256：整仓日志`%TEMP%/camery-development-application-check-final.log`=`9a44c5d4c867b3aea2386ded7037bcf48b4da17f2d51878f3e5856f5926db9e1`；script PG=`a73d4a0e0d63686a22109bb271e92fdcb0b63deed70f623d0feb118ad0e0c46c`；server PG=`66912ce9a6cf73862234eaadf4480182a52789ec7bc6bf89eca39dc6380a47f2`；最终容器日志=`8efe44c9497ae8860eee6f184af1c8665a3087d8b23fb07320e2c404f321025c`；浏览器result.json=`f3ca8ab8e34517aac7a36e73df6f8066529c0998e8491c965a896646ca83853c`。远端CI以最终提交实际Actions为准。

## revision 4 逐阶段重做证据（2026-11-17）

- 新run与追加origin区分直接parent和实际foundation生成owner。完整重做不沿用审核；仅分集重做复用原候选、原模型回执与人工编辑审核，原actor/时点/digest保持，继承内容只读。新分集绑定当前受信profile及自己的callId；只创建一个v2分集Task和一份reservation。旧v1 digest、driver/journal和既有Task/预算保持，公开谱系移除原执行配置。
- trusted redo服务核对真实Task及steps：queued/running/waiting、reconciling、取消但仍有unknown/running外部步骤均拒绝新分支；已提交child经同语义fork核对后优先找回原Task。HTTP仅接收引用摘要，principal独占scope/actor，GET只读。eligibility先读Task headers再读追加审核，修复并发confirm时合法新Task与旧审核组合误报503；真实PG先红复现目录沿用child查foundation导致失败，改为scoped origin真实owner连接后转绿。
- 新迁移0003仅追加origin及完整scoped复合FK/索引；第五表角色仅SELECT/INSERT。已安装SHA-256为`f9221dad33b4ab6b28ef183264afc1a2810fcb30e9c03d1c231dd4ea16d84391`，0001/0002未修改。真实PG覆盖并发fork/丢ack/回滚/新pool、篡改/只读继承、独立最小LOGIN及约束探针。v1设定与v2分集均在decision SQL提交后、candidate保存前实际SIGKILL；正常dispatcher+新pool恢复原Task，新增provider调用为0。v2保留原始source/foundation及3份既有allocation/300tokens；此窗口不证明provider在途或SQL提交前可安全重发。
- 最终`pnpm check`退出0：2686=20工具+2666普通，563文件策略零违规、typed lint、13包类型与13包覆盖均通过，6方法golden/10 Agent基线匹配。script普通290项覆盖98.77/97.80/100/99.83%，server普通162项98.65/95.90/100/99.50%，web108项99.74/100/100/100%。追加强杀测试后script类型与严格lint再通过；串行`pnpm test:script:local --coverage`309项、`pnpm test:server:local --coverage`178项均退出0，PG含普通测试，不重复累加。服务端真实三类LOGIN、实际journal unknown/取消门禁、重复扁平fork、原始完整Task/审计/预算、API重开与catalog均验证；7次合成调用与7份allocation/700tokens。
- 最终镜像`sha256:4feff2be0e39b937f2c7da1c2a9bdce497e0ce296e245dffb305c93ae0c8e322`构建成功，`pnpm test:private-development:local`1项通过：独立HTTP协议服务实际3次请求、3份allocation/300tokens、新分集一份预算、原设定证据不变及API重启谱系。原API两档2项、章节worker1项兼容通过。容器强杀仍是原设定已保存待审核边界；v2 decision后强杀由上述PG单独作证。代码/TypeScript/数据库/安全复审闭合，无未处理阻断发现。
- 真实Chromium16项通过：保留原12项，新增3轮完整逐阶段重做及active/unknown门禁。验证丢ack沿用原ID、旧候选/receipt/actor/time字节保留、单份模拟预留、旧/新profile、无伪foundation Task、子分支再次重做扁平来源与新候选编辑审核。桌面及320px截图经E2E与主agent看图，新增3份traces保存在[本机报告](../../artifacts/delivery/development-browser/report.html)。此层仍是React/Nest与typed内存协议夹具，模拟reservation不代表PG账单；全部协议/PG/容器证据均不代表真实文本模型质量或人工评分。
- 最终日志SHA-256：`%TEMP%/camery-redo-check-final.log`=`5ebfdae0b3e9767384ede2afb7dfb35a2921de3a0205489878999b4e8717f093`；`camery-redo-script-pg-final.log`=`1bcbd89738a064c7988139ae0af06a81673514776c38084f1d3de06c640c4cda`；`camery-redo-server-pg-final.log`=`1b0bc17cc09996f1cf9080c12223f5fd0b834d898e497ddc10ca448b232d49d1`；`camery-redo-container-final.log`=`3e65fcfbc6236e888907362c78b8e62fc661a8e59da5778ceb2b2c8d1f60c91e`；浏览器result.json=`a0911a99038af569733af1f852beb74d3913ed13f9e3d867909736b5d07671a7`。远端CI仍以最终提交的实际Actions为准。
- 下一项继续OD-7完整开发IR/ChangeSet：普通应用ID到ULID的持久身份、旧0.5 head/候选兼容、完整类型对象及正式采用的原子来源/基版本权威。正式IR跨对象失效影响和真实文本模型质量仍未完成，不能据本批分支交付判完整T1.3或阶段1完成。编辑器验收、法务、设计伙伴按用户安排后补；既有ComfyUI图像接线保持。

## revision 5 类型与来源事务基础证据（2026-11-17）

- IR v0.6新增完整World、人物开发字段、人物关系、DevelopmentPlan及EpisodePlan；来源固定真实普通scope、run/brief/candidate/review摘要和原审核作者/时点。局部规则/问题有各自命名空间，跨对象依赖区分缺失、未来版本和历史版本；历史pin不自动改写，过期依赖保留警告供后续生成入口检查。严格v0.5读取与v0.3迁移输出保持；公开JSON Schema是严格双版union。
- 旧项目仅通过project范围、精确base的独占`upgrade_schema` ChangeOp由5升6；旧候选先处理，升级候选阻止新提交，新增集合为空且不改旧对象身份/版本。真实PG升级后重开pool，核对旧请求、预览、历史和三份快照保持；新schema不会被旧版镜像自动降级。
- `VersionStore.adoptGuarded`在同一READ COMMITTED连接中依次执行来源锁与重建、version project行锁、原engine/快照/历史/采用COMMIT。已采用重试仍重新授权；仅明确的来源拒绝允许第二事务找回真实已采用ACK，存储/断连/COMMIT异常不得触发这一恢复。实际PG覆盖相同backend/txid、阻塞顺序、连接终止全回滚、提交丢ACK及并发ACK重新授权。
- script的node-only来源guard借用采用连接，按brief→排序child/真实foundation owner run锁重建原始候选、模型回执和人工审阅；核对最新brief及四份摘要，无自建事务/连接。真实PG10项覆盖追加brief阻塞至正式提交、已过期/未审核/拒绝/篡改/跨scope拒绝，以及仅分集重做复用原foundation审计且没有伪造child foundation行。此层使用既有v0.5夹具目标验证组件事务，不能视作完整开发成果已正式映射。
- 最终`pnpm check`退出0：2750=20工具+2730普通；576文件策略零违规、typed lint、13包类型检查与13包覆盖率全部通过，6方法golden/10 Agent基线匹配。IR392项覆盖98.15/97.00/98.36/99.76%，versioning186项98.09/95.83/99.17/99.78%，script306项98.72/97.76/100/99.84%。串行真实PG versioning216、script335、server178项均退出0，分别包含普通测试，不重复相加。script此前与整仓并发时两个子进程导入超时；保留失败日志，未改变断言/超时，独立串行重跑335项通过。
- 最终镜像`sha256:66020f6044a121bd5994783de4aa6daafc9947649a1c73ebffb3aa8363cd9abe`构建成功；相同镜像下既有API两档2项、章节worker1项、原创开发1项容器回归均通过。本批没有新HTTP/UI，容器证据仅证明既有流程兼容。已安装SQL迁移未修改；代码、TypeScript、数据库与安全复审闭合。
- 最终日志SHA-256：`%TEMP%/camery-development-v06-check-final.log`=`83137fdeaa4d2f7cc7d011f6b89165cef4f90179e9699159260028e30c1b529a`；`camery-development-version-upgrade-pg-final.log`=`10d6dfdac02de69f9eed1a79dd8e0d44a680478ec6dca67722fd7c40392c9dda`；`camery-development-source-pg-final.log`=`3ebcc0562bef22219f11e4e2d0052b7221b42f9e57ee1288555b48ba18ea55af`；`camery-development-v06-server-pg.log`=`539bbd2f6dc8e009dbd7583bd406885c4457a1ca64f16d6e87a3f2faab856bd8`；原创开发容器=`e64715a2638a45ac8981b746c9a6f2437f87fb8ca4b052974d93b03798e878f4`。远端以最终提交实际Actions为准。
- 下一项继续持久普通ID→ULID映射与application intent、完整纯映射、独立最小采用LOGIN及认证preview/adopt/reject工作台。当前只提供类型/版本与来源事务基础，不宣称完整OD-7、T1.3或阶段1完成；真实文本质量及人工评分仍无配置。编辑器验收、法务签核、设计伙伴按用户要求后补，既有ComfyUI接线保持。

## revision 5.1 共享身份与写入并发基础证据（2026-11-17）

- `server/src/projects`是VCA-002/LIN-006及原创开发共用的普通tenant/project/principal绑定位置，script不另建普通项目映射。三张追加表使用作用域主键、反向唯一约束及tenant复合FK；项目绑定引用实际versioning二元项目，不创建空正式项目。受信安装者显式注册固定ULID，相同绑定重试幂等、重绑/别名冲突；user/agent_run/system同名key分别解析。只读resolver缺少绑定明确拒绝，不自动生成身份或初始化IR。
- 独立reader LOGIN仅三表SELECT，权限自检覆盖表/列、成员/PUBLIC、schema/owner、sequence、复制及转授权。真实PG验证8并发同语义注册、跨tenant同slug、新pool、实际version项目FK、SQL身份/范围约束、提交丢ACK恢复、实际backend终止的无部分绑定/销毁连接，以及10类ACL扩大负探针。新迁移SHA-256为`dc716b712599372df263abfd7a124a465287420332b2bac81ac0eb39dfef9b82`，`.gitattributes`明确新路径LF，旧已安装迁移不改。
- 宿主`resolveProjectAuthority`先校真实会话权限，再固定映射的user、普通scope和版本key；采用回调独立要求candidate:review，candidate:write不授予采用权。真实认证→独立reader→版本CAS组合验证编辑者提交、另一审核者采用、Agent同名不冒认、精确已采用ACK，以及重新authenticate后撤销审核权拒绝恢复；原记录/写版本不变。这不代表数据库可在同一次已认证请求中自动感知后续撤权。
- VersionStore可选严格双版本expectation在异步前捕获、project行锁内检查，过期失败不写表；精确同请求提交和真实已采用ACK先恢复记录，采用仍走原engine当前授权/范围/锁检查。来源guard仍同client且先来源锁、后版本行锁。拒绝CAS保持严格，未伪造缺原scope的拒绝回执。真实PG验证并发同writeVersion只有一个提交、实际行锁等待期间输入突变无效、提交丢ACK、新pool读取及source/backend/txid/锁序。
- 最终`pnpm check`退出0：2814=20工具+2794普通；588文件策略零违规、typed lint、13包类型检查（12缓存/1实际）及13包覆盖率全部实际执行，6方法golden/10 Agent基线匹配。versioning普通217项覆盖98.09/95.83/99.17/99.78%，server195项98.87/96.48/100/99.59%。串行实际PG versioning254项覆盖98.37/96.39/99.40/99.83%，server219项98.57/97.06/100/100%；PG包含普通测试，不重复累加。
- 保留失败→修正证据：CAS PG观察代理最初为普通对象，Drizzle未按Pool检出实际事务且commit小写未被观察；改为保留Pool原型的Proxy及规范commit后，原实际阻塞与丢ACK断言全过。身份终止测试最初误断言释放后监听器总数0；pg-pool恢复自己的idleListener，现跟踪并断言事务自有handler已移除，实际终止/销毁/回滚断言保持。该观察回调的事件参数类型随已安装pg声明修正，整仓最终通过。无生产门槛、超时或覆盖率阈值放宽。
- 最终镜像`sha256:ef62d7a7b77f61a19c0b59cea0c30183c01c5eeb0fd3a7ed68e67deb4382a989`构建成功；同镜像既有API两档2项、章节worker1项和原创开发1项容器回归通过。未启用新的HTTP/运行配置/注册命令，不以旧流程兼容证明完整共享采用服务。代码/TypeScript/数据库/安全复审闭合。
- 日志SHA-256：`%TEMP%/camery-shared-identity-check-final.log`=`a31f636b8c1cd6eaf3dc49652f7d4e60ed44bd649112044db035ce0cb48ffbcb`；`camery-shared-cas-version-pg-final.log`=`3693ed98990de9252b0aa00d400350c58946afa89064102223fc3e6b0b07dee0`；`camery-shared-identity-server-pg-final.log`=`7c5a48092e62fdb88baa8ac52dfa0b9ac45c68a526babe8614c2f488ab385790`；原创容器=`181709152bbd2e51b4123754de1b4a74cccba93eefa7a6ed402a1b293e9118aa`。远端以最终提交实际Actions为准。
- 下一项继续共享CandidateApplication与持久采用intent、来源局部身份及完整纯映射、采用LOGIN、认证preview/submit/adopt/reject和工作台。当前不是完整P-APP/G-PROJECT或OD-7交付；T1.3及阶段1仍未完成。真实文本模型质量待实际配置，编辑器/法务/设计伙伴按用户要求后补，既有ComfyUI连接不变。

## revision 5.2 完整映射、持久意图与事务回执证据（2026-11-17）

- 新增来源局部身份存储：同client重建已审核来源后，固定实际foundation owner的World/人物/关系，以及项目plan和全部旧分集槽位；身份独立提交、重试复用，不按姓名合并。已有可见残缺组、缺plan锚点、旧锚点零分集、单边/中间/当前owner尾部缺对均在allocator前拒绝；真实新owner与合法扩容保留。旧五表数据角色权限不扩展，实际LOGIN仍对新表42501。
- 纯映射器完整保留世界规则、人物欲望/阻力/弧光、关系、主线、问题、全部分集正文及原来源/审核者，计算预计写后依赖版本并列出全部已读对象base；同身份配音/role保留。完整重做按新owner建对象，仅分集重做引用真实原设定owner。100集207个操作可通过原引擎；缩集仅操作本桥接映射对象，人工Scene/Media不自动删除，引用和锁明确阻断。空draft不生成空ChangeSet。
- 共享projects追加candidate intent/prepare receipt/decision intent/decision receipt，固定来源manifest、对象身份、作者/目标/双版本基线及完整请求。相同业务命令竞争返回首份change/op IDs，异内容冲突。noop保存相对原基线的unchanged回执；新版本不会被旧noop回执冒称仍相同。每请求重新鉴权仍是受信应用责任，JSON与摘要不是批准。
- VersionStore原生连接执行formal→receipt→COMMIT；回执只能用同事务client。执行context绑定实际二元版本key、原CAS、实际requestSignature/changeId、捕获actor/scope/at/reason和项目行锁内replayed。回执器核对完整意图与实际决定事实，首次失败回执不能陪同同intent的新成功提交；冲突回滚正式写入。历史采用ACK仅保留同一实际AdoptionRecord，不伪造当前作者或时点。
- 真实PG组合共17项：合成协议候选与宿主审核夹具→实际局部身份→完整typed IR候选→采用/拒绝及原子回执；保留原审核者并与正式采用者分开。验证8并发producer、新pool、提交后回执失败全回滚、拒绝COMMIT丢ACK/重新鉴权撤权、来源变更拒绝采用但允许显式拒绝、实际后端终止重试、noop原基线、SQL绑定/record损坏、5类动作参数错绑、跨IRtenant同projectId、替换原CAS、first失败后同intent成功被回滚及新intent可明确批准。此层使用真实PG和会话/权限记录，模型输出与源审核仍是明确夹具，不代表真实推理、账单或真人评分。
- 复审关闭并保留证据：原evaluate预览会把replace.value.version及add+lock的locked字段写回原请求，两个实际失败测试后逐op复制隔离，完整重做submit→adopt恢复；坏映射不再补发身份；回执补齐实际执行信封与first失败保护。未知异常cause/code只读own data descriptor，getter/proxy trap不越过安全边界。首轮整仓服务端分支94.28%失败，补真实错误/完整性/跨phase分支后通过；未降低门槛、提高超时或删除断言。代码、TypeScript、数据库与安全最终复审均无未闭合P0–P2。
- 最终`pnpm check`退出0：2997=20工具+2977普通；603文件策略零违规、typed lint、13包类型（12缓存/1实际）及13包覆盖率全部实际执行，6方法golden/10 Agent基线匹配。script普通403项覆盖98.50/97.21/100/99.87%，versioning254项98.09/95.83/99.17/99.78%，server244项98.68/96.89/100/99.67%。
- 最终串行PG：versioning305项98.06/95.85/99.46/99.84%，script442项98.50/97.21/100/99.87%，server285项98.46/97.26/100/100%。各自包含普通测试，不与整仓重复相加。新SQL仅script0004与projects0002，SHA-256分别为`c9ee8b9bb940dd0164ca975f3a258ecd2b4b93fd38ed8eae41b261ba8cda1e83`、`9502bdb5935e26d0c99f44dde835dfac12bf127e7bb306dfc1a6950a9ca08be3`，Windows/Linux均LF；旧已安装SQL保持。
- 最终镜像`sha256:c3fdfdd564e091cb7fd6d8109f30a83decd200dd4b57227114e2d4dd5c4d969f`构建成功；同镜像既有API两档2项、章节worker1项和原创开发1项通过。这是既有流程兼容回归，本批没有新HTTP/UI或运行LOGIN启用，不能据此声称完整采用工作台已交付。
- 日志SHA-256：`%TEMP%/camery-adoption-complete-check-final.log`=`b9dcc97005d6f6e61ea8a838a9a7115a5332d996061548db347ac8ab7eb9acf3`；`camery-adoption-envelope-version-pg-final.log`=`280803444d7122c46c9566b3c11445643252bda3a57e8ca21ee183173ddac739`；`camery-adoption-identity-script-pg-final.log`=`9c31a5061080113c9e1da81cc12a38b2e0d1efb585ee4e6b151136888c0e3d8e`；`camery-adoption-envelope-server-pg-final.log`=`7fd9a9c9d8a92cc8431da3ec4e80b6490367b49e42ac2279157e19de10fede90`；原创开发容器=`597e4cf22225e227c4e441dad20493ad53b8430fb9f1fde3e8b5c5a81df4ce4e`。远端仍以最终提交实际Actions为准。
- 下一项是共享CandidateApplication宿主、独立最小采用LOGIN及认证preview/submit/adopt/reject API和工作台，继续复用本批意图与来源/版本权威。完整P-APP/G-PROJECT、OD-7/T1.3及阶段1未判完成；真实文本质量待实际配置。编辑器、法务、设计伙伴依用户安排后补，既有ComfyUI接线保持。

## revision 5.3 认证正式采用应用与工作台证据（2026-11-17）

- `ProjectApplication` 复用共享普通身份、来源局部身份、完整映射、原生版本服务及追加意图/回执。提供认证项目状态、有界候选目录、完整差异、纯预览、手工提交、开发准备、显式结构升级及明确采用/拒绝。写权限与审阅权限独立；每请求先鉴权，历史 ACK 也不绕过当前权限。候选和决定命令在异步等待前捕获；未知结果复用原意图、身份、双版本基线及决定时点。
- 新 reader/adopter 两个独立 LOGIN：reader 仅查询三张身份表；adopter 仅读来源、追加身份/意图/回执/版本历史，以及精确更新版本头和候选状态列。运行时只检查权限、不迁移或授予权限、不分配缺失项目、不创建模型会话。两个受保护 secret 文件及 `CAMERY_PROJECTS_ENABLED` 默认关闭配置见 `deploy/projects.md`；本批没有启用用户生产宿主。
- 开发审阅不等于正式采用。准备候选完整保留来源 manifest 与原审核者；采用仍在原生事务内执行来源锁、基版本、对象锁及回执。来源过期可查看或明确拒绝；原生未登记来源候选只读。旧 v0.5 项目必须先准备并采用独立升级候选。空草稿保存 unchanged 原基线回执，不伪造空 ChangeSet。
- 新目录仅投影元数据，每分支及合并最多 limit+1、每页最多50，稳定 ULID keyset；cursor 绑定普通/IR二元项目、用户与 run 过滤。开发视图同时列出项目唯一结构升级操作；全部候选入口显式点击才请求。跨租户同 ID 意图不会隐藏本项目原生候选。新增 projects0003 仅追加索引，旧迁移不改；SHA-256=`da7db310236e212f3465738317004d559c38dcb53a1c6827e901d0f90d7dc7be`。
- 工作台能力关闭时不发新增请求；开启后支持完整前后差异、准备/采用/拒绝分开决定、历史恢复、来源/锁/冲突解释及未知结果原请求重试。会话、项目或 run 切换中止旧请求并忽略迟到 ACK；403 保留内容、401 交会话处理。320px 无横向溢出，数量摘要只显示非零中文业务集合。
- 先红后绿关闭5项审查问题：手工来源校验不再依赖可能缺失的预览；采用后的差异基于实际 AdoptionRecord.from_revision，避免把另一候选的修改算入本候选；失败版本操作不再误报人类拒绝；预览与提交都在应用 DTO 拒绝超过500操作或512 KiB的请求；决定字段在身份查询等待前冻结。代码、TypeScript、安全及数据库最终静态复审均无未闭合P0–P2。
- 最终 `pnpm check` 退出0：3122=20工具+3102包测试；635源文件策略零违规，typed lint、13包类型与13包覆盖率通过，6方法golden/10 Agent基线匹配。server普通352项覆盖98.46/95.86/98.95/99.53%，web122项98.93/97.41/99.37/100%，IR395项98.19/97.01/98.38/99.76%。未调整覆盖率门槛、超时或旧断言来掩盖失败。
- 完整服务端 PostgreSQL 验收含普通共399项、48文件通过，覆盖98.32/96.59/99/99.78%。新增独立LOGIN实际认证HTTP→完整开发候选→采用/拒绝→原回执ACK、登出撤销与角色拒绝；真实53条目录分页、来源变更拒绝与回滚、跨租户同ID目录、18类额外ACL探针。首轮两处fixture失败已保留并修正：集合名改为真实character_relationships；撤销整表UPDATE会清掉原列权限，探针撤销后只恢复原两列，权限验证器未放宽。
- 浏览器实际执行原有16流程及新增8流程，核心准备/采用重复3轮，覆盖拒绝、prepare/adopt丢ACK同body/key恢复、来源过期、403/401及项目切换迟到响应。最终结果与截图/trace在 `artifacts/delivery/project-adoption-browser/`；agent-browser CLI 不可用，使用既有 Playwright/Chromium、未下载依赖。浏览器端口为明确typed内存夹具，SQL原子性由上述真实PG验证，均不构成真实文本推理、账单或真人质量评分。
- 全仓日志 `artifacts/delivery/project-adoption-check-final.log` SHA-256=`36c07473093e099822ee3f58a92ea34ac33b9a11853aff6a6c712032726eab60`；最终浏览器 `result.json`=`57497972cd086455e002b67719aaa3bca1ce4371bbada291ddf3b3f054515c1b`，`report.html`=`06ad899073fdc7a8aa4444a9db9d5f6a82dba5119b06aac3d37e9371250a9e59`。本地验收工件不入库，提交与远端结果以实际 Actions 为准。
- 实际镜像 `sha256:b0622bc9b05e7a4a79498f6f5e98545f32ddc3d9de73275725877a965c602da5` 构建成功；同镜像既有 API 两档2项、章节worker1项、原创开发API/worker1项串行通过。此项为既有镜像兼容回归，正式采用入口由专用LOGIN/真实PG HTTP及上述浏览器验收覆盖，未声称用户生产宿主已启用。构建日志SHA-256=`74abb4996fa74c5b9df5e4a38f2fc73b1d908ed5240b222438f520cbc0d56b96`；原创开发容器日志=`b5a9c37acf7b745529d1a27ff8c6992395c3bfe617952af948f28b06ad6552b4`。
- 当前交付了正式开发采用入口；其他共享工作台投影、补偿、媒体字节、旧原生候选显式来源登记及T1.9其余能力继续实施。完整P-APP/G-PROJECT、OD-7/T1.3和阶段1仍未判完成；真实文本质量等实际配置，编辑器、法务及设计伙伴依用户安排后补，既有ComfyUI接线保持。

## revision 5.4 正式快照、历史与浏览证据（2026-11-17）

- 共享应用补齐 `readSnapshot`、`readObjectHistory`、`readReadyAsset`，与原候选/决定接口使用同一普通/IR身份和每请求授权。新 `PostgresProjectReadStore` 直接读取原版本数据，头/快照/pending数量在单SQL同MVCC视图绑定，历史以单SQL有界LATERAL查询；项目状态也切到该读口，不再加载整个候选及历史集合。复用既有采用账号SELECT，无新表、迁移、运行依赖或权限扩张；读取不分配身份、写入、触发模型或任务。
- 正式快照最多200完整对象，按真实分集、场景、版本表现及集合选择，引用依赖明确标context。游标绑定普通/IR项目、真实用户、过滤和snapshotRevision，更新后明确SNAPSHOT_STALE；不拼新旧快照。每页983040字节按完整行缩页，单对象超限明确INPUT_LIMIT，不截断正文。原精确取用数值/有理数播放率保持；原无版本镜头沿革单独投影，不伪造对象身份。锁与实际引用版本、当前版本及stale原因可见，来源边不当generation_input。
- 对象历史每页最多50，保留真实父版本、采用changeId、snapshotRevision及删除墓碑；游标另绑定对象与集合。严格核对SQL列/record/value/父链，既存高版本导入根仍合法。内部快照捕获上限64MiB、数组65536，超限与损坏明确区分。公共快照和历史移除资产本地file.path；readyAsset先核授权和实际版本，当前始终明确未装配归档/媒体读取能力，ready元信息不能替代实际句柄。
- 正式内容面板由用户点击后懒加载，支持过滤、完整内容、关系/锁/沿革、固定快照翻页和历史。独立对象类型/标识入口可查询当前已删除对象，行按钮也可恢复历史；过期页清理后须明确刷新。关闭、身份/项目切换中止旧请求并忽略迟到结果；读取失败保留相应错误语义，401交会话处理。局部加载错误边界保留原工作区与会话，模块加载失败可以关闭，不自动刷新或把cached失败Promise包装成可恢复重试。
- 先红后绿关闭实际审查/浏览器问题：补场景location引用和原spots上下文；合法长锁定理由/字段及2001条谱系不被新DTO短限误拒；panel/take从真实Shot继承rendition、锁只随选中target，避免反拉入其他表现；历史检验实际parent_version而非数字相邻，拒绝两个断根；删除对象历史补真实可到达入口；懒加载失败局部隔离；行历史按钮显式传collection/id，避免strict表单被额外version误拒。代码、TypeScript、安全和数据库复核无未闭合P0–P2。
- `pnpm check`退出0：3209=20工具+3189包测试，652源文件策略零违规、typed lint与13包类型通过、13包覆盖率全部实际执行，6方法golden/10 Agent合成基线匹配。server普通426项覆盖98.33/95.69/99.42/99.70%，web133项98.28/95.31/98.87/99.63%，IR397项98.20/96.92/98.39/99.77%。未降低门槛、放大超时或删除旧断言。日志 `artifacts/delivery/project-read-check-first.log` SHA-256=`4aa5c4a3d309ca067f624051e7c3f14eba2ef751eb13447b7f6b80b8c92ef696`。
- 最终服务端PG含普通共477项、53文件通过，覆盖98.23/96.31/99.72/99.90%；与整仓不重复相加。新增真实版本头/pending、采用后实际对象历史、墓碑、新pool重读、跨IRtenant同ID、固定快照翻页/更新拒绝、专用LOGIN认证GET无写与手工独立采用后的旧游标拒绝。原角色42501/ACL探针与源锁/事务回执回归保持。日志 `artifacts/delivery/project-read-server-pg-final.log` SHA-256=`f3d570462b832ac86111022a814340bf70004cf45cdf069aab7291204f34593d`。
- 新9条真实Chromium流程、旧8采用及旧16开发回归均退出0。核心正式浏览重复3轮，包含50+9对象分页、实际行历史、场景/分集/表现选择、1/3到7/3取用与1001/1000播放率、旧world pin过期、资产409无假媒体、stale刷新、403/401、关闭/切项目迟到响应、独立墓碑查找及真实chunk abort局部关闭。root已查看桌面、320px和墓碑截图。夹具使用实际Nest/应用/版本引擎及明确内存端口，原生add/update/remove/adopt产生数据，不能替代真实PG、模型质量或人工验收。历史夹具/选择器/路由glob失败保留在historical-red，终止旧等待后重跑，没有把运行中句柄当成功。
- 浏览器 `artifacts/delivery/formal-project-browser/result.json` SHA-256=`edabad3db6b4265256499180b82778c244b4acdfac94fd1f32727f0c321c8fe2`，`report.html`=`03b6b4e1e9e909fd7553f3e243c81ca296f8c903fe70bcebc582d6500fc5bc78`，同目录保留截图/trace。CLI不可用，沿既有Playwright/Chromium，无下载或新增依赖。
- 镜像 `sha256:cf700a9a0ab3ed2866f729b923b99cb148b99f2c380bc99ceffe188d390d960d` 构建成功；同镜像既有API两档2项、章节worker1项和原创开发API/worker1项串行通过。这是镜像兼容回归，新读取由实际LOGIN/PG HTTP及浏览器组合验证，没有启用用户生产入口。构建日志SHA-256=`27fb9b203f5ec40f8534c53d6e54ba343bfe1d793561e5bd62a2101fa092ad08`，原创开发容器日志=`62f3a2b330fe81b0d8da9bf53f10b485e0e55d2073711f60fbc35ae5ed9b3eb5`。远端仍以最终提交对应实际CI为准。
- 本批交付共享读取端口及原创开发上下文的正式浏览消费；完整工作台/剧本各页、草稿与补偿、原生来源登记、真实媒体归档及T1.9其余能力仍继续。完整P-APP/G-PROJECT、OD-7/T1.3和阶段1未据此判完成；真实文本配置/质量后续补，编辑器验收、法务与设计伙伴按用户要求后补，既有ComfyUI接线不变。

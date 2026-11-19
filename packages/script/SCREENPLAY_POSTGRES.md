# 剧本定稿与四账交接（T1.6）

`@camery/script/screenplay` 提供纯稿件契约、可定位检查、配置语速估时、完整台词本及候选四账预览。`@camery/script/screenplay/node` 提供实际来源读取、不可变候选/人工审阅、原生正文与 text 锁、提交恢复和四账交接。此层为受信任 Node 宿主边界；按当前安排不增加认证 HTTP、登录页或浏览器权限绕过入口。

## 安装与输入

在已有原生版本历史、大纲/原文审阅与[四账安装](CONTINUITY_POSTGRES.md)上显式调用 `migrateScreenplay(pool)`。新表位于独立 `camery_screenplay` schema，原迁移及已有运行角色授权不变；新表不给 PUBLIC 权限。安装身份与实际运行身份由部署宿主管理，不把数据库凭据传给模型。迁移按 LF 字节保存并校验历史 checksum；仅新安装可创建此轮 schema，不能改已有迁移来覆盖记录。

`ScreenplayHost` 的实际人类身份、时间、应用 scope 及同步授权函数由宿主构造，每个动作必须返回字面量 `true`。JSON 中自报 human/adopted、摘要及可重新计算的 hash 均不能授予权限。应用 scope（原大纲 tenant/project key）与原生 target（ULID tenant/project）分别绑定。

宿主明确提供 `ScreenplayRules`：四类声音各自的最慢/最快字符语速，以及首集五模块的版本化项目定义。仓库计划未给出五项名称和语义，系统不虚构默认答案；首集缺配置保留 `FIRST_EPISODE_CONFIG` 错误并阻止人工定稿。测试中的“测试模块”只为协议回归，不能当作生产配置或真人评分。

稿件完整保留 scene→beat→line 顺序、独立局部 ID、实际角色/地点、正式 OutlineBeat 引用、原文目录及可核实引文。四类声音是当面说、内心独白、画外音、旁白；每条都有实际 speaker，画外音和旁白也列入本场参与角色。没有创建媒体、伪造旁白角色或把大纲 ID 当成剧本事件。

## 定稿步骤

1. `PostgresScreenplayStore.describeSource({scope,target,episodeId,rules},host)` 从实际 adopted native head 读取完整目标集大纲，并在同连接上核对已保存的大纲、原文审阅及当前性。非首集必须取得真实、唯一、完整且新鲜的原生前账证明链；不能由命令提供 previous。
2. `prepare({key,target,expectedSnapshotRevision,expectedPackageDigest,rules,draft},host)` 保存不可变原稿及实际来源。相同 key 的重试保持原作者/时间/正文；更换原稿或作者需新候选 key，不能覆盖旧候选。
3. 用 `createScreenplayCandidate(scope,context,editedDraft)` 检查完整人改稿，随后 `store.review(key,{candidateDigest,draft,waivers},host)`。结构、引用、配置和四账因果错误不能豁免；每条 warning 都须用准确 issueId 和具体人工理由处理。前三拍钩子、末拍卡点、五模块目的和四账声明完整性始终保留明确人审项，规则不冒称真人质量结论。
4. `screenplayNativeSlots(review.output.draft)` 给出完整身份槽；宿主一次分配并保存所有 scene/beat/line、操作、锁及 ChangeSet ID。用 `prepareScreenplayNativeMapping` 编译确定性请求，再通过现有 `PostgresVersionStore.submitWithReceipt` 和 `createScreenplayNativeSubmissionReceipt` 提交。候选提交只核对不可变审阅历史；正式采用前才重新判定当前来源。
5. 用 `createScreenplayNativeAdoptionHooks` 的 guard/receipt 调用既有 `adoptGuarded`，实际 native 用户授权与 episode scope 仍由宿主提供。正文与显式 text 锁在一次原生采用中提交；新台词首个正式 revision 即 version1/locked=true，没有可冒认的中间未锁版。已有本集场次会明确冲突；修改既有定稿须走既有原生编辑/解锁与复审，不能删旧正文绕过锁。
6. 首次提交 ACK 不明时，用 `readScreenplayNativeIntent(client,key,host)` 取回已提交的原 ChangeSet、对象、操作和锁 ID。`readScreenplayNativeAdoption` 验证历史采用；已采用 ACK 可在新连接恢复，并保留原 actor/time。缺原提交/采用证明不会后补成成功；不得以新 ID 或模型重发来推断旧任务失败。
7. 在宿主拥有的事务内调用 `readScreenplayHandoff(client,{scope,target,changeId},store,outlineStore,host)`。它核对正式快照、原生请求、对象版本、实际人工审计、完整正文/text 锁及当前写作依赖，重新把本稿四账声明映射到实际正式 beat/line 版本。`ledger_pending` 只代表剧本已锁、四账尚未采用；将返回的实际 `draft` 交给既有 `PostgresContinuityStore.prepare/confirm` 和原生采用流程。只有真实 typed ledger 证明与完整重算结果一致，才返回 `handoff_ready`，下一集随后消费这份完整账本。

定稿 API 支持人工创作及宿主已有的完整候选稿。模型生成使用下面的独立入口，不代替人工逐项审阅，也不自动修稿重试或签发质量结论。

## 编剧生成与原任务恢复

在已安装定稿内核后显式调用 `migrateScreenplayGeneration(pool)`，独立 generation migration ledger 不改已发布的定稿 SQL。`PostgresScreenplayGenerationStore(pool,outlineStore)` 保存不可变 run、原模型输出与派生候选、交付凭据，仍要求可信 `ScreenplayHost`。同一 run 固定作者、候选 ID、源版本、写作备注、Method PIN 和执行 profile；不同命令必须新建 run，不能覆盖原收据。

1. 用定稿 store 的 `describeSource` 取得实际 source CAS。生成 store 的 `start({key,candidateId,target,episodeId,expectedSnapshotRevision,expectedPackageDigest,rules,notes,execution},host)` 会重新读取真实采用源、完整前账及原文审阅，提前检查完整模型请求大小。`key` 为应用 tenant/project/runId；`execution` 使用既有单阶段预算契约，固定 balanced、实际连接/模式/模型身份、evidence、currency、reservation、limits 和必要的 pricing。首集没有真实五模块配置时生成明确失败。
2. 宿主先配置实际 `BudgetLedger` 项目预算，再向既有 Durable worker 注册 `createScreenplayWorkflow({store,ledger,hostFor,sessionFor})`。`hostFor(key)` 返回该作者的当前可信授权；`sessionFor(binding,task)` 惰性创建与 run profile 完全一致的 `ModelSession`，缓存恢复不需要凭据或会话。预算分配前核对 prepare 权限及原作者，等待 session/source 期间再次核对；read 权限不能触发付费调用。
3. 调用 `enqueueScreenplayTask(store,durable,key,host)`；固定 task/call 身份和 Method `screenplay.write@1.0.0` 绑定原 run，输入/最终输出仅包含小引用。Agent 没有写工具、没有批准/发布权，只执行一次 pinned method。原始 provider DTO 和 ModelReceipt 原样绑定，不能用归一后的领域稿重新标注 receipt 摘要。
4. workflow 先通过 `screenplay.persist-generated` 保存原输出和确定性派生候选，再通过 `screenplay.deliver-candidate` 将旧定稿 preparation 与 generation delivery 在同一 READ COMMITTED 事务提交。交付只得到 `awaiting_review`；人工 `review`、原生采用和 text 锁仍按上面步骤进行。来源变化时已完成输出继续留存，首次交付返回阻止状态，不生成替代稿。
5. 崩溃或保存/交付丢 ACK 沿同一个 task/journal 恢复；实际已提交候选/交付保留原作者、时间和 ID。原 task 为 waiting/reconciling 或 terminal 且交付未完时不会创建新任务。外部调用结果未知进入既有 Durable 人工对账，不能自动重发；对账恢复使用原 DTO 和收据。交付缓存与原 run、原生成结果及数据库内真实 preparation 凭据重新交叉校验，不能靠缓存自报成功。

模型输入完整保留目标集大纲/原文目录、人物、物理引用、分集 ID 及前账四列；仅排除无关 native 历史事件，完整上下文仍由摘要绑定并在实际数据库重放。模型请求包含指令、schema、messages 后总量≤2MiB，超限明确失败，不能裁账。原 DTO≤512KiB，保留在既有≤1MiB decision journal；7类四账声明按全局连续 order 严格转换，空值、引用或顺序矛盾不会被猜测修正。生成 run≤64MiB、生成结果≤16MiB，各自校验后 progress 聚合允许两者加小凭据；手工稿件1MiB及已发布定稿表上限保持不变。

`prepareScreenplayGeneration` / `generateScreenplay` / `createScreenplayGeneratedCandidate` 是宿主组合与纯协议入口，不能凭其 hash 自称源已采用、当前、预算已分配或人工已审。正式使用由上述 store/workflow 解析实际来源与预算。测试 provider 明确为合成协议，没有真实文本模型质量或真实账单验收结论。

## 一致性与失败

领域存储的 owned transaction 显式使用 `READ COMMITTED`，不能继承连接的可重复读旧快照。调用公开 `readScreenplayHandoff` 时，宿主同样须拥有 READ COMMITTED 事务；入口会核对隔离级别，不把等待源锁后仍停在旧快照的结果称作当前交接。历史 `readScreenplayNativeAdoption` 不声明 current，可在其它隔离级别读取原事实。

当前源的全局锁序为：无锁发现→实际 Outline brief/run 及上游源锁→native project 行锁→screenplay candidate advisory lock；生成交付在 project 与 candidate 之间先取得 generation advisory lock。拿到 project 锁后须重读并精确核对源，变化即拒绝；禁止持 project 锁再去申请新的 Outline 源锁。原生提交回调已持 project，因此只读不可变历史；采用 guard 在 native project 锁前完成当前源检查。当前源 helper 先 `SET LOCAL search_path = pg_catalog`，防止旧来源存储中的 advisory 函数被 public 同名精确重载遮蔽；事务结束恢复会话配置。所有同连接 helper 均不拥有 BEGIN/COMMIT/release；调用者负责事务。

候选四账的 disposable refs 明确为 `candidate_projection`，不具备采用权威。正式交接逐项匹配实际 post-lock 对象；前账版本变化使后续稿件/交接过期，而历史 ACK 仍保留原事实。未知数据库错误、原型 trap、连接异步断开都归一成安全领域错误，不把连接或密码交给调用者。

估时只计 Unicode 字母/数字码点，按显式语速与动作/停顿计划输出安全整数毫秒区间，并报告目标区间不符。它不等于 TTS 实测或真人表演时长。台词本完整保留原文、delivery、声音类型、实际 speaker、全局顺序；仅当面说标为“可见时可用于口型”，其余永不自动算口型。

## 验证与交付

定向回归包含：完整前账、伪造引文/角色/局部证据、四声音、五模块/前三拍/末拍、人审输入捕获、Unicode/估时溢出、8192 台词完整导出、SQL 列/记录绑定、历史快照与对象审计交叉核对、grant/原型 trap 和原 ID 恢复。

实际 PostgreSQL 隔离库已验证八并发定稿、写入 proof 后失败的全事务回滚、真实 COMMIT 后丢 ACK 的新 pool 恢复、提交 ACK 丢失后按候选键发现原 ID、上游 brief 更新使 current:false、真实 Outline/剧本双会话竞争，以及两集四账正式采用与下一集完整消费。普通覆盖率、整仓 `pnpm check`、完整 script PG 和精确提交的远端 CI 是交付 gate；进度与最终数值见[计划](../../docs/plan/screenplay-phase1.md)。

认证入口、编辑器验收、法务签核、设计伙伴与真实文本模型/真人作品评分按当前安排后补，不作为本轮协议测试已经完成的结论。

# 阶段 1 开发进展

依据：[实施计划 v2.1](implementation_plan_v2.md)。2026-11-16用户授权继续阶段1；阶段0的编辑器验收、法务签核和设计伙伴确认后补，未将其标记完成。阶段0代码提交 `f5aebef` 的[远端CI已全部通过](https://github.com/songuu/camery/actions/runs/43801570843)。

## 任务顺序与状态

| 任务 | 状态 / 前置 |
|---|---|
| T1.1 小说/剧本导入 | 小说、Fountain/CSV/TSV/DOCX的核心、认证HTTP及来源工作台已实测；批次幂等、独立游标、低权限运行及重启恢复通过；旧DOC/XLSX待后续范围确认 |
| T1.2 StoryBible | [领域、PG恢复、认证API/审阅页及配置型常驻宿主](storybible-phase1.md)已落地；真实文本模型质量与人工评分待实际配置，不据合成协议判完整验收 |
| T1.3 创意开发 | [固定原创方法、候选/人工审阅、预算恢复、逐阶段重做、认证界面、正式IR采用及读取](original-development-phase1.md)已落地；完整共享工作台、补偿/其余采用能力及真实文本质量仍继续，未判完整T1.3 |
| T1.4 五件套/题材配方 | [专项目标、单一验收契约与证据](dramaturgy-phase1.md)：五件套/引用、首批3类与规则、真实已审阅来源读取、固定方法/收据绑定及人审领域已验证；大纲持久化/预算、API/页面及显式IR升级继续，未判完整T1.4 |
| T1.5 圣经四本账/快照 | 待T1.2/T1.4及版本域接入 |
| T1.6 节拍流剧本 | 待T1.4/T1.5；台词与定稿锁 |
| T1.7 合规预审 | 可做可配置框架；真实适用规则待人工签核，不自动激活 |
| T1.8 结构闸门/三轮审查 | 待T1.4/T1.6候选；延用Issue/Question与人工门禁 |
| T1.9 局部采用 | 原创开发完整候选已接正式版本域、原子来源/版本检查、持久意图及历史读取；其他来源、草稿补偿与真实媒体归档继续，未判全部完成 |
| T1.10 界面 | 来源导入/续读、StoryBible审阅、原创开发/重做/正式采用及正式快照历史页已接真实API；全局项目导航、五件套及剧本编辑等继续 |
| T1.11 用户/角色/评论 | 认证骨架已有；用户管理及台词评论待实现 |
| T1.12 可拍性画像 | 待立项候选；只做审查，不提前实现精确成本引擎 |
| T1.13 intake | 待统一采集契约及独立采集器身份应用边界 |
| T1.14 trends | 待T1.13不可变观测与归并 |
| T1.15 接入包 | 待T1.13/T1.14真实接口；Muse先文件导入 |

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与用户价值：长篇可分批追加并从上次读到的位置继续；已存在的剧本可结构化进入后续流程，来源定位可核对。
- 范围：T1.1覆盖`@camery/ingest`的小说、Fountain、CSV/TSV、Word DOCX解析、PostgreSQL批次/读取游标及认证来源工作台。旧二进制DOC、XLSX未支持，不能据此宣称全部阶段1完成。
- 选择：复用既有章节识别规则；格式适配器产出统一候选，原始文字与UTF-16位置不变。DOCX位置指提取后的段落文本，另保留原始ZIP摘要。来源一律是数据，不触发模型/工具，也不直接采用IR。
- 状态与错误：文档按tenant/project/document隔离；批次ID与文本摘要绑定，乐观revision拒绝并发覆盖；事务同时保存正文和批次记录。读取游标按reader隔离、单调前进，绑定文档摘要和已读前缀，重启重新读取数据库。错误使用固定业务code和操作上下文，不回显正文/凭据。
- 恢复：迁移由受信安装者显式执行并校验checksum，运行时不自动迁移。卸载代码不删除来源数据，回滚失败事务，不改写既有迁移历史。版本2增加剧本表；降级到仅识别版本1的旧安装器不能重跑迁移。包内tenant/project参数由认证应用层提供，公共HTTP/UI经现有会话与项目权限边界验收。
- revision 2（2026-11-16）：继续T1.1应用闭环，新增认证HTTP、共享分页DTO、React/Vite来源工作台及独立运行权限验证。保留原小说快照格式，允许可选的不可变显示标题；新增版本2迁移保存剧本原始字节及结构化候选，不改写版本1。来源服务以部署配置显式开启，保留阶段0只读认证运行方式。
- Acceptance Criteria：
  - AC-1: WHEN 同一原文按任意合法批次追加 THE SYSTEM SHALL 保留精确原文和完整无重叠的章节范围，重试不重复追加，同批次不同内容及过期revision明确冲突。
  - AC-2: WHEN 进程重启或另一个读取者继续阅读 THE SYSTEM SHALL 从持久化游标恢复，隔离租户/项目/文档/读取者，并拒绝越界、倒退或拆开代理对的游标。
  - AC-3: WHEN 导入Fountain、CSV/TSV或DOCX THE SYSTEM SHALL 返回带确定来源定位的结构化候选，保留未识别内容并说明限制，拒绝损坏、恶意或超限输入而不执行内容或访问外部资源。
  - AC-4: WHEN 经HTTP读写来源 THE SYSTEM SHALL 从已认证会话确定tenant与reader，以项目权限授权，拒绝冒认、跨项目、撤销会话及只读者导入；返回有界预览而不回传完整快照或原始二进制。
  - AC-5: WHEN 浏览器连接、上传、切换项目或断开 THE SYSTEM SHALL 只用同源接口、仅在内存持有凭证与来源，不显示旧身份或旧项目的迟到结果，并允许用同一文件恢复已完成批次。
  - AC-6: WHEN 显式开启来源服务 THE SYSTEM SHALL 核对最小权限数据库身份、原迁移checksum与版本2新增表，使用构建后的同一应用镜像提供工作台及API。
<!-- design-authority:end -->

## 本次实施与验证

| 工作 | 所有文件 / 风险 / 证据 |
|---|---|
| [P] 小说解析 | `packages/ingest/src/novel.ts`及测试，复用`packages/methods/src/chapter.ts`标题helper；L2；AC-1定向回归及旧黄金集保持一致 |
| [P] 剧本适配器 | `packages/ingest/src/screenplay.ts`、`src/node/docx.ts`及测试；L2；AC-3正常与恶意输入回归 |
| 批次与游标 | `packages/ingest/src/session.ts`、`src/node/store.ts`/迁移及测试；依赖小说解析；L3；AC-1/2事务、并发、隔离、真实子进程恢复 |
| 工作区接线 | 新包manifest/config/exports、锁文件、现有PG脚本/CI；L2；定向覆盖率、类型、lint、旧章节黄金集及整仓检查 |

验收证据在命令实际完成后追加，未执行的项目不预填通过。阶段1整体验收仍包括≥10章黄金小说到10集剧本、人工评分、合规召回、热点入口一致性等原计划条件，当前尚未完成。

### T1.1 首批核心证据（2026-11-16）

- [导入核心、格式与安全边界](../../packages/ingest/README.md)已落地，`@camery/ingest`纳入工作区类型检查、覆盖率及远端PG专项；没有把来源文本发送给模型或当作工具指令。
- 最终 `pnpm check` 退出0：1686项（原根检查1529 + methods新增24 + ingest普通133），source-policy337文件零问题、代码lint通过；10包类型检查成功（6缓存、4实际执行），10个覆盖率任务全部实际执行、0缓存；6个章节黄金案例与10个Agent行为基线均匹配。
- 最终 `pnpm test:ingest:local --coverage` 退出0：141项 = 上述ingest普通133 + 真实PG专项8，不重复相加；覆盖语句99.31% / 分支98.31% / 函数98.83% / 行100%。普通ingest覆盖为99.31 / 98.10 / 98.83 / 100；methods为97.15 / 95.79 / 98.88 / 99.65，其余包仍满足95%门槛。
- 实际PG覆盖首次并发幂等、过期revision冲突、完整作用域隔离、游标前缀与版本、不可信参数在等待前捕获、回滚及新连接读取。子进程提交读取游标后实际SIGKILL，新连接恢复原位置；原创十章文本按7个Unicode字符分批，标题/CRLF被拆开且每批重试，最终原文、章节范围及尾游标一致。该十章用例只是导入验收，不是阶段1的十集生成验收。
- 复审发现并关闭：普通测试误加载PG专项；章节标题/Fountain尾部正则回溯；DOCX后置段落限制、按行重复处理长段落；长style/标题/角色/列名重复引用造成的JSON投影放大。先有界红测再修复；章节解析3024组旧语法对照、百万空白回归保留既有方法结果。长输入子进程只强杀测试自身，不中断用户进程。
- 本批仅新增导入schema，由测试显式安装并清理自身随机租户记录，未迁移正式服务或更改现有认证角色权限。公开HTTP、最小权限运行身份、上传与导入界面、XLSX及后续StoryBible仍待实施；未提前判定全部T1.1或阶段1完成。
- 最终本机日志：`%TEMP%/camery-phase1-ingest-check-final-20261116.log`，SHA-256 `302d679b5241acd725f627d0c9dd3de40a2ddb25ebb4acce1a2171219a829f1e`；`%TEMP%/camery-phase1-ingest-pg-final-20261116.log`，SHA-256 `7125cbbf8572c6a2b8c2ac66a4a59e32eb80046fe625912394066ed3ec2ddbfb`。

### T1.1 认证来源工作台（2026-11-16）

- 来源列表、不可变剧本原始字节、小说追加、分页原文及当前用户游标已接入同源认证API。服务端绑定会话tenant/reader，按项目授权；默认关闭来源服务，显式开启时验证独立数据库LOGIN的逐项最小权限。
- React/Vite工作台支持五种来源格式、同文件恢复批次、紧邻前文/后文、保存续读及断开。凭证与来源仅存内存；401/403、项目切换和迟到结果有独立回归。
- 最终`pnpm check`退出0：1893项（20工具测试 + 11包普通1873），371文件策略零问题、lint和11包类型检查通过、11包覆盖率全部实际执行；6章节黄金案例与10 Agent行为基线通过。真实PG导入259项、服务端85项均通过，包含普通测试，不能重复相加；最终镜像Compose来源关闭/开启2项和worker1项通过。
- 真实Chromium完成原创十章、两批上传、同文件幂等、四种剧本格式、跨项目隔离、只读权限及撤销会话；最终镜像再经1440/768/320三个独立上下文复验。临时容器正常退出0，自身角色、租户及凭据已清理；未变更ComfyUI服务。
- [详细证据与限制](../validation/source-workbench-live-2026-11-16.md)。下一项按T1.2推进StoryBible：建立可核对来源的分块候选、跨块归并和人工确认；来源导入验收不替代十集剧本生成、人工评分及其他阶段1总验收。

### T1.2 候选领域与单块模型适配（2026-11-16）

- [完整任务与验收契约](storybible-phase1.md)保持分块抽取→跨块合并→原文定位→用户确认的最终范围；当前新增[`@camery/bible`](../../packages/bible/README.md)，不将库级确认函数当成真实用户已完成审阅或完整T1.2应用。
- 完整ingest快照绑定tenant/project/document/kind/revision、文字与文件摘要；默认12000 UTF-16/48000字节分块，优先结构边界，不拆emoji或CRLF。每条模型引文必须逐字回切，同一块内身份引用完整。
- 原创版本化方法复用MethodRegistry/MethodRunner/ModelSession，无新直连、凭据或自动重试。保留块回执及外部unknown/completed状态。跨块同名/别名仅产生可拆分合并建议；人工宿主必须完整决定所有实体并接受同步授权检查，矛盾描述保留，关系/事实显式重映射，正式IR不变。
- 最终`pnpm check`退出0：2087项 = 20工具 + 原1873普通 + Bible194；392文件策略零问题、lint及12包类型检查通过（11缓存、1实际），12包覆盖率全部实际执行、0缓存；6章节黄金案例与10 Agent基线通过。Bible覆盖语句99.58% / 分支98.93% / 函数98.63% / 行100%。
- 十章原创文本经真实OpenAI协议适配器的进程内夹具记录10次调用，再离线精确回放，无网络fallback；结果20个实体提及、2个合并建议、10条关系，模拟宿主显式分组后得到2个人物和保留的全块描述。它证明协议与领域组合，不证明真实模型推理、真人确认、计费或数据库恢复。
- 复审关闭并保留实际红→绿：大逻辑JSON在预算前展开、计划getter执行/异常外泄、数组Proxy改变length放大稀疏结果、畸形模型返回丢失outcome、累计块记录/投影预算晚检查。数据先有界快照再序列化；只使用捕获一次的数组长度，原始与投影预算各自检查。核心/TypeScript/安全复审已分别覆盖相关范围。
- 本轮没有数据库迁移或运行配置变更，也未触碰现有ComfyUI、来源数据或用户其他方案文档。下一增量接现有预算/durable与来源存储，完成逐块持久化/恢复及认证审阅应用，再做真实文本模型和人审验收。编辑器、法务和设计伙伴确认仍后补；阶段1整体未完成。
- 本机最终日志`%TEMP%/camery-phase1-bible-check-final2-20261116.log`，SHA-256 `e1553e762406f4cf892b53219ad5cae3bd0f70d240aac9242d2d2baf6bf86322`。远端CI以该轮最终提交的实际Actions结果为准。

### T1.2 持久化与预算任务恢复（2026-11-16）

- [`@camery/bible/node`](../../packages/bible/POSTGRES.md)新增显式checksum迁移及runs/chunks/candidates/reviews四类追加记录。同一连接先取来源锁再取run锁；来源helper只SELECT并复用既有codec，当前来源改变不能被首次确认，既有同身份/语义重试重授权后只返回原审计。运行账号与installer、auth/source写账号分离。
- 每块一个实际durable task，任务仅有run/chunk/digest引用。固定方法请求编译器供实际调用与journal摘要共用；新可信driver显式校raw finish-output回执，旧缺省action封套不变。AgentRuntime单次计量、每块一份预算，BigInt核整次份额上限；阻塞/未知没有record就不会自动排下一块。
- 真实PG：在模型decision实际提交后强杀自身子进程，以新pool/worker恢复并断言provider调用0；record提交后丢确认幂等恢复、预算不重复预留；unknown保持reconciling，只有显式operator完整回执对账后继续，仍不重发。unknown期间追加来源，恢复仍保留旧快照已付结果，后续pump停止stale。
- 最终`pnpm check`退出0：2229项 = 20工具 + 12包普通2209；414文件策略零问题，lint、12包类型检查通过（11缓存、1实际），12包覆盖率全部实际执行且0缓存；6章节黄金案例与10 Agent基线不变。Bible普通255项、四项覆盖98.81/97.54/99.21/100%。工具链类型可见性变化暴露已有Node测试Promise，5份测试文件20个顶层调用显式await，所有断言/超时/负例保持原样。
- 独立真实PG总数：Bible262 = 普通255 + 专项7；ingest283 = 普通268 + 专项15；agents475 = 普通381 + 专项94。各自包含普通用例，不和整仓重复累加。对应四项覆盖：ingest99.50/98.79/99.15/100%，agents97.68/95.53/99.73/99.81%。
- 核心、TS、DB和安全复审通过；补齐实际红→绿：saveChunk空输入边界；额外表/列/序列/schema CREATE共11类权限canary（只操作随机自有对象）；ACL函数CASE类型守卫，避免WHERE重排把表交给序列函数。所有测试随机租户/角色与canary已由自身cleanup清理，不更改用户对象或全局PUBLIC权限。
- 本轮尚未启用新的常驻服务/API或配置真实文本模型。下一步实现run列表/宿主pump、认证来源到Bible的审阅应用与实际用户流程；真实模型质量、人审和阶段1整体条件仍未完成。ComfyUI图像能力不是文本抽取验收；编辑器、法务和设计伙伴确认继续后补。

| 本机日志（`%TEMP%`） | SHA-256 |
|---|---|
| `camery-phase1-bible-persistence-check-final-20261116.log` | `a6655e98b51b6452845e74ac4f8be1bf59d90cc91fe9e113140fa9683b563bc6` |
| `camery-phase1-bible-source-pg-20261116.log` | `acd76ae937e14bca6942cead952c84425f0df95cbcef58ed0ad48da5a56eb7f3` |
| `camery-phase1-bible-role-green2-20261116.log` | `906a99c1706543b1abdebb2001d54763138bbc71132dfdb7834114392703fc67` |
| `camery-phase1-bible-agents-pg-20261116.log` | `a03e390ab108dea07d0ed3a9d4fdb38ce08d92661705f69a5cd89076a24303d1` |

远端新增Bible PG步骤，实际结果以最终提交的Actions为准，不用本机日志提前代替远端成功。

### T1.2 认证审阅工作台与独立文本宿主（2026-11-16）

- 新增浏览器安全HTTP契约、认证API与提取/审阅页面。目录和状态仅查询元信息，微秒游标与C排序索引一致；完整候选从可信store重建后白名单投影，引文只读run冻结原文。服务器提供真实认证审核者和时间，首次确认继续执行事务来源新鲜度检查。
- UI默认每个实体独立，合并/拆分/拒绝均显式；拒绝实体不静默丢弃关联。同候选轮询不丢草稿，换run/项目/会话隔离；过期禁确认、允许拒绝，401清连接、403返回来源显示错误。真实Chromium完整流程重复3次，另4个竞态/只读/过期场景通过，320px无横溢。
- 独立文本宿主复用真实OpenAI adapter、固定live/economy模式、最小Bible/task角色和公平有界pump。没有文本配置时API保留已有结果审阅，禁止新提取；worker拒绝启动。配置与密钥来自有界普通文件，不从请求收取URL/模型/授权；三个连接池分离，未知结果不自动重发。
- 最终`pnpm check`退出0：2299=20工具+2279普通；442文件策略零问题、lint及12包类型检查通过、12包覆盖率均实际执行。Bible真实PG275（普通265+专项10），server真实PG131（普通116+专项15）；均包含普通测试，不与整仓重复相加。镜像构建、Compose原API2项/原worker1项及新worker无配置安全退出已验证。
- 代码/TS/安全/数据库审查闭合；修复历史分组ID碰撞、重复新提取ID、403空白和首次状态丢草稿。授权网络下依赖审计退出0。详细命令、哈希、浏览器产物和限制见[应用验收证据](../validation/bible-workbench-2026-11-16.md)。
- 真实文本模型十章质量和真人评分尚无配置与证据；阶段1其他模块继续按v2.1推进。编辑器、法务、设计伙伴确认按用户指示后补。新常驻服务不自动启用，ComfyUI服务未变更；整阶段1未判完成。远端CI以最终提交的实际Actions为准。

### T1.3 原创开发契约与两阶段执行核心（2026-11-16）

- 按[完整实施与AC](original-development-phase1.md)新增`@camery/script`：创意brief→世界观/人物/主线→显式人工编辑审阅→分集候选。局部身份/引用、精确集数/顺序、主角与主线绑定均有界验证；原始模型候选与编辑审计分开，新的brief/设定不能静默套用旧分集。当前是领域/方法交付，不是完整应用或正式IR采用。
- 固定原创`original.develop.foundation/episodes@1.0.0`，balanced/development，复用MethodRunner/ModelSession；精确请求/输出/方法/租户/上下文绑定并保留原回执，无隐藏重试。真实协议适配器夹具录制两次，再精确回放同一人工编辑上游；合成协议与live标记测试均不代表真实推理或账单。
- 真实AgentRuntime/预算workflow/公开DurableWorker组合使用独立阶段task，32704字节设定在默认session限额内通过；进程内journal重放模型/预算分配增量0。128KiB完整decision与1MiB worker输入/输出边界实际测量，超1字节拒绝。typed内存store不证明真实PG/强杀/unknown对账，OD-5仍待实际存储增量。
- 公共有界JSON primitive移至浏览器安全`@camery/methods/json`供Bible和script共用，保持Bible错误映射及旧canonical/方法摘要语义。真实Bible PG275项回归与现有web/server构建通过。审查关闭并保留红绿：异步授权未观察拒绝、brief追加摘要后超8KiB导致不可恢复、拒绝候选提前读getter、请求前取消缺失not_sent分类。
- 最终`pnpm check`退出0：2458=20工具+2438普通；478文件策略零问题、lint、13包类型检查（6缓存/7实际）及13包覆盖率全部实际执行；6方法黄金案例与10 Agent基线通过。script126项，覆盖100/98.52/100/100%。核心/TS/安全与组合增量复审通过。
- 本机日志`%TEMP%/camery-original-core-check-final.log` SHA-256 `97e2fa9ce03c6d80e810d5ff22ef94f67f9d4204e30dad514fb8912a5ae84e53`；共享边界PG日志`%TEMP%/camery-original-shared-bible-pg.log` SHA-256 `1f811b2e74c58a88a0d5acf90de7b761a3c6aa91780aeafc9948819e7105c5d0`。远端结果以本次最终提交的实际Actions为准。
- 接下来继续逐阶段PG持久化/预算恢复、认证API、可编辑工作台及正式开发对象的ChangeSet接线。真实文本模型质量和人工评分仍需实际配置；编辑器、法务、设计伙伴后补。阶段1与完整T1.3均未判完成，目标范围保持不变。

### T1.3 逐阶段持久化与预算恢复（2026-11-16）

- `@camery/script/node`实现追加brief修订、固定run、原始阶段候选与独立人工审阅；固定brief→run锁序，同身份同语义重试重新授权后返回原审计。目录保留PG微秒游标，运行角色仅四表SELECT/INSERT，安装迁移与运行权限分离。
- 每阶段独立durable task，复用现有Agent和预算账本。dispatcher先排空原任务物理尾部，再判断业务终态/过期；unknown需显式对账，不换任务ID自动重发。已付旧版本候选保存但不能静默用于新下游；常驻宿主/API/UI仍待接入。
- 最终`pnpm check`退出0：2569=20工具+2549普通，524文件策略零问题、lint、13包类型检查（12缓存/1实际）、13包覆盖率全部实际执行；6方法golden/10 Agent基线匹配。script237项，覆盖99.49/98.58/100/100%。
- 最终`pnpm test:script:local -- --coverage`退出0：16文件252项（含普通237，不重复相加），覆盖99.62/98.78/100/100%。真实PG包含并发、范围FK、篡改、审阅新鲜度与重试授权、24项最小角色探针；两阶段确认丢失、新pool恢复、测试自身子进程SIGKILL、unknown不重发及对账后旧brief结果保存。恢复均由正常dispatcher返回原任务，新增模型调用为0。
- 复审关闭getter读取边界、schema USAGE转授权、FK引用侧索引及REPLICATION身份；最后一项真实PG先红复现再修绿。代码/TypeScript/安全复审通过。此前服务端构建子进程有一次超时，最终整仓同一用例通过，未放宽断言或超时。
- 日志`%TEMP%/camery-development-persistence-check-final.log` SHA-256 `b13301719a44b9b513cb10831c78568c1e4cf9222e4f6385eac0d181295613d9`；`%TEMP%/camery-development-persistence-pg-coverage-final.log` SHA-256 `412e7b5af3c7db18d2a526fccfa014366d601a3829ef63ce8cc1a6ca4bde0dc9`。远端CI结果以最终提交的Actions为准。
- 下一项是认证应用、工作台与常驻宿主，再继续正式开发IR/ChangeSet和真实文本模型质量。现有ComfyUI图像连接保持；未配置的真实文本供应方不能以协议夹具替代。完整T1.3与阶段1未完成；编辑器验收、法务签核、设计伙伴确认依用户安排后补。
- 远端`e5ba0cd`在新增script PG步骤发现测试初始化顺序依赖：权限探针引用的认证表尚未安装，实际42P01而非预期42501。测试改为显式安装durable/预算/access/development迁移，保持42501断言；access仅测试依赖。随后新建独立随机空库完整252项及覆盖99.62/98.78/100/100%通过，结束清理该自有空库。日志`%TEMP%/camery-development-fresh-db-final.log` SHA-256 `88baacd7c72362a4cd46fb8edb128cf49cd74f639c29c1f1b3e863898121ca43`；最终远端CI以修复提交实际Actions为准。

### T1.3 认证原创工作台与常驻宿主（2026-11-17）

- 创意保存/恢复/修订、两阶段开始/读取/编辑确认/拒绝及整体新run重做，经同源认证API与可编辑工作台接入；固定两阶段模型/预算，仅受信宿主读取文件密钥。无文本配置时仍可保存/恢复，模型调用不由GET/刷新触发。独立数据/任务连接池、默认关闭开关、同镜像worker和两层Compose已交付，详见[实施与完整证据](original-development-phase1.md)和[部署说明](../../deploy/development.md)。
- 最终`pnpm check`退出0：2632=20工具+2612普通，558文件策略零问题、lint、13包类型（11缓存/2实际）、13包覆盖率全部实际执行，6方法golden/10 Agent基线匹配。script247项覆盖99.23/98.10/100/100%，server156项98.96/95.84/100/100%，web103项99.72/100/100/100%。
- script真实PG263项、server真实PG171项及覆盖门槛通过（分别包含普通247/156，不重复累加）。最终镜像下原创开发容器1项通过：独立三类角色、实际HTTP合成夹具两调用、人工上游传递、待审阅SIGKILL/重启、预算200tokens、无关任务/日志脱敏。原API两档2项和章节worker1项兼容通过。容器强杀窗口与核心PG的decision提交后窗口分别记录，不扩大证明范围。
- 真实Chromium12项（3轮完整+9边界）通过，桌面/320px截图与4 traces已检查；网络丢ack沿用原ID、草稿跨tab保留、会话/项目迟到隔离、未访问页零后台请求、过期/unknown、字段/引用/字节闸门均有实际交互。所有context零JS pageerror；核心旅程零非注入console error。浏览器采用现有Playwright回退（agent-browser CLI缺失），无新下载；内存协议层与PG/镜像各自独立作证。
- 整仓日志SHA-256 `9a44c5d4c867b3aea2386ded7037bcf48b4da17f2d51878f3e5856f5926db9e1`；最终容器日志 `8efe44c9497ae8860eee6f184af1c8665a3087d8b23fb07320e2c404f321025c`；浏览器result.json `f3ca8ab8e34517aac7a36e73df6f8066529c0998e8491c965a896646ca83853c`。远端CI以最终提交实际Actions为准。
- 阶段1继续：当前重做为整体新run，逐阶段单独重做/下游影响、完整开发IR与ChangeSet正式采用仍未完成；真实文本模型质量及人工评分待实际配置。Resolve验收、法务签核、设计伙伴确认依用户安排后补。本批未改ComfyUI图像接线，未宣称完整T1.3或阶段1完成。

### T1.3 逐阶段重做与来源谱系（2026-11-17）

- 已支持完整重做设定，以及保留真实已审阅设定、只生成新分集。追加origin固定直接来源与真实生成owner；原候选/模型回执/审核作者和时点保持，继承内容只读。v2分集只新增一份预算及一个Task；原v1日志和预算保留。trusted Task/steps拒绝active、unknown与cancelled-unknown，已有分支丢ack同语义重试恢复原任务。
- 最终整仓`pnpm check`2686项（20工具+2666普通）、13包类型/覆盖率、lint与方法/Agent基线全通过；script290项分支97.80%，web108项交互及client/state测试通过。真实PG script309/server178项均通过，包含并发/事务、实际LOGIN与unknown journal门禁。v2分集decision SQL提交后实际SIGKILL，新pool恢复零新增调用、原审计和3份allocation/300tokens保持；不扩大为未知在途重发证明。
- 最终镜像原创开发容器1项、既有API2项/章节worker1项均通过。真实Chromium16项含3轮重做，桌面/320px截图已检查；内存浏览器预算、PG账本和容器HTTP分别作证，均不冒称真实文本质量。完整命令、SHA-256与迁移边界见[实施证据](original-development-phase1.md)。远端以最终提交实际CI为准。
- 下一项继续完整开发IR/ChangeSet、正式采用及其跨对象版本影响，再推进阶段1其余剧本任务；真实文本供应方/质量和人工评分待配置。编辑器、法务和设计伙伴后补，现有ComfyUI图像连接未改。完整T1.3与阶段1保持未完成。

### T1.3 正式开发类型与来源采用事务基础（2026-11-17）

- 新增IR v0.6完整设定/人物开发/关系/开发主线/分集计划及原始审核来源，严格兼容v0.5读取和旧迁移输出；旧项目通过独占、project范围、精确base的升级ChangeOp显式升版。依赖历史pin不自动改写，未来/缺失引用拒绝，过期依赖显式报告。
- 来源新鲜度与正式采用现在可在同一PG连接/事务串行检查，固定brief→真实owner run→version project锁序；真实PG验证断连全回滚、提交丢ACK和重新授权。script guard重建实际原始候选/回执/审阅，阻止过期、未审核、篡改或跨scope来源；仅分集重做保留真实foundation owner，不伪造来源行。
- 最终整仓2750项（20工具+2730普通）、13包类型/覆盖率及golden/Agent基线通过；串行PG versioning216/script335/server178项通过，各自包含普通测试。最终镜像既有API2项、章节worker1项、原创开发1项回归通过；详细命令、覆盖率、SHA-256及失败后串行复验见[实施证据](original-development-phase1.md)。代码/TS/数据库/安全复审闭合，既有SQL迁移未修改。远端以最终提交实际CI为准。
- 下一项是持久身份与application intent、完整纯映射、独立最小采用LOGIN、认证preview/adopt/reject及工作台；当前组件测试不代表整条正式采用流程完成。完整T1.3/阶段1和真实文本质量仍未完成，编辑器、法务、设计伙伴依用户安排后补，ComfyUI图像接线保持。

### T1.3 / VCA-002 / LIN-006 共享身份与并发基础（2026-11-17）

- `server/src/projects`统一持久绑定普通tenant/project/principal到版本域ULID，项目FK指向实际二元version项目；不在读取时创建空项目或临时ID。显式注册相同语义幂等，重绑/别名拒绝，Agent与人类同名身份分开。独立reader LOGIN仅三张表SELECT，实际权限闭包及负探针通过。
- 宿主真实会话先鉴权再解析绑定，采用回调独立检查candidate:review；真实认证/reader/版本CAS组合验证编辑者提候选、另一审核者采用、撤权后新请求拒绝ACK恢复。VersionStore支持可选双版本期望，在实际行锁内核对；精确同提交/已采用重试可恢复，采用重试仍重新授权，来源锁序与原子事务保持。
- 最终整仓2814项（20工具+2794普通）、13包类型/覆盖率和方法/Agent基线通过；实际PG versioning254/server219项及门槛通过，分别包含普通测试。最终镜像既有API2项、章节worker1项、原创开发1项回归通过；失败观察代理/监听器断言的依据、SHA-256及完整证据见[实施记录](original-development-phase1.md)。新SQL采用显式checksum迁移与LF规则，旧迁移未改；代码/TS/DB/安全复审通过，远端以最终提交实际Actions为准。
- 继续共享CandidateApplication、采用intent、来源局部身份/完整映射、独立采用LOGIN与认证API/UI，未启用新的采用入口，完整P-APP/G-PROJECT、T1.3及阶段1不提前判完成。真实文本质量仍待配置；编辑器、法务、设计伙伴后补，ComfyUI接线保持。

### T1.3 / VCA-002 / LIN-006 完整映射与采用回执（2026-11-17）

- 完整开发对象现在可经持久局部身份生成ChangeSet，真实PG组合验证候选→采用/拒绝；原设定owner、模型/审核来源与正式采用者分开保留。对象base和预计写后版本固定，同名不合并，缩集不自动删人工场景，坏映射不补发ID，空变化保存原基线noop。
- 共享持久intent与原生版本事务回执绑定真实项目二元key、原CAS、实际请求/动作身份及actor/scope/time/reason；回执失败全回滚，丢ACK可凭原意图恢复。first失败回执阻止同intent后来静默成功；原采用历史ACK保留事实。已关闭请求预览变异、坏身份缺项、实际执行错绑、异常访问器/代理泄漏等复审问题，详见[完整记录](original-development-phase1.md)。
- 最终整仓2997项（20工具+2977普通）、603文件策略、13包类型/覆盖率及方法/Agent基线通过；串行实际PG versioning305/script442/server285项均过（各含普通测试），当前server分支97.26%。最终镜像既有API2项、章节worker1项、原创开发1项通过。新增SQL显式安装、LF/checksum，旧SQL不改；四类审查闭合，远端以最终提交实际Actions为准。
- 继续共享CandidateApplication、独立采用LOGIN、认证API/UI；当前仅组件与实际PG组合，未启用新入口，不宣称完整P-APP/G-PROJECT、T1.3或阶段1完成。协议与宿主审核夹具不是实际模型质量/真人评分；编辑器、法务、设计伙伴后补，ComfyUI连接保持。

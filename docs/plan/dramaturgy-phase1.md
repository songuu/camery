# 阶段 1：T1.4 剧作大纲与方法资产

Revision 14 · 2026-11-18。依据 `implementation_plan_v2.md`、`solution_v2.md` 的当前 v2.1 要求继续实施。编辑器验收、法务签核、设计伙伴确认后补；它们不阻塞独立工程任务。当前不是 T1.4 或阶段 1 完成声明。

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与用户价值：把已经确认的故事来源整理成可修改、可审阅、可恢复的改编五件套，后续剧本可追溯到具体来源、节拍和剧作选择。
- 范围：改编说明、人物表、节拍、分集梗概、资产规划清单；题材配方与抽离测试；钩子/卡点、PlotUnit、情绪标注与季冲突引擎；固定原创方法资产、生成、人工审阅、持久化、鉴权应用、页面、正式 IR 接入。完整十集剧本和四台账属于相邻任务，不能由大纲冒充。
- 备选方案：直接扩展 IR 0.6 会改变旧版本语义；仅存自由文本无法检查引用。选择独立、严格且浏览器安全的大纲契约，稳定后通过显式 schema 升级接入正式 IR，保留旧读者及旧快照。
- 组件与消费者：`@camery/script/outline/contracts` 提供纯契约，领域运行时验证图引用及规则；受信任来源适配器读取已确认 StoryBible / 已审阅原创 Development；现有 MethodRunner、ModelReceipt、Durable、PostgreSQL、Access、ProjectApplication 和 Web 延用各自边界。
- 状态与错误：规则问题是待人审事项，不是质量成绩或法务结论。候选不得自批；来源变化、未知模型结果、并发审阅、恢复、跨租户访问均须显式失败。资产清单只表达规划，不产生可用媒体或文件路径。
- Acceptance Criteria：
  - AC-OL-1: WHEN 大纲进入领域边界 THE SYSTEM SHALL 检查完整五件套、连续集数、命名空间内唯一标识、全部图引用、来源引用和容量，不截断内容。
  - AC-OL-2: WHEN 选择题材并检查大纲 THE SYSTEM SHALL 固定原创版本及有效阈值，提供首批三类配置、五种开篇钩子和六种结尾卡点，并输出可定位的规则问题；情绪曲线由分集标注派生，抽离测试结论留给人审。
  - AC-OL-3: WHEN 生成或审阅大纲 THE SYSTEM SHALL 绑定实际来源、简报、方法、题材及模型调用收据，只允许受信任人工主体确认当前候选；修改内容重新检查，豁免逐项记录理由。
  - AC-OL-4: WHEN 进程重启或并发请求 THE SYSTEM SHALL 从 PostgreSQL 恢复不可变候选和审阅，延用预算与未知结果处理，不重复已可能执行的模型调用，不接受过期来源或跨租户访问。
  - AC-OL-5: WHEN 授权用户从页面完成大纲流程 THE SYSTEM SHALL 展示实际来源、五件套、问题及人工审阅结果，并通过显式版本升级写入正式项目；刷新、断线、冲突和旧快照均有真实验证证据。
<!-- design-authority:end -->

## 有序工作

| 任务 | 文件集合 / 依赖 | 风险 | 验收 / 当前状态 |
| --- | --- | --- | --- |
| OL-1 契约、引用验证、规则和题材资产 | `packages/script/src/outline/*`、对应单测、明确子路径导出；无外部依赖 | L2 | AC-OL-1/2；领域增量已验证，见下方证据 |
| OL-2 固定方法、来源适配、生成收据、人工审阅 | script outline runtime / methods / bible 的明确接口；依赖 OL-1 | L3 | AC-OL-3；来源/固定方法/人审及持久宿主/API组合已验证，真人质量仍后补 |
| OL-3 数据库、恢复与预算 | script node / migrations / PostgreSQL 测试；依赖 OL-2 | L4 | AC-OL-4；存储/预算/恢复、常驻宿主与认证服务组合已验证，正式采用继续 |
| OL-4 鉴权 API 和编辑审阅页面 | script transport/read models、server / web；依赖 OL-3 | L4 | AC-OL-3/4/5；先浏览器契约/列表/状态投影，再认证服务/常驻宿主/页面/实际验收，实施中 |
| OL-5 正式 IR 升级、映射与采用 | ir / versioning / projects；依赖 OL-2/3，稳定契约后冻结迁移设计 | L4 | AC-OL-5；v07结构/图/升级、完整纯映射、持久身份、同事务源guard及专用intent/receipt已验证；采用应用、角色及分节读取继续 |
| OL-6 组合验收及交付 | 真实 PG、登录浏览器、私有镜像、远端 CI；依赖以上 | L3 | AC-OL-1 至 5；待做 |

## 契约变化及验证

| 边界 | Before | After / 验证 |
| --- | --- | --- |
| Script contracts | 原创 foundation / episodes | 追加独立 outline 子路径；原导出及旧候选保持兼容 |
| 正式 IR | 当前 0.6 | OL-5 前不修改旧 schema；显式新版本、升级及旧读者回归 |
| 媒体资产 | 可用资源须归档证据 | 大纲仅规划资源；不能给资源 ready 状态、URI 或虚构出图 |
| 质量判断 | 人工验收 | 静态检查只给问题；真实模型质量、3.5/5、法务召回不由合成回放证明 |

先失败单测，再实现；逐步运行定向测试、类型、lint、包覆盖率和组合检查。数据库与全量覆盖率串行运行。提交只包括本任务拥有的文件。发布使用已有授权，最终核对远端精确提交及终态成功 CI。

回滚：OL-1 追加子路径可独立回退；涉及数据后保留追加记录，不删除已有项目、来源或预算记录。新 schema 写入前必须备份并验证旧读者及失败回滚。未知项：真实文本模型凭据与人工质量评价尚缺，按用户指示后补，不能伪造证据。

计划内联检查：无占位验收；AC 只有此处定义；五件套与生成/持久化/页面全链路仍在范围内；估计时间和情绪强度均标注为创作计划，不等同实测或观众反应。

## OL-1 验证证据（2026-11-17）

- 追加 `@camery/script/outline/contracts` 与 `@camery/script/outline`，未改变原 development 导出、IR 0.6、数据库、运行配置或 ComfyUI。五件套严格 schema 包括改编决策、人物、节拍、分集和规划资产/叙事道具状态，辅以配方、抽离提案、PlotUnit 和季引擎。来源 ID 仅检查受信任调用者给定集合；真实来源存储适配与授权属于尚未完成的 OL-2/3/4。
- 有界 JSON 快照在解析前检查访问器、原型、循环与字节容量；输出上限 524288 字节，超限明确拒绝而不截断。集数、局部身份、跨集钩子、完整节拍/单元覆盖、季引擎参与主角、资产角色和逐项来源均检查。叙事道具必须有状态条目，静态道具允许明确记录状态未变。
- 原创首批重生复仇、甜宠、悬疑三类均固定 version 1，标 `camery-original` / `unvalidated`；五钩子、六卡点与现有分类一致。默认连续 3 次重复卡点、连续 3 集低于 6、钩子 3 秒/利害 10 秒允许完整显式覆盖。报告保留有效阈值、固定规则版本和具体位置；情绪曲线只从分集标注派生，所有抽离结论始终留人工审阅，不生成质量分或批准。
- 先红后绿 98 项新增定向测试全部通过。覆盖缺失五件套、断引用/重名、来源伪造、集数/付费选择、图覆盖、道具、无主角/未引用/未参与、规则窗口与阈值、静态/自创来源、恶意 JSON、假 ready/URI 字段和容量；反例不以更弱断言或超时换绿。代码复审发现的季主角闸门已通过三种失败反例修复；代码与 TypeScript 复核无未闭合 P0–P2。
- 最终 `pnpm check` 终态退出 0：3307 项 = 20 工具 + 3287 包普通测试；660 源文件策略零问题，typed lint、13 包类型检查通过，13 个覆盖率任务全部实际执行（无覆盖率缓存），6 方法黄金用例与 10 Agent 合成基线匹配。script 包 501 项，覆盖语句 98.67% / 分支 97.33% / 函数 100% / 行 99.88%；新增 outline 实际覆盖语句/函数/行 100%、分支 98.86%。首轮整仓 lint 抓到测试赋值误写成比较，已修正并完整重跑，失败日志保留。
- 另经 Vite 从新增公开 outline 入口实际打包浏览器 ES 模块，终态 0，194988 字节；没有 Node 内置依赖或浏览器 external 占位。此项验证模块可消费，不代表页面流程已实现。当前无新 HTTP/UI/PG 路径，因此不把旧浏览器或 PG 成果重报成本批新能力证据。
- 最终日志 `artifacts/delivery/outline-workspace-check-final.log` SHA-256=`cc7e3c29519dc48c347c80c0e79e25edf3f890240f7c3412166e6892e72c50ce`；script 单包覆盖率日志 `artifacts/delivery/outline-script-coverage.log` SHA-256=`c07b56773bc737f2235c264dcc6872c81018504099348a19227f9e6e6ea807d6`。远端 CI 以推送后精确提交对应实际运行的终态为准。
- 下一步继续 OL-2：从实际已审阅原创 Development / 已确认 StoryBible 读取不可变来源，固定题材与原创方法 pin、模型调用收据，并提供逐问题人工审阅/豁免。OL-2 至 OL-6 及完整 T1.4、阶段 1 均未完成；真实文本凭据/质量后补，编辑器、法务及设计伙伴确认依用户安排后补。

## Revision 2 实施边界

- AC 语义不变。追加 `outline/node`，生成/收据/摘要只在 Node 入口；已有两个浏览器入口保持纯契约/检查器。共享方法 DSL 仅补标准 `type: ["string", "null"]`，字符串边界仍生效；旧方法包字节与 pin 不变。
- 大纲简报绑定 tenant/project/brief/revision、目标集数/时长、显式付费规划、主辅题材、有效阈值及原创题材全文摘要；模型方法版本固定。模型输入包含来源快照及精确引用目录，正文不进入受信任系统指令。收据必须匹配实际方法请求、作用域和原始输出，失败保留外部 outcome，不重试。
- 来源适配器只从受信任宿主注入的现有 Development/Bible store 读取；检查实际审阅、来源描述符和当前性，返回有界完整创作材料及确定引用目录。快照校验只证明完整性，JSON/普通 SHA 不授权；OL-3 的最终写入仍需事务内再次锁定和检查实际来源，分离读取不冒充原子新鲜度保证。
- 人审绑定当前来源、简报、候选摘要；修改后重新运行规则。抽离影响逐辅轴给人工判断及理由，其他规则逐 issue ID 豁免并保留理由，不允许通配。人工身份/时间/同步授权来自宿主，异步/异常授权失败闭合；审阅解锁下一步，不等同正式 IR 采用、质量分或法务签核。
- 独立文件任务：共享 nullable DSL+测试（L2）；原创大纲 method pack+测试（L2）；简报/来源/生成/人审（依赖前两项，L3）。先定向红绿，再组合覆盖率、真实旧来源读口、整仓与精确提交远端 CI。持久化/页面/正式采用保持 OL-3/4/5 待办，不缩减最终范围。

## OL-2 验证证据（2026-11-17）

- 新增浏览器安全的生成/审阅数据契约、独立 Node 入口以及固定原创 `adaptation.outline@1.0.0`。方法 pin=`11035b982187e3b45b91f8692381b088ed0238a84d91d440bb9935c193475475`，完整结构与领域 Zod 字段/范围/枚举投影对照。共享 DSL 只追加标准可空字符串，旧 chapter 方法 pin=`44f4c043900f43f0896497ade9cf4e8ba0784fcd6f3b6e7d6ad12a6deb9b29f0` 保持，新旧方法基线通过；没有新增外部包，只追加已有 bible 工作区依赖及 3 行锁文件链接。
- 简报固定 tenant/project/brief/revision、目标与题材正文摘要、完整有效阈值。来源读取复用实际 Development/Bible store 的原候选/审阅审计重放，核对来源描述符及当前性；完整材料在等待当前性之前捕获，不遍历原始 document。来源快照含完整引用目录最多 2048 条且≤512KiB，source ID 以快照摘要与具体路径限定含义，不当作跨来源全局实体身份。
- 每次大纲仅执行一次实际结构化适配器调用，或使用原 Agent finish-output 收据构造候选；核对 method/tenant/connection/mode/call/input/output、network/effect/evidence，精确回放输入及回执。未知宿主轨迹保持 unknown，已识别真实完成后的领域错误/取消保持 completed，供应方失败不重试。此处“实际适配器”指真实协议实现，响应仍为明确合成夹具，不是供应方推理或计费证据。
- 人审必须由受信任宿主提供规范 human 身份/作用域/时间及同步字面 true 授权。修改后重新验证全部结构和规则；每个辅轴有人工判断/理由，label_only 必须另有确切问题豁免；其余问题逐 ID 和理由，缺失/重复/多余/通配均拒绝。审阅重放需原候选及当前真实来源，重建整份 report、actor、时间与摘要；校验器只做存档完整性，客户端 SHA/JSON 不产生授权。拒绝仅保留理由，不解锁下游。
- 本轮新增 179 项普通测试（script 152、methods 27）；source 45、method pack 56、生成/人审 51，覆盖精确协议回放、await 前捕获、执行元组篡改、模型 unknown/completed、候选/审计变更、单/双辅轴和人审异步失败闭合。合法超过旧 256KiB 封套、仍在 512KiB 输出限制内的大纲经单次生成、人审及重放通过，没有沿用旧预算或截断内容。
- 新增 4 项实际 PG 来源组合测试，完整 `pnpm test:script:local --coverage` 终态 0：696 项 = 653 普通 + 43 PG（包含旧 39 和新 4，不与整仓重复相加）。实际写入和人审旧 Development/Bible，再经新 pool 重读、来源 resolver、单次大纲合成协议及测试宿主人审；旧简报/小说版本推进拒绝，损坏原审核被旧 store 拒绝。首轮 Bible 夹具执行身份不匹配被 INVALID_EVIDENCE 拒绝，只修夹具配置后完整重跑；未改生产校验、断言或超时。仅使用并清理随机测试租户，无新 schema 或生产来源迁移。这证明旧来源持久恢复与新领域组合，不是大纲自身持久化/预算恢复或真人质量验收。
- 最终 `pnpm check` 终态 0：3486 = 20 工具 + 3466 包测试，677 源文件策略零问题，typed lint 与 13 包类型检查通过，13 个覆盖率任务全部实际执行，6 方法黄金用例及 10 Agent 合成基线匹配。script 653 项覆盖 98.75/97.29/100/99.81%，methods 255 项覆盖 97.25/96.02/98.94/99.68%，门槛保持 95%。代码与 TypeScript 复审无未闭合 P0–P2。
- 两个公开浏览器入口经 Vite 实际构建，3 个 ES chunks 共 201405 字节，未出现 Node 内置或 external 占位。未新增大纲页面，不把浏览器模块构建称为用户流程验收。日志：`artifacts/delivery/outline-ol2-browser-bundle.log` SHA-256=`604825df0c41895fb459bce65e99516147cc9a2d0376ad1cc32c9bd8aea654d0`。
- 整仓日志 `artifacts/delivery/outline-ol2-workspace-check.log` SHA-256=`c8cf009dfbc2fb47b68f781af4be581c71490be92041ca2fe532fe5955550f18`；最终 PG 日志 `artifacts/delivery/outline-ol2-source-pg-final.log` SHA-256=`b945866ba260b07fdf77a45a6a8f717d4fe6a40a10270bc34f7b6d4a08889852`。推送后仍以精确提交对应的真实远端 CI 终态为准。
- 下一步 OL-3：追加大纲持久候选/人审及单阶段 durable/预算宿主，在最终写入事务内重新锁定并检查实际来源；之后继续 OL-4/5/6。完整 T1.4 和阶段 1 仍未完成。真实文本模型/人工质量待实际配置，编辑器、法务及设计伙伴依用户安排后补，现有 ComfyUI 接线未变。

## Revision 3 · OL-3 顺序与恢复边界

AC 语义不变。先追加独立 `camery_outline` schema 的不可变简报/运行/候选/人审及最小 LOGIN，再接现有 AgentRuntime、BudgetLedger 和 Durable。前半交付不能判 OL-3 完成，真实 SIGKILL/unknown/预算与大纲宿主仍需后半实际证据。

| 工作 / 依赖 | 文件集合 | 风险 / 验收 |
| --- | --- | --- |
| 同事务来源读口 | Bible node store/contracts 与 script outline source-transaction；复用既有 Development readForAdoption | L3；原文→Bible run锁顺序、原审计重建、同连接阻塞与回滚 |
| 运行契约与不可变存储 | outline node persistence-contracts/store、独立 installer/migrations | L3；并发幂等、完整封套、原收据、旧结果保存、新审阅新鲜度、原ACK与损坏拒绝 |
| 独立最小身份 | outline runtime-role 与实际 LOGIN 测试 | L4；仅本域SELECT/INSERT及来源必需SELECT，无UPDATE/DELETE/继承/转授权/额外对象能力 |
| 单阶段预算工作流 | outline workflow、节点契约及 dispatcher；依赖存储 | L3；固定任务/模型身份、预算先分配、精确journal与unknown不重发 |
| 真实恢复与交付 | 实际PG/子进程/整仓/远端CI；依赖以上 | L3；提交丢ACK、SIGKILL、新pool、未知结果对账、精确提交CI |

选择追加独立 schema，不改变旧迁移checksum、旧 LOGIN 权限或旧任务版本。安装者显式迁移，普通运行构造器不迁移/授权。失败仅回滚本事务；卸载代码保留历史数据，不删除用户来源。

锁顺序固定为本域 brief→run→来源域既有锁；只读/保存已执行候选可仅锁本域 run，且不再反向请求本域 brief。来源域从不请求 outline 锁；跨域消费者须遵循此外层→来源域顺序。Development仍用 brief→排序后的实际owner/run，Bible仍用文档→run；不改其原顺序。外层同连接事务结束前持有全部来源锁。首次 start/审阅在插入前读最新自身brief并重建当前来源；已付旧结果按冻结run保存，避免丢失回执。原决定幂等ACK先匹配语义请求和当前授权，再判断新的新鲜度，不把历史成功改写为失败。

公开start只接来源描述符，完整来源JSON由同事务实际存储读口生成，不能由请求自报。存档run同时固定实际来源、方法、执行画像与简报，后续modelIdentity/callID必须匹配。完整大纲输出512KiB及封套2MiB保持；工作流使用引用输入/持久结果，不能为适配旧Agent/Worker容量而截断大纲或全局放宽旧门槛。

## OL-3 前半：不可变存储与来源事务

- 新增独立 `camery_outline` 简报/run/候选/人审四表及显式 checksum installer，没有改写旧迁移。`PostgresOutlineStore` 接来源描述符；在外层事务内调用现有 Development `readForAdoption` 或新增 Bible `readForOutline`，原始候选/审计与当前来源都由旧域实际存储重建。同一连接持有本域和来源锁直到 COMMIT，Bible seam 不另开连接、不提交或释放调用方连接。
- 简报修订、运行请求、候选原始模型画像/call ID、人工决定和各列/record/digest均严格绑定。run还按指定revision读取真实历史brief父行，拒绝一致重算自身摘要却不匹配真实父行的快照；历史读取不改读latest，也不新增反向brief锁。完整封套仍逐条验证，聚合progress不被旧256KiB限制截断。
- 同一运行/候选/决定并发提交幂等；保存已执行旧结果不因来源过期丢失原收据。首次审阅重新核当前自身简报和来源；原语义决定重试先做当前人类授权，再返回原actor/time，允许提交确认丢失后恢复。历史拒绝不解锁下游。损坏行、原候选/人审不一致、失效源和不可用存储保持明确不同语义。
- 独立LOGIN只获四表SELECT/INSERT及11张来源表SELECT，不能自安装或读迁移ledger；认证、预算和durable仍需其它连接池。安装助手只给固定对象授权，不创建角色或改写源数据。运行检查覆盖角色标志、继承/成员、表/列/序列、schema能力和转授权；所有实际权限负向mutation探针均有随机测试租户/项目/对象条件，权限回归也不会扩大清理或修改范围。
- 先红后绿修复：默认repeatable read在等待来源锁期间固定旧snapshot，旧实现错误通过来源过期审阅；现以 `BEGIN ISOLATION LEVEL READ COMMITTED` 固定新事务。PG反例先用 `pg_blocking_pids` 证明实际等待，再提交新来源，当前实现明确拒绝。新迁移路径原未被Git属性覆盖，现追加精确LF规则，并以实际 `git check-attr` 和SQL原始字节验证；覆盖率沙箱不同账号时只给该只读命令添加精确workspace级safe.directory，不改全局Git配置。同步connect异常与Promise拒绝均脱敏，失败rollback销毁连接。
- 本轮新增普通测试187项（script185、Bible2）：执行/运行纯契约80、存储协议77、installer/role28、Bible同事务seam2；原来源PG夹具抽成无全局生命周期的非test支持模块，原4项断言保持。测试模型响应/人工主体仍为显式夹具，不证明真实模型推理、账单或真人质量评价。
- 最终 `pnpm check` 退出0：3673 = 20工具 + 3653包测试，688源文件策略零问题、typed lint与13包类型检查通过、13个覆盖率任务全部实际执行；6方法黄金用例与10 Agent合成基线匹配。script838项覆盖98.55/97.41/99.49/99.19%，Bible267项98.21/97.23/97.79/99.60%，门槛未降低。全仓日志 `artifacts/delivery/outline-ol3-workspace-check-final.log` SHA-256=`11a3c1af1836eedef07aa2c696892a53aacea4f586be0c1d9d356677de9fb4e8`。
- 新增9项PG用例验证两种来源实际持锁至大纲人审提交、新pool恢复、提交已成功但确认丢失、旧源结果保存/首次人审拒绝、原决定重新授权、损坏数据拒绝、默认RR竞态，以及专用LOGIN两条来源业务正向、19项缺权限、24项扩权及4个42501探针。最终 `pnpm test:script:local --coverage` 退出0：890项 = 838普通 + 52 PG（旧43+新9，不与整仓重复相加），41文件，覆盖98.92/97.60/100/99.83%。日志 `artifacts/delivery/outline-ol3-pg-verified.log` SHA-256=`7395623a21872e77e98a3c206eee6c4032da7f11a5ec8753418a8989b71c7afa`。代码、TypeScript及数据库复审无未闭合P0–P2；精确提交远端CI仍以实际终态为准。
- 本批是 OL-3 的存储/权限前半。专用预算工作流、SIGKILL、大纲unknown结果恢复及真实宿主接线仍待后半；之后继续API/页面/正式采用。完整OL-3、T1.4及阶段1均未判完成；真实文本模型/人工质量、编辑器、法务、设计伙伴仍按原安排后补。

## Revision 4 · 单阶段预算与恢复

AC语义不变。复用现有AgentRuntime、固定方法driver、BudgetLedger及Durable，不写第二套预算或未知调用机制。任务只有 `{projectId,runId,runDigest}` 引用；受信宿主从同一不可变run解析完整模型输入。引用driver同时核对原引用、trusted agent/方法/作用域，再以完整输入委托既有driver；policy摘要固定run、来源和协议版本。模型收据仍绑定实际完整请求，不改为引用JSON的摘要。

ModelSession仅在未缓存的decision effect内由host factory构造，先分配预算再允许调用；恢复缓存journal无需供应方配置或新session。真正新调用前核当前简报/来源，已付历史结果继续保存。工作流输出与persist-step使用小引用，完整候选留DB；不改旧131072字节Agent上下文和1MiB Worker门槛，不截断合法512KiB大纲。

dispatcher先核原任务/状态并排空journal尾部，再看candidate/review/currentness；终态无候选或unknown不造新ID重发。持久人审仍走已有显式人类授权，不能由task完成自动确认。新增profile/candidate/rejection完整重放供workflow与存储共用。

顺序：固定共享进度/引用契约→独立dispatcher及夹具→预算workflow→进程内Actor/Worker回放→真实PG提交丢ACK、SIGKILL、unknown明确对账、低预算/旧来源拒绝→整仓与精确提交CI。纯引用dispatch/测试夹具为L2独立文件；生产预算与恢复编排L3在根实施；真实PG/coverage串行。真实文本质量及API/页面/常驻配置型宿主仍待OL-4后续，不用合成协议替代人工质量验收。

## OL-3 后半：预算与原日志恢复证据

- 新增113项普通测试：dispatcher32、进度35、workflow4、故障41、容量1。预算拒绝或来源变化在供应方session前失败闭合；factory等待中来源变更再次拒绝，恶意profile访问器不执行。原模型输入/输出与receipt绑定，不以引用替代实际请求摘要；storage失败、ACK丢失、历史人审和过期来源均保留原journal语义。代码、TypeScript及安全复核无未闭合P0–P2。
- 容量夹具由实际Bible候选/确认流程产生，未自报已批准JSON。完整来源168240字节、模型输入171235字节，完整输出452106字节，经过一次真实协议适配器及Agent工作流。原131072/1048576/524288/2097152字节门槛未改，未截断正文。
- 新增6项真实PG恢复用例：候选COMMIT后丢ACK并在人工审阅/来源变化后排空原尾部；decision提交前失败转unknown，保存原始完整Agent envelope，显式人工对账后新pool恢复；预算不足/旧来源零session；大输入/输出完整通过Worker；decision实际SQL提交后SIGKILL自有child，新pool不配置模型凭据恢复原候选且仅一份allocation。终态前结算明确拒绝，终态后以显式夹具账单结算；这不是实际供应方账单或真人质量证据。数据库只读复核无未闭合P0–P2。
- 首轮1010项有1项失败：冷启动聚合入口在20秒检查点前仍停于模块加载。独立禁用tsx缓存复现原入口32553ms；child改为精确runtime模块导入后1172ms，不放宽20秒/原断言。完整重跑 `pnpm test:script:local --coverage` 终态0：1010项=952普通+58 PG（旧52+新6，不与整仓重复相加），48文件，覆盖98.66/97.08/100/99.77%，门槛保持95%。最终日志 `artifacts/delivery/outline-workflow-pg-verified.log` SHA-256=`a2b7ff240d4fea58be99353538df4fdee034b64fcf438372032ca2e9afdcc588`；失败日志 `outline-workflow-pg-first.log` SHA-256=`f409a3d3808a5b7f428a82c306a5e1628ebc15b0212e5f5e73c5f99520638a60`。
- 整仓覆盖率首轮发现原聚合进度用例包含生成/保存/人审/读取/回放，分段计时合计11767ms，超过普通单测10秒。转为真实PG集成场景，保留全部容量/内容/单调用断言并增加新pool恢复，未改任何超时/门槛；普通容量用例仍完整验证大输入/输出。最终 `pnpm check` 终态0：3786项=20工具+3766普通，702源文件策略零问题，13包类型检查（10缓存/3实际）通过，13包覆盖率全部实际执行，6方法golden/10 Agent合成基线匹配。script951项覆盖98.31/96.85/99.51/99.16%。日志 `artifacts/delivery/outline-workflow-workspace-check-final.log` SHA-256=`e1c43c7c801fa822d6adde715f4d308a0c7d7a38566f21f74583437a2cd7c553`。
- 最终真实PG完整复验退出0：1010项=951普通+59 PG（旧52+新增7），48文件，覆盖98.66/97.08/100/99.77%。新增聚合用例从真实Bible确认开始，大纲实际SQL保存后丢ACK，人工审阅后完整progress超过2MiB、三个封套各≤2MiB；新pool恢复原journal，整个progress逐字段不变、零新session、总模型调用/预算分配各一次。Docker在复验前曾停止，引擎恢复后原测试容器健康，再串行执行成功；未重建或删除原数据。最终日志 `artifacts/delivery/outline-workflow-pg-final-verified.log` SHA-256=`0335633395183465baf0c870c94613c0af8232f6799908adbf41efe7f8056541`。
- 此批完成核心预算与恢复验证，继续OL-4的认证API、五件套编辑审阅页面及常驻配置宿主，之后OL-5正式IR与OL-6组合。完整T1.4/阶段1仍未完成；真实文本质量、编辑器、法务和设计伙伴依原安排后补，ComfyUI接线未改。精确提交远端CI以推送后实际终态为准。

## Revision 5 · OL-4 数据边界与服务依赖

AC语义不变。HTTP请求仅接业务数据，tenant/project/actor/time及执行画像来自受信宿主；来源选择仅传具体run/review描述符的无scope版本，start在宿主补scope后由现有事务store重验。来源列表只是发现信息，不授予许可或声明新鲜；detail以真实isCurrent为准。完整五件套、来源材料/目录、固定profile/阈值、规则问题与人工决定必须可展示。

| 有序任务 / 文件owner | 风险 / 依赖 | 证据 |
| --- | --- | --- |
| [P] 浏览器transport：outline/http.ts 与对应单测 | L2；既有领域已稳定 | strict请求无scope/执行注入、逐操作/逐输出容量、规则报告及完整detail |
| [P] run/brief目录：outline/node/catalog.ts、brief-catalog.ts及单测 | L2；只读metadata，不作授权/新鲜度判断 | scope绑定cursor、微秒keyset、最新brief含无run、坏行脱敏 |
| [P] 两类来源发现：outline/node/source-catalog.ts及单测 | L2；只读已审阅标记，最终start仍走事务重验 | Development真实owner/Bible已确认，分kind cursor，参数化scope与无正文/回执 |
| 状态/详情投影：outline/node/read-model.ts、导出及组合 | L3；前三者契约收敛后根实施 | 原journal优先、unknown/blocked/未投递区分、完整大输出、无profile/receipt/内部错误 |
| 认证API与常驻宿主：server模块/options/config/runtime/host/worker及部署 | L4；依赖以上 | 默认关闭、精确权限、独立pools/LOGIN、无text仍恢复缓存、新调用失败闭合、GET不enqueue |
| 五件套编辑审阅页与组合：web pane/workbench/state及实际PG/镜像/浏览器 | L3；依赖API | 逐引用/逐issue/抽离人审、原ID丢ACK、草稿与迟到隔离、桌面/320px、完整容量 |

transport约定：public source selection去除tenant/project；run summary含runDigest、brief身份、时间、candidateDigest/reviewStatus，不将仅本域brief检查冒充sourceChanged；status增加真实currentness及原任务状态，未投递明确为not_dispatched。详情只投影完整创作材料、候选/审阅输出与规则/人类审计，不暴露execution/model receipt/原Task/error。

容量：小请求及列表≤64KiB，confirm整体≤2MiB且output单独≤512KiB，detail整体≤6MiB且source/output分别保留既有限制。只为新操作指定界限，不放宽旧HTTP路由、Agent或Worker。目录使用21取20的确定keyset；source query显式kind，cursor绑定kind/tenant/project。catalog只SELECT，不安装新schema、不授额外源权限。生产认证/API/worker开启前必须完成对应权限、实际HTTP及镜像gate；核心数据边界不冒称页面已交付。

新增导出保持旧入口和旧迁移字节不变。回滚可撤新路由/开关及导出，保留已有不可变run、日志和预算；不自动写IR或删除用户来源。先红绿窄测，再类型/lint/完整包覆盖率、真实PG、浏览器入口构建、整仓与精确提交CI；PG/coverage继续串行。未取得实际文本配置仍可推进独立工程，不能以合成协议声称质量签核。

## Revision 6 · 共享 JSON 精确计数性能

AC及容量/超时语义不变。真实PG首轮1113项中仅原聚合恢复用例超过45秒；移除追加投影后同一旧链路仍超时，定向分段为fixture10356ms、首Worker10588ms、候选读取1268ms、人审/读取8510ms、完整校验5131ms、恢复Worker9653ms。多次完整JSON快照对长ASCII串逐字符回调的累计开销成为本批大容量验证的实际瓶颈。

新增L3共享原语任务：`methods/src/json.ts` 仅为可原样编码的ASCII（排除引号、反斜杠、控制及非ASCII）采用原生扫描后`spend(length+2)`；UTF8、转义、surrogate、对象/数组/引用/访问器及先计数再复制语义保持原路径。`methods/test/json.test.ts` 增加5项大字符串/全UTF16精确边界与超限后不访问后续对象，先证原行为再实施快路径；原PG失败作为性能红例。所有消费者仍用原snapshotJson签名，旧方法/预算/receipt摘要不变。

依赖/证据：先methods窄测/type/lint及code/TS/security只读复核，再同一PG单例对照，最后完整PG/整仓/浏览器构建与精确提交CI。回滚可单独撤快路径，存量数据/JSON/摘要无需迁移。定向性能结果仅描述当前主机/coverage条件，不作为生产SLA；子集覆盖率不冒充完整包95%门槛通过。完整链路断言、45秒检查点及所有容量不调整。

## OL-4 数据边界验证证据

- script新增99普通测试：transport22、run目录22、brief目录16、source目录29、状态/详情10；先缺模块/反例失败再实现，组合99通过。请求拒绝scope/执行/身份/receipt注入及恶意getter/cycle，合法大输出和带400条人工理由的超过1MiB confirm完整保留，超限/401条/3辅轴拒绝。元信息坏行、filter错配、null/undefined误报NOT_FOUND、query bind泄漏均由反例闭合。候选与人改输出、真实规则问题、原journal和not_dispatched/unknown/blocked/terminal状态分别投影，不凭task成功授予人审。
- 新增4项实际PG用例验证两类实际来源发现/开始/候选/人工修改、新pool重读与来源变更拒新start；显式人类权限false拒绝。实际episodes-only分支没有child foundation审核行，选择器仍返回真实owner摘要。22个run的同毫秒不同微秒及C排序分页、最新简报包含21个无run对象和空白前缀均验证。公共投影另外在真实大Bible输入/完整大纲上核对不截断，原聚合恢复断言完整保留。
- 完整 `pnpm test:script:local --coverage` 终态0：1113项=1050普通+63 PG（旧59+新4），54文件，覆盖98.62/97.08/100/99.79%，门槛95%。日志 `artifacts/delivery/outline-ol4-data-pg-verified.log` SHA-256=`0dc12c76f18b59f71874f8e6eaba9af4e3ddc0da2e41e3974b012706dc037c34`。code/TS/DB/security只读复核无未闭合P0–P2；这些是库/数据组合证据，不是登录API/UI或真人质量验收。
- 原恢复用例失败及定向诊断保留，单例对照在相同45秒门槛下通过，套件11.33秒；因只跑1例，子集整体覆盖率不足而退出1，未作为包门槛成功。随后完整PG实际过95%门槛。诊断日志 `outline-ol4-large-profile.log` SHA-256=`6e8324f83294a55403dbdfff7d64e0e120053142d591b9238a185f22086cd954`；快路径对照 `outline-ol4-large-profile-optimized.log` SHA-256=`8549c1016020d71e083e5b3f4760a86fc63bf14337ede15bf0db61c754f133e7`。新增5项methods精确测试覆盖大ASCII、完整UTF16单元、property key/array、转义及超限停止访问；38项JSON窄测及安全独立穷举通过。
- 从公开package子路径实际构建浏览器ES，135771字节，未出现Node内置或external占位。初次工具探针的Windows绝对路径import错误已改为file URL，生产导出不受影响。最终日志 `artifacts/delivery/outline-ol4-http-browser-verified.log` SHA-256=`102c4b60488ffec6953c2541d19c4d6fab9f4fcd0e73725f52d560e0dad6cb6d`。继续本计划的认证API、独立常驻宿主及五件套编辑审阅页，再执行镜像/真实浏览器组合与正式IR采用。
- 最终 `pnpm check` 终态0：3890项=20工具+3870普通，716文件策略零问题、typed lint与13包类型检查（6缓存/7实际）通过，13包覆盖率全部实际执行、0覆盖率缓存，6方法golden及10 Agent合成基线匹配。script1050项覆盖98.30/96.82/99.54/99.26%，methods260项97.34/96.12/98.94/99.68%，各95%门槛不变。全仓日志 `artifacts/delivery/outline-ol4-data-workspace-check.log` SHA-256=`bc04ff8c448b05373d3fb47d4b16dae44eb636233185e1ed786ef7ed208e758b`。精确提交远端CI仍以推送后实际Actions终态为准。

## Revision 7 · 认证 API 与可恢复常驻宿主

AC不变。追加 `/api/v1/projects/:projectId/outlines`，复用全局默认拒绝会话/RBAC；read/capabilities/list/source只需project:read，brief/start需task:run，confirm/reject需candidate:review。tenant/actor/time来自宿主；public source selection在宿主补scope，固定方法由领域生成。新run使用部署preset；同一start语义重试读实际原run后沿用原execution并由store重新核请求，不因当前text配置移除/变化而遗失原journal。不同简报或来源请求仍冲突，终态/unknown不造新任务。

| 有序任务 / 文件owner | 风险 / 依赖 | 完成证据 |
| --- | --- | --- |
| [P] bounded outline host + test（独立新文件） | L2；复用既有目录/dispatcher/Worker，无新授权决策 | 全run公平分页、原尾部优先、unknown跳过、每轮/停止边界、无泄漏 |
| [P] outline config wrapper + test（独立新文件） | L2；复用现有文件secret reader及单阶段execution校验 | 默认关闭/半配置拒绝、await前捕获、无text合法、同一份额预算、错误脱敏 |
| [P] 认证HTTP夹具/反例（独立test文件） | L2；已冻结options/transport，根实现控制器 | 各角色/作用域/会话、noText读取/保存、start原ID恢复、确认容量/身份注入/错误映射 |
| API模块/runtime/app/main/worker/build接线（根） | L4；以上收敛后串行组合 | 同会话逐请求授权、精确路由2MiB body例外、固定profile lazy session、独立pools/LOGIN验证、cached无text恢复 |
| 实际PG HTTP及镜像/部署（根） | L4；服务接线后 | 实际认证/存储/Task/budget、低权限pool、原ACK/撤权/并发、新pool/停止恢复、默认关闭/实际构建 |

新worker允许配置启用但text为空，仍注册原workflow并扫描全部run；cached decision不调用session，新的未缓存请求失败闭合。对调用中的停止等待当次attempt完成再关闭池；强杀仍交既有lease/unknown门禁。任务/预算LOGIN复用既有明确固定权限实现的alias，不扩大data LOGIN，不自安装迁移。API数据读写按真实会话tenant及项目grant限定，模型preset/常驻宿主额外固定部署project；配置tenant必须匹配认证tenant，页面与IR采用仍后续。

界限：全局body16KiB和旧路由保持，仅新confirm路由POST允许2MiB，schema继续output512KiB与人工判断/豁免上限。ModelSession新增完整input2MiB/output512KiB配置，transport及run完整execution画像由受信host固定；模型配置/connection/mode/modelIdentity不从HTTP读取，构造runtime/session不发网络。GET不enqueue、不创建模型session。正式采用capability保持false直到OL-5实际接入。

发布gate：先红绿窄测，合并后type/lint/完整覆盖率，code/TS/security/SQL只读复核、实际PG及构建/镜像证据，最后整仓与精确提交远端CI。PG/coverage串行。开关默认关闭，失败关闭新模块并保留原数据/任务/预算；不触碰现有ComfyUI、编辑器项目或用户脏文档。真实文本凭据及质量仍后补，不由合成HTTP协议替代。

## OL-4 API / 宿主验证证据（2026-11-18）

- 新增79项普通测试：HTTP36、host24、config13、runtime5、task角色alias1。完整server普通505项、46文件退出0，覆盖98.31/95.70/99.47/99.73%，门槛95%。日志 `artifacts/delivery/outline-api-server-coverage.log` SHA-256=`3478c8ac8766b30f55382e53a6211d3ac25976e95671f3a98705fd088ad5e3da`。
- TypeScript复审发现transport默认1MiB不足以承接ModelSession完整2MiB输入；仅本域显式设置2MiB+64KiB封套，保留共享默认及响应4MiB。json_schema/json_object各自通过实际loopback HTTP，输入超过1MiB、输出300000字节，单次调用/收据与无隐式重试断言保持。代码、TS、数据库和安全只读复审无未闭合P0–P2。
- `pnpm test:server:local --coverage` 终态0：558项=505普通+53 PG，59文件，覆盖98.22/96.34/99.74/99.91%。新2项分别从真实已审阅Development/Bible开始，验证实际三类最小权限LOGIN、会话授权/撤权、真实合成模型HTTP、candidate与人审提交后丢ACK、新pool无text恢复、来源过期和已审阅尾部恢复、unknown明确对账/取消不重投，以及超过256KiB完整人改输出。日志 `artifacts/delivery/outline-api-server-pg.log` SHA-256=`f8b91000a341cb8215f85f9c11b7989e71423a75ff05328af9b7026d45150c01`。无新SQL迁移或grant策略扩权。
- 实际构建测试保留3项并验证5个原生进程入口，新worker与既有worker同样仅排除父进程覆盖率；API/host/config/runtime保留95%门槛。同镜像构建退出0，manifest list ID=`sha256:8aac1a8dda17714fca2ce78402076bd03d8f60826819867661af04ad45b4ef37`，构建日志 `artifacts/delivery/outline-api-image-build.log`。
- 新 `pnpm test:private-outline:local` 终态0，1项：独立随机Compose project/tenant/三类LOGIN，默认关闭404、真实HTTP合成provider、decision提交后在本运行candidate唯一键阻塞窗口SIGKILL（137）、原lease过期后无text重新创建API/worker，原候选/收据恢复且provider调用1次、allocation1份/300tokens。超过256KiB人工确认、API重启后审计、无text简报保存/新start409、无关任务不领取、撤销401、日志脱敏及正常stop退出均通过。使用未提交本运行占位PK制造窗口，不锁整表，不修改被测生产代码。日志 `artifacts/delivery/outline-api-private-compose-verified.log` SHA-256=`f647cb7fc55b2662fb8550f1913c80d9415b8ee4887a1857ba8e2795820b8439`。
- 首次Compose运行遇外部Docker/会话中断，仅有RUN输出，未计成功。核实原进程停止后，逐项核验自有project label、随机tenant/role及临时目录，清理其2容器、3角色和8个明确文件；基础PG和外部网络保持。重跑同一已构建镜像后取得上述明确终态，不以启动或子集输出代替通过。
- 同镜像旧容器串行回归均终态0：API2项（`outline-api-existing-api-compose.log` SHA-256=`67a815b2f1afbc24d4ee7786b08cede95e469afd47bde8007a756401c8da3ac9`）；章节worker1项（`outline-api-existing-worker-compose.log` SHA-256=`e769c2722c5897e558ecb918a5701adeae01799b3cf8c15f783ba1e04f33e854`）；原创开发1项（`outline-api-existing-development-compose.log` SHA-256=`f3dcfde18d5afaab67725ff4c9487b222de17f3abdc4928ab81400cf2a61dc9c`），日志均位于 `artifacts/delivery/`。固定私有化入口只允许已声明target和参数，CI追加新大纲步骤。
- 最终 `pnpm check` 终态0：3969项=20工具+3949普通，13包类型检查成功（6缓存/7执行），13包覆盖率全部实际执行；方法6项和Agent10项基线匹配。日志 `artifacts/delivery/outline-api-workspace-check.log` SHA-256=`7ff5be8ce95bb1847fdd27a0f9689deb8802120cfd5bebd307e382a63f94ee03`。上述PG总数包含普通测试，不与整仓重复相加。远端以推送后精确提交CI实际终态为准。
- 此批交付API、配置型常驻宿主与部署/恢复组合，页面和OL-5正式IR采用继续；完整OL-4、T1.4及阶段1仍未完成。真实文本供应方/账单/质量、编辑器、法务和设计伙伴继续后补，不以合成HTTP或数据库断言替代，ComfyUI接线未改。

## Revision 8 · 五件套编辑审阅页面

继续 AC-OL-3/4/5，验收契约保持。根负责 OutlinePane/Workbench、样式、导航及浏览器组合（L3）；三个互不重叠的 L2 子任务分别为浏览器 API/client 测试、纯审阅校验状态/测试、普通表单编辑器/静态视图测试。子任务不运行 PG/coverage、不提交，根审查组合后串行执行全覆盖与实际浏览器。来源选择只接实际已审阅 Development/Bible 目录；简报保存与开始生成分开，丢 ACK 固定原 command/runId；GET/刷新/恢复不触发生成。审阅草稿按 run/candidate/review 隔离，后台状态更新不覆盖当前编辑，切换项目/会话后迟到结果无效。

五件套及配方/PlotUnit/季引擎均提供普通字段和语义引用选择、完整容量下分页、逐问题理由与独立抽离判断；原候选与人改审阅可切换。固定源材料供核对，明确过期来源、unknown、权限与无配置状态。页面采用现有纸色/橄榄绿/陶土色和中文创作顺序，桌面及320px验证；正式采用保持未开放，随后继续OL-5，不把页面或合成模型回放判定为完整阶段1/真人质量。

## OL-4 页面验证证据（2026-11-18）

- 新增42项普通测试：API9、纯审阅状态22、完整编辑器7、工作台SSR4。API严格请求/响应归属和有界JSON、超过256KiB输出/超过2MiB详情、原ID重试；校验状态复用领域图引用/规则，辅助题材逐一判断、精确豁免集合和原候选不变。编辑器全部8节和增删/换序/分页、safe JSON pointer引用摘要、访问器/原型防护均有断言。
- 页面先红测缺失模块，再实现。代码复审发现3项P2并闭合：理由先填不得自动设为participates；历史审阅必须展示report/ablations/waivers；确定409先查原run成功或明确404才能解除pending。浏览器首次失败定位抽离select标签包含option文本，增加明确accessible label；第二次失败来自夹具getBrief传入多余runId导致目录400，修正只传真实scope/briefId。未放宽断言、超时、容量或覆盖门槛。
- 最终真实浏览器命令 `pnpm --filter @camery/server test:browser:outline` 终态0，1个组合case内8组明确结果。使用已安装Playwright/Chromium（agent-browser命令不可用），真实Nest/同源认证/领域验证，内存SQL协议和明确合成模型，model session与budget.allocate各1次、人审1条。源码及命令已落库；显式环境路径见web README，不自动安装依赖。
- 浏览器覆盖保存/开始丢ACK的原命令、原runId；过期来源409后核验原run404再创建新run；只填抽离理由仍不能确认；原候选/草稿对照、刷新/标签/记录切换草稿隔离；真实资产分页/增删与定位规则豁免；恶意模型HTML仅文本；完整大于256KiB人改输出和confirm提交后丢ACK恢复；重载后已保存判断/豁免依据、无text/viewer只读、320px无横向溢出；断开后迟到GET不回填。该夹具不冒称真实PG并发、provider推理/账单或真人质量。
- 最终浏览器日志 `artifacts/delivery/outline-browser-acceptance.log` SHA-256=`31dcd2831e973c33244fcab9405cae9083910901037ff2ef7435bd5b2738f3db`；8组报告 `artifacts/delivery/outline-browser/report.json` SHA-256=`a4134f365109dd330ead43d507e51db8098c9f0e5bfb612e432d250827e7ad21`。桌面1440×1000截图 `desktop.png` SHA-256=`09c1bde73aec97fa4314f30dcd8c61ecd3dc7389bbd182fae41f21740d7e4e9e`、320×900截图 `mobile.png` SHA-256=`e0449a99adfe4798891b9cd0c1d0b6460aeaea8948212854ad0488f9c8b2ee7c`，位于同目录，均实际查看。来源长哈希改为语义摘要，只改可见标签，完整真实引用仍保留。
- 前端构建终态0，大纲单独懒加载；日志 `artifacts/delivery/outline-browser-build.log` SHA-256=`08c23cf2ac9f6852d7d6049912fa9fe447df87569db75819665e268d81e4b3f2`。Vite仍提示主chunk约500.56kB，无调大告警阈值，不据此宣称性能已完成优化。
- 最终 `pnpm check` 终态0：4011项=20工具+3991普通，746文件策略零问题，13包类型检查成功（11缓存/2执行），13包覆盖率全部实际执行；方法6项/Agent10项基线匹配。Web175项覆盖98.24/95.93/98.58/99.69%，新outline-review-state四维100%；server505项98.31/95.70/99.47/99.73%。日志 `artifacts/delivery/outline-browser-workspace-check.log` SHA-256=`ddf21d5999b0ef152903641c03b335d5cd09b34f274d931f6e4f91543e08e6ae`。TSX既有策略由SSR/浏览器作证，未改变纯TS95%门槛或新增覆盖排除。
- code/TS/security只读复审无未闭合P0–P2。此批不改变数据库/权限/宿主生产代码；真实PG/镜像恢复由前批独立证据及最终精确提交CI再次核验。OL-5正式IR版本/映射/采用和OL-6后续组合继续，完整OL-4/T1.4/阶段1不提前判完成。编辑器、法务、设计伙伴及真实文本质量依用户安排后补，ComfyUI保持。精确提交远端CI以实际终态为准。

## Revision 9 · OL-5 显式正式结构与升级

继续AC-OL-1/3/4/5，唯一验收语义不改。直接扩展v06会改变旧严格读者；把五件套塞进自由JSON无法验证图，复用旧scene/媒体beats/ready资产会虚构已制作内容。选择冻结v06严格schema/validator，追加v07结构化规划对象、显式顺序升级及随后完整来源采用事务。IR仅依赖timeline/zod，不反向依赖script；完整模型/人审证据回放留在script映射层。

| 边界/消费者 | Before | After / 一致性证据 |
| --- | --- | --- |
| IR package / ChangeSet / CLI / tracked JSON schema | 严格v05/v06，v05→v06 | 保留旧版本读者和原升级语义，显式v06→v07；完整图参与旧ID/锁/快照验证 |
| 正式大纲 | 无 | adaptation_plans、outline_beats、outline_episode_plans、asset_plans、outline_plot_units、outline_adaptation_decisions；人物和Episode复用正式身份，规划与已制作对象分离 |
| 版本域/PG | 精确base、升级独占、人类项目级采用、JSON历史 | 顺序升级，不跳级；旧快照/历史/锁/待候选保持；不因版本号重写旧SQL |
| 旧开发采用/Workbench/正式投影 | v06固定读者、版本枚举、500ops/512KiB手工入口 | 新head仍接受旧开发流程，版本投影包含三版本、引用/所属白名单完整；旧入口容量保持 |
| 大纲映射/采用 | 后续待接入 | 原64人物/500节拍/100集/256资产/100PlotUnit/512KiB输出保持。规范化可能超过1000ops及512KiB，设计专用有界映射/intent/分页，不能降低输出容量或放宽全域旧入口 |

任务顺序：冻结v06读者/窄测[P,L2独立新文件]与纯新类型schema[P,L2独立新文件]；根串行实现v07图/所属/来源引用/版本验证及包升级（L3）；根串行接版本域、旧开发映射/服务/读取投影消费者并实施真实PG回归（L4）；随后完整大纲local→formal映射、专用完整容量采用intent/source-guard/最小权限/API/页面及OL-6（L4，依赖前者，当前不预称交付）。本批类型基础不能冒称整个OL-5完成。

规划对象必须保留全部改编取舍、配方/标志场景/抽离判断、节拍与钩子卡点/情绪/付费卡点、资产道具状态、PlotUnit、季引擎、来源/简报/方法/人审谱系；稳定引用固定版本，旧依赖显式stale，不重绑当前对象。专用正式大纲图预算16MiB，为局部ID→稳定版本引用扩张留足界限，后续映射必须证明完整容量。手工来源策略在尚未接专用guard前拒绝新增或修改受来源管理的大纲对象。

Gate：失败测试→窄测→类型/lint→代码/TS/安全/DB复核→串行PG与覆盖率→整仓/派生schema一致性/原镜像流程→精确提交远端CI。升级前保留原快照及对象历史，失败事务不动head；不在现有用户数据库自动升级或回退已采用schema。回退服务时保留新数据和明确不支持版本错误，不能把v07静默当v06读取。前批页面提交bfcb3ba远端CI已实际成功，https://github.com/songuu/camery/actions/runs/44220296862；当前仍不是完整T1.4/阶段1完成声明。

## OL-5 结构与升级基础证据（2026-11-18）

- 冻结原v06 schema/validator，测试记录原package/ChangeSet JSON Schema哈希，保持v05/v06严格字段、原升级、完整图ID/锁/连续性快照语义。新版IR与tracked两份JSON Schema同步支持三版本，`SCHEMA_VERSION`为v07，原常量显式为`DEVELOPMENT_SCHEMA_VERSION`；旧测试仍验证原0.6字面值，只将对应旧语义导入改成明确别名。CLI生成物与结构校验均经真实回归，不改v03→v05旧样例迁移。
- 新增109项普通测试：IR89（冻结8、图反例与完整容量70、schema/升级边界11）、版本域4、旧开发映射5、服务10、web1。新增真实PG5（版本域3、服务v07模式2）。最大正式图夹具64人物/500节拍/100集/256资产/100PlotUnit/128取舍，超过1000对象；这是正式结构/引用验证，不冒称已经实现完整local→formal采用映射或付费生成512KiB→正式图扩张证明。
- 核心复审3项P2及跟进闭合：发布的v07操作使用独立literal升级边而非仅运行时refine；16MiB计量按引用ID纳入当前对象，不因旧pin而漏计；当前Episode/PlotUnit独立核验自身完整节拍覆盖和1..N顺序，不能由父对象stale跳过。对应wire、超大stale对象、缺拍/重复顺序反例全部红→绿。安全复审另发现旧versioning只透传开发stale告警，已追加大纲告警并以提交/采用/实际PG断言核验。合法旧pin保持原值并显式stale，不静默重绑。
- 新v07输入预算选择只读取own data descriptor，原开发映射保留旧2MiB边界，新正式head有独立有界扩张空间；空值、访问器及proxy错误回到明确DevelopmentError，不执行getter、不外泄上下文。纯转换不授予来源或采用权限；通用手工六集合写入/首次采用均失败闭合，后续专用来源guard仍未启用。
- IR完整486项终态0，覆盖98.69/97.40/98.56/99.69%；日志 `artifacts/delivery/outline-formal-ir-coverage.log` SHA-256=`a4f2bb2d8359bbd43e650f63fe9479bc3e043aa3deef930c66b41cba0a0d7058`。包版本更新后按仓库verify-deps要求执行 `pnpm install --offline --frozen-lockfile`，仅刷新现有工作区状态，锁文件无变化、无新依赖。
- `pnpm test:versioning:local --coverage` 最终终态0：312项=258普通+54PG，22文件，覆盖98.06/95.88/99.47/99.84%。新3项使用随机独立tenant/project：v05旧候选采用→v06→v07跨新pool、原请求/4快照/历史/撤权与重放；实际大纲锁/owner解锁修订/旧值与stale子pin；receipt INSERT后失败同事务回滚、真实COMMIT后注入ACK丢失、新pool恢复与旧CAS重放不重复guard/行。首次运行定位一处冻结夹具需structuredClone及上述告警遗漏，修复后全量重跑；不放宽断言/期限。日志 `artifacts/delivery/outline-formal-versioning-pg.log` SHA-256=`7a61f40d0f646d23f9ef8e99d64907e47be27b684992a8426e988eefdd268d61`。
- 最终代码串行 `pnpm test:script:local --coverage` 终态0：1118项=1055普通+63PG，覆盖98.62/97.10/100/99.80%；日志 `artifacts/delivery/outline-formal-script-pg.log` SHA-256=`b23fba02c727bcf2fb9880f8f98a4190f6310f65b0137e52e52e2e3256abdbb1`。`pnpm test:server:local --coverage` 终态0：570项=515普通+55PG，覆盖98.19/96.38/99.74/99.91%；日志 `artifacts/delivery/outline-formal-server-pg.log` SHA-256=`0b14107791218d0d93304accd00598e1150b6bb4d3baf7723061584edccc5f63`。新增v07模式均保留原v06完整断言，实际LOGIN、来源事务guard、准备/采用双回执共同验证旧开发链路兼容。SQL迁移、GRANT/角色策略未修改。
- 最终前端构建终态0（主chunk505.66kB仍有原Vite提示，未放宽告警）；日志 `artifacts/delivery/outline-formal-web-build.log` SHA-256=`00695f8b90489dd3c4145b33b74338f96c28cb4a2a73c93dba96b9a0770687a0`。最终Chromium大纲回归1case/8组终态0，日志 `artifacts/delivery/outline-formal-browser.log` SHA-256=`72b270d132d3ade198af672e03218f63a73360d6f790e65939fd3dac73b731ab`。报告及desktop/mobile在 `artifacts/delivery/outline-formal-browser/`，哈希分别为`a4134f365109dd330ead43d507e51db8098c9f0e5bfb612e432d250827e7ad21`、`09c1bde73aec97fa4314f30dcd8c61ecd3dc7389bbd182fae41f21740d7e4e9e`、`e0449a99adfe4798891b9cd0c1d0b6460aeaea8948212854ad0488f9c8b2ee7c`，与前批已视审证据字节相同。执行前明确备份/执行后恢复前批三文件，历史路径哈希保持。
- 最终 `pnpm check` 终态0：4120项=20工具+4100普通，759文件策略零问题，13包类型检查成功（3缓存/10执行）、13包覆盖率全部实际执行，方法6项和Agent10项基线匹配。日志 `artifacts/delivery/outline-formal-workspace-check.log` SHA-256=`3316d8affedfd9b3af9e810c0779c3eb0e10a612b332c1e53e3e467a98d252b4`。各PG总数含各自普通测试，不与整仓重复相加；code/TS/DB/security复审无未闭合P0–P2。新镜像与原四组容器流程由最终精确提交CI再次核验，以实际终态为准。
- 已验证的后续缺口：合法AdaptationPlan含32×500节拍标志场景引用及完整人工理由时，单对象1,101,588字节可通过IR校验，却超过原Workbench983040字节，即使limit1仍明确INPUT_LIMIT。当前不声称完整容量正式阅读交付；后续须专用分节分页完整返回，并解决>500ops、intent正文/差异/告警容量，保留旧通用入口约束。人物/正式Episode只是复用身份，规划秒数按brief解释，不把正式Episode元信息当实测或由schema转换补故事。
- 本批完成显式类型/图/顺序升级及旧消费者基础，OL-5完整映射/采用intent/源guard/最小权限/API/页面/分节读取与OL-6继续，大纲formalAdoption仍false。完整OL-4/T1.4/阶段1未完成，用户安排后补的编辑器、法务、设计伙伴及真实文本质量不由合成协议或PG证明替代。

## Revision 10 · 完整人改大纲到正式图的映射与来源事务

继续AC-OL-1/3/4/5，不改变唯一验收语义。以实际run/candidate/review完整回放作为输入，正式化必须使用review.output；descriptor固定run/brief/source/candidate/review摘要，普通主体到正式Reviewer的映射仍由共享项目注册表授予。局部ID逐命名空间完整映射成稳定ID，人物和正式Episode复用既有对象语义，不使用名字猜身份、自由JSON封装或现造媒体。

| 文件/消费者 | Before | After / gate |
| --- | --- | --- |
| 大纲formal contracts与纯字段投影[P,L2独立文件] | v07正式类型与领域review存在，尚无完整转换 | 严格来源/identity/reviewer/draft边界、camel/snake双向完整投影；roundtrip核对人改字段/引用不丢失 |
| 根：formal mapping/data/finalize（L3） | 原开发500ops/512KiB不能承接大纲 | 独立64MiB内部输入、16MiB ChangeSet、4096ops，保留原大纲输出512KiB及旧入口全部界限；支持>1000对象，不截取列表 |
| 根：来源readForAdoption/guard（L4） | Outline只支持自有read事务 | 调用方既有client，brief→run→上游源→formal project，完整scope/digest/已人审/最新brief核验；源拒绝与硬存储故障分开，未知ACK不重执行 |
| 后续稳定ID注册表/intent/API/页面 | 原表有项目Episode槽与开发owner；完整大纲尚未接 | 同一项目槽必须共享，跨来源全局ID唯一须有实际SQL保障；不能靠新方查询旧表冒称双向唯一。完整意图及分节读取继续，不据纯mapper宣称API采用已开放 |

计划与子对象互相固定版本，采用一个内容变更时形成完整的计划修订；内容完全相同时保留原对象版本，不产生空ChangeSet。原候选/人审/方法/来源及固定引用完整带入，新增资源仅规划；保留未由该计划拥有的已采用对象与文件。旧项目需先显式升级v07，独立采用流程仍由授权人类决定。

有序gate：契约与投影窄测→完整身份集/源证据/正式图roundtrip→版本事务完整容量及重放→真实PG已审阅来源、同连接freshness、回滚/丢ACK/新pool→包类型/lint/覆盖率、代码/TS/DB/安全复审→整仓与精确提交CI。PG/覆盖率串行，源guard不调用自有read事务、不调用模型。缺失真实模型/法务/编辑器/设计伙伴仍后补；大纲formalAdoption保持false直到完整应用接线验收，完整OL-5/T1.4/阶段1不提前判完成。

### 完整容量触发的版本内核性能修复

实际512KiB内的人改输出映射为1,249操作，原内核逐操作复制整图并对全部旧对象计算签名，首次完整采用用例63,646ms，超过原30,000ms期限。保留数据、完整断言及期限；根L3追加修改`versioning/src/evaluate.ts`：add/update/replace/remove仅执行显式单对象写与原字段锁检查，其余有隐式写的move/split/merge/lock/unlock/upgrade仍保留整图比较。原候选不可变、显式base、历史ID、行锁/字段锁、最后统一版本递增及完整图校验保持。复用该失败用例为性能红例，并补完整容量第二次人改采用和无变化回放；版本包全部普通/PG覆盖率与code/TS/安全复核后方可提交。

## OL-5 完整纯映射及来源事务证据（2026-11-18）

- 新增71项普通测试与7项PG。严格捕获实际workflow保存的run/candidate/人工修改review，重放固定方法/原模型调用证据，再按各局部命名空间完整身份映射。双向逐字段核对五件套、题材配方/标志场景/抽离、情绪/付费卡点、道具状态、PlotUnit、季引擎和完整来源/简报/方法/人审谱系；不以候选正文替代人改正文。正式图使用独立有界容量，不放宽旧请求、512KiB输出或旧通用Workbench。
- 最大原输出约500,000字节，64人物/500节拍/100正式集及100集计划/256资产规划/100PlotUnit/128取舍，完整1,249操作通过原Versioning提交/采用。独立人审领域夹具的第二份审计再次经内核提交/采用，1,084子行与主计划固定版本2，人物与正式集不变；完整往返及no-op草稿、原模型exchange计数1均断言。此第二份审计是纯映射/内核测试输入，不表示允许覆写数据库已有不可变review；实际来源guard另从持久库核验固定review摘要。
- 映射保留既有角色业务metadata、独立正式对象修订、无关世界/实集/用户内容；仅清理本计划拥有的旧规划对象。跨scope/owner、身份缺失/重复/跨集合/保留ID、版本溢出、getter及finalize slot/base/opID错配均失败闭合。原正式锁仍由内核在提交/采用时执行，纯映射不创建HTTP权限或审批。首次预览遗漏派生集数导致的SCOPE拒绝由失败测试发现，修复为与内核相同的内部预览派生，不添加项目写操作。
- 实际PG7项全部使用真实Development/Bible审阅来源及完整映射，三类竞争写通过`pg_blocking_pids`证明来源锁保持到正式提交；source guard、正式project锁、adoption INSERT的backend PID及txid一致。最新大纲简报、上游开发简报、Bible文档推进均拒绝首次采用且正式行计数/状态不变。真实COMMIT后注入ACK丢失，新pool恢复原请求、完整图和唯一采用记录；过期来源的已完成重试不重复guard/行，但当前授权仍重新检查。硬证据/存储错误使用独立错误码，不进入来源拒绝的恢复分支。
- `pnpm test:versioning:local --coverage` 终态0：312项=258普通+54PG，覆盖98.08/95.94/99.47/99.84%；日志`artifacts/delivery/outline-mapping-versioning-pg.log` SHA-256=`30d36d48eddaf470be5b8a856962da9557fe7feb70d405fc4eacdd8976abddea`。`pnpm test:script:local --coverage` 终态0：1,196项=1,126普通+70PG，61文件，覆盖98.38/96.76/99.28/99.82%；日志`artifacts/delivery/outline-mapping-script-pg.log` SHA-256=`3eafccea6f4e24fad86b24cbbf3adff8fe67a7eaccded70819aead8a4a1560a5`。保持各95%门槛及串行PG/coverage。code/TS/security/DB只读复审无未闭合P0–P2。
- 当前只交付内部完整映射与实际来源事务组合，固定ID来自受信任测试宿主；持久稳定身份注册表、完整intent及低权限Outline adopter、专用认证API/页面采用、分节完整阅读及OL-6仍待实现。无SQL迁移、生产角色或现有用户schema变更，formalAdoption继续false；用户安排后补的编辑器、法务、设计伙伴及真实文本质量保持未知，不由合成协议证明替代。
- 最终`pnpm check`终态0：4,191项=20工具+4,171普通，772文件策略零问题、13包类型检查（3缓存/10执行）、13包覆盖率全部实际执行，方法6项及Agent10项基线匹配。script普通1,126项覆盖98.10/96.52/98.92/99.34%，versioning258项覆盖98.12/95.95/99.18/99.79%。日志`artifacts/delivery/outline-mapping-workspace-check.log` SHA-256=`cfa280b5fbc9b6891941266287027ae8d55bc226131bc9830210ee8f7f5720a5`。原UI/媒体及部署未改，精确提交的新镜像/四组私有流程仍以推送后的实际CI终态为准；前批`6ce53710c38cc4e09e5da658d8e9254f6132f868`的CI https://github.com/songuu/camery/actions/runs/44228698678 已实际成功。

## Revision 11 · 持久身份与共享分集槽位

继续AC-OL-3/4/5。上一批`f8a2ce4b15f6752c757365432b2ec6b3cf10c820`已推送，精确CI https://github.com/songuu/camery/actions/runs/44234539688 completed/success（2026-11-18T04:11:48Z）。本批推进正式采用所需的完整持久身份，尚不开放API或代替采用intent。

| 任务 / owner文件 | 风险 / 前置 | Before → After / 完成证据 |
| --- | --- | --- |
| 根：identity-migrate.ts、identity-migrations/0001-outline-ir-identities.sql与迁移边界测试 | L4；旧Development四迁移及Outline第一迁移先显式安装 | 独立identity_migrations账本核验全部旧摘要，显式扩展共享元信息kind与独立Outline run FK；旧迁移/账本及旧SELECT字段保持；实际SQL约束及回滚、幂等、坏摘要验证 |
| 根：outline/node/ir-identities.ts、Node导出 | L4；新迁移与已审阅同事务来源 | 受信任宿主固定target，source locks→共享项目identity锁→原子完整集合；同一项目实集ID共用，新局部身份按run/kind/local固定；8并发/新pool/丢ACK/后端终止/完整容量验证 |
| [P] identity普通协议测试及memory support（独立新文件） | L2；冻结API/SQL字段 | PostgresOutlineIrIdentities(pool,source.readForAdoption,newId).prepare({source,target})返回{identities,progress}；完整集合/损坏/跨target/分集连续对/错误脱敏/await前捕获 |
| [P] identity实际PG测试（独立新文件） | L2测试编写；根串行执行 | 已存在Development与Bible-first两个顺序、双向全局UNIQUE、Outline独立owner FK、完整容量、不修复已提交损坏、来源过期零分配、新pool及旧LOGIN继续拒绝 |

方案选择：独立新表只能保证各自表内唯一，新方查旧表不能防旧方反向碰撞；新增通用lease会要求改写旧分配路径和权限。采用同一共享身份元信息表的全局`stable_id UNIQUE`，新增`outline_owner_run_id`指向真实Outline run，旧`owner_run_id`仍只指Development。新增project kinds为adaptation_plan/outline_episode_plan，source kinds为outline_character/outline_beat/outline_asset/outline_plot_unit/outline_decision。新installer显式要求旧schema已就绪，不让旧Development迁移依赖Outline。经只读实际PG核对，需替换原kind/owner/slot三项约束：ir_identities_kind_check、ir_identities_check1、ir_identities_check2；原ir_identities_check是稳定ID/项目ID保护，保留不动。

完整性顺序：先校验旧development_plan项目anchor及连续完整episode/episode_plan对，再校验新adaptation_plan anchor与连续outline_episode_plan槽、当前run的完整局部身份集合。既有run任一组/应有尾部缺失直接STORAGE_FAILED，不能先ensure补齐掩盖损坏。新run可扩展尾部；旧Development后续扩展共享实集但没有大纲计划的尾部是合法状态。每次返回全部已分配大纲集计划槽，实集永不重新分配；局部命名空间不凭人物姓名或来源文本猜映射。新旧分配器共用原advisory key，SQL UNIQUE保护不同项目/owner间碰撞。

权限与恢复：共享表存纯身份元信息，旧adopter原有该表INSERT因此仍可写扩展kind，但旧API分配器仅能构造原kind；不因此授予其Outline来源/候选/审阅正文权限。旧append-only数据LOGIN仍无权读写身份；未来Outline adopter独立声明精确权限。所有运行构造器不安装迁移或授予权限。安装仅由显式测试/运维调用；回滚应用保留追加身份和新列，不删除或重写旧ID。迁移事务失败回滚DDL与账本，ACK丢失后重新读回原完整集合，不重分配。保留旧check、旧来源字节和用户数据；全量PG/coverage串行，code/TS/security/DB复核→整仓→显式本批commit/push→精确CI终态。完整阶段1与其余intent/API/分节读取工作继续。

### Revision 11.1 · 完整准备见证与跨分配器历史范围

实现复核补充两项必要约束。其一，当前run全部source身份消失时，空集合无法与“尚未prepare的新run”区分；新增`camery_outline.identity_preparations`，绑定run/review/target/不可变集数及完整身份摘要，与共享ID同事务提交。摘要包含原项目anchor、适配anchor、完整本run命名空间及当时简报要求的前三类集槽，不将后续合法长尾并入旧摘要。缺proof但有本run身份、或有proof但缺身份均拒绝；不另生成无业务用途的ULID。

其二，仅检查本次run的见证仍会允许新run补发已提交旧尾部。新增`node/identity-extents.ts`供新旧两个allocator共用，在原共享锁内以64行C顺序keyset分页读取历史范围：旧Development从world/character/relationship任一残留身份DISTINCT owner追溯原简报；Outline逐准备见证关联实际不可变简报及run/review元列，完整重算简报摘要并核对cached count。新旧两方在ensure前确认共享槽覆盖双方历史要求，新方另核大纲计划槽；合法Development独有长尾仍允许。仅用于身份完整性，不重取历史来源锁，不生成模型调用或审批。整组新大纲身份丢失由proof识别，旧开发历史范围以现存源身份为证，不能把空集合推断为已提交审计。

新增根L4文件责任：共同范围reader、旧allocator扩展前gate、`server/projects/adoption-role.ts`及真实LOGIN/旧数据库兼容测试。显式角色installer在身份扩展存在时追加：proof表SELECT、Outline schema USAGE、runs的7项header列、briefs的6项列（含原简报record供摘要重算）、reviews的5项header列。精确列allowlist拒额外列/整表/写权限及grant option；不授runs.record来源正文、候选或reviews.record人审正文。运行时只校验这些已由运维授予的权限，不自行GRANT。扩展未安装时保留旧角色能力；以pg_catalog存在性探测避免无Outline USAGE时名称解析报错。迁移installer改布尔存在性而非regclass显示名，支持自定义search_path；范围SQL用double precision传递已由safe-integer域验证的bigint修订号，保留超过int4的合法值。

新增gate反例覆盖：旧尾完整成组丢失后新run、跨旧分配器、旧world缺失但仍有角色、旧proof集数合法改低、旧数据库有Outline基础schema但角色无其USAGE，以及部分列越权/缺权/GRANT OPTION。Outline历史范围由proof owner与五类source identity owner的并集起查，残存owner缺proof必须报错，不允许换新run掩盖；无任何残存记录时不推断曾经提交的身份。真实迁移在独立随机测试库中先执行DDL后注入故障证明事务回滚，再真实COMMIT后丢ACK并用新pool恢复；旧九列身份及两个原账本保持不变。测试库与LOGIN仅创建及清理本测试拥有的固定前缀随机对象；不在用户现有生产项目上安装或回退schema。旧迁移SQL/摘要未改，API formalAdoption仍false，持久intent/完整采用应用与分节阅读继续。

## OL-5 持久身份验证证据（2026-11-18）

- 新增89项script普通用例（身份协议58、迁移13、历史范围18），server权限普通新增6项；28项身份PG、1项独立库迁移PG、7项实际LOGIN PG。普通夹具明确为SQL协议，真实来源/回滚/并发/权限均由实际PG另证，不互相替代。完整人改输出约500KB，64人物/500节拍/100集/256资产/100单元/128取舍通过真实PG保存、1,350条共享身份及1条见证分配、1,249操作正式采用与新pool完整回读，模型计数不增加；原45秒PG期限及512KiB输出界限保持。
- 实际8并发与新pool复用完整冻结身份；先Development后Outline、先Bible-first Outline后更长Development均保留原实集ID及旧九列行，合法扩尾/缩季不重新分配。COMMIT后注入ACK丢失恢复原集合；实际终止本测试backend全事务回滚并销毁连接。部分源身份、整组源身份、proof缺失/篡改、历史尾整组丢失后换run/换allocator、world行丢失但仍有角色、旧proof丢失但owner仍在均验证拒绝且零分配/零INSERT。SQL强制独立source owner FK、原稳定ID/项目ID保护及新旧双向全局UNIQUE；旧两个数据LOGIN仍不能读写身份或proof。
- 新SQL只通过显式`migrateOutlineIdentities`安装，两个原installer仍可重跑，旧SQL和账本摘要保持。独立随机库证明实际DDL执行后故障回滚原约束/旧行与新列/账本；真实COMMIT丢ACK后4并发新pool恢复幂等。补自定义search_path、无Outline USAGE的旧reader，以及SQL投影的bigint safe-integer兼容。首轮DDL注入用startsWith遗漏SQL首注释，导致测试未触发故障，已改includes后实际回滚通过，未放宽断言或期限。
- 新迁移目录沿用仓库根`.gitattributes`中的迁移规则，固定SQL为LF。实际`git check-attr`与`git ls-files --eol`核对后，新SQL SHA-256仍为`8bcfaea26cc755edc7a746c6b9232a7559a8de06a43a291cb5a725493e038fe3`，不因Windows检出换行改变已安装账本摘要；原SQL字节保持。
- 最终`pnpm test:script:local --coverage`终态0：1,314项=1,215普通+99PG，66文件，覆盖98.17/96.44/99.49/99.83%；日志`artifacts/delivery/outline-identities-script-pg-final-verified.log` SHA-256=`39c3a5f90afa044e47e7d86d0997c88ee4a1e0033d0e4166d1b32327b2003668`。最终`pnpm test:server:local --coverage`终态0：583项=521普通+62PG，60文件，覆盖98.20/96.39/99.75/99.91%；日志`artifacts/delivery/outline-identities-server-pg-final.log` SHA-256=`e7fa6fc49c275b7044f269d2d5ea04e227c5728c5792f414ed9bef24749c99e8`。各95%门槛与串行PG/coverage不变。
- 新旧分配器守护同一历史范围后，实际既有adopter LOGIN可复用大纲先分配的实集身份，同时不能读runs.record来源正文、candidates或reviews.record人审正文。增授敏感列/额外时间列/缺少必需列/GRANT OPTION均被真实verifier拒绝。独立旧数据库只装Outline基础schema不装身份扩展、不授Outline USAGE，实际验证原to_regclass报42501而新catalog探测、角色验证及Development prepare成功；没有为兼容旧库静默安装新表或扩大业务正文权限。
- 复审发现的跨run尾部补发、部分owner遗漏及旧角色名称解析问题均已补失败反例再修复，最终code/TS/security/DB无未闭合P0–P2。已验证范围仍为内部持久身份与完整映射，正式Outline adopter/intent/API与分节阅读未交付，formalAdoption继续false。开发测试库已显式安装身份元信息扩展，现有项目IR修订和旧ID未修改；部署新binary到已扩展库时需显式运行更新后的角色installer。回退旧binary须按本批增量撤回元信息表/列读取并用旧verifier复核，保留追加身份和新列，不逆向删除数据。
- 最终`pnpm check`终态0：4,286项=20工具+4,266普通，784文件策略零问题、13包类型检查成功（10缓存/3执行）、13包覆盖率全部实际执行。script普通1,215项覆盖97.86/96.14/99.15/99.38%，server普通521项覆盖98.29/95.77/99.48/99.74%；方法6项及Agent10项基线匹配。日志`artifacts/delivery/outline-identities-workspace-check.log` SHA-256=`d0433fbc2048648b2092adb7bc635a0db739bb390715314c2deb3d45d2d6bcf3`。PG总数包含各自普通用例，不与整仓重复相加。新镜像及四组私有流程仍以推送后精确提交CI实际终态为准；本批尚不宣称完整OL-5或阶段1完成。

## Revision 12 · 完整大纲采用意图与同事务回执

继续AC-OL-3/4/5。前批`d7b413c9241a6901b8c112fc3459cc3e705622aa`精确CI https://github.com/songuu/camery/actions/runs/44243871071 completed/success（2026-11-18T05:38:26Z）。本批将固定请求及操作ID持久化，随后接正式采用应用、独立最小权限与完整分页阅读，不因内部store交付而提前开放formalAdoption。

| 任务 / 文件owner | 风险 / 前置 | Before → After / gate |
| --- | --- | --- |
| [P] 独立outline-intent-contracts.ts与窄测 | L2；既有完整mapper与身份契约已固定 | 私有严格body/actor/source/target/draft/操作ID/receipt边界，旧generic契约不变 |
| [P] 意图SQL协议测试与memory support | L2测试；以下API/SQL字段冻结 | 实际mapper与Versioning engine、固定ID重试、完整容量、上下文拒绝、无变化/CAS与错误脱敏 |
| 根：outline-intent-data/codec/store及receipt writer | L4；依赖冻结契约 | 单份完整draft+固定change/opIDs派生原ChangeSet，不双存全部ops；保存first IDs/时间，不重复提交；回执绑定实际版本client/context/actor/scope/原请求 |
| 根：显式outline-intent-migrate与独立SQL目录/账本、PG组合 | L4；Projects原3迁移及Outline identity扩展先显式安装 | 新四表、原project/principal FK、真实identity准备见证复合FK；不改旧SQL或扩大旧接口/角色权限；实际回滚/丢ACK/并发/新pool |

接口冻结：`PostgresOutlineProjectIntents(pool)`提供findCandidate/candidateForChange/findDecision/putCandidate/putDecision/readPreparationReceipt/readDecisionReceipt/preparationReceiptWriter/decisionReceiptWriter，与既有Node使用习惯一致但独立表及命名空间。候选body保存version/scope/applicationId、user actor、target、commandDigest、source(kind=outline,mapperVersion=1,source descriptor,identities,reviewer)、expectation、changeId、完整OutlineMappingDraft与slot/id操作表；`request`仅从这些不可变字段派生，拒调用者额外存入自由request。候选业务摘要忽略新生成change/opIDs，决策业务摘要忽略重试时钟；同键变更正文/actor/target/source/base仍冲突。决策只允许user、project scope。

独立容量：私有body及receipt各32MiB，含派生request的内部envelope与SQL JSONB存储各64MiB；派生ChangeSet仍≤16MiB/4096ops，保留原512KiB大纲输出。新receipt问题/告警上限131072条，与完整内部引用预算匹配；超限显式失败并回滚，不截断，不放宽旧500条/512KiB/1MiB边界。这些是Node内部预算，后续公共接口必须分页，不能直接返回原始intent/envelope或模型配置。

原子性：有变化的准备回执、采用/拒绝回执只在VersionStore提供的同一client写入，不另开事务、连接或模型。执行context必须逐项匹配target/CAS/operation/原request signature/actor/scope/at/reason，历史已采用ACK保留真正原adoption审计。无变化不造空ChangeSet：在自身事务锁定实际正式project及读取schema/CAS，精确匹配才保存unchanged；并发base变化保存实际conflicted回执。不可变intent/receipt缺失或摘要错配不自动“补好”成新请求。

迁移选择独立显式installer和账本，避免旧Projects初始化依赖未启用的Outline域；核对Projects三个旧摘要及Outline identity扩展摘要后创建专用四表与准备见证复合authority索引/FK。新表只保存注册的ordinary scope/正式target/真实准备run/review及正式主体；运行时不迁移或GRANT。SQL目录从创建时固定LF，不改旧文件。新权限在后续明确Outline adopter gate中声明，当前不扩大既有adopter访问这些意图表。

有序gate：失败测试→契约/实际mapper/engine完整容量窄测→类型/lint→code/TS/security/DB复核→串行真实PG/coverage（原提交/采用/拒绝、receipt失败回滚、COMMIT丢ACK/新pool/撤权/CAS/无变化）→整仓→授权commit/push与精确CI。回滚服务保留追加意图/回执/身份，不删除历史或重写旧账本；当前只在测试随机scope/独立测试库安装。原五件套UI、真实文本质量及用户安排后补的验收边界保持，完整阶段1继续。

## OL-5 采用意图与回执验证证据（2026-11-18）

- 新增专用Node协议与四张表，候选仅持久化完整draft和固定ID，再推导同一份正式请求。相同业务重试保留首次change/opIDs、决策保留首次时间；同键变更业务语义冲突。存储摘要、SQL authority字段及派生请求逐项重新验证，不由普通JSON或摘要授予权限。
- 新显式installer核对既有Projects三迁移与Outline身份迁移，独立`camery_projects.outline_migrations` v1；DDL SHA-256=`0347b878b4d6c2f4e08b7ebfb4f0ef518a89f28894facbcee915e7c182f6c46a`。三个域依固定顺序加迁移锁；新候选外键绑定实际普通项目、主体和含run/review摘要及正式目标的准备见证。原账本未改，无新增GRANT，真实旧adopter LOGIN无新四表权限。
- 普通新增126项：严格协议34、实际mapper/engine/SQL协议72、显式安装器20。覆盖完整1,249个操作（body>1MiB、request>512KiB）、131,072条完整私有回执、32MiB/16MiB边界、访问器拒绝、字段/摘要损坏、故障脱敏、固定ID恢复和历史ACK。首次合法大回执触发旧Method canonical的2MiB限制，增加专用有界快照与排序序列化修复，旧通用工具和接口预算保持。
- 实际PG新增24项：八个首次并发producer只产生一份原始ID；提交/采用/拒绝三个真实COMMIT确认丢失后新pool读回原始回执；版本与回执同backend/txid，回执失败使正式变更一起回滚；完整容量来源、1,350个持久身份、1,249操作实际采用后重读一致。另由真实旧依赖制造超过500条kernel告警，准备和采用回执均完整保存并经新pool读回，未拼接伪造result。
- 无变化草稿不提交空ChangeSet，在真实正式project行锁下检查v07及精确CAS；漂移回执记录实际conflicted版本，回执失败回滚新intent；已存无变化但缺原回执时拒绝从当前head补造。错误操作者、目标租户、scope、动作、时间、理由、CAS及实际原生请求均拒绝，源guard异常/过期不缓存完成回执；撤权与历史采用审计保留原语义。
- 最终`pnpm test:server:local --coverage`终态0：733项=647普通+86 PG，64文件；语句98.08%、分支96.08%、函数99.78%、行99.85%。日志`artifacts/delivery/outline-intents-server-pg-verified.log` SHA-256=`adb2a20cead3d91a9c9e6f4a2cc5631f8c8f65ea9d6896c637eca078babf2955`。首次失败还发现测试夹具SQL CHECK先于FK、原生author误带key，分别保留CHECK反例、同步authority字段后验证真实FK，并修正author，不放宽生产校验。code/TS/security/DB复审无未闭合P0–P2。
- 最终`pnpm check`终态0：4,412项=20工具+4,392普通，797文件策略零问题；13包类型与13包覆盖率均全部实际执行、无缓存，方法6项及Agent10项基线匹配。server普通647项，覆盖98.15/95.55/99.56/99.69%。日志`artifacts/delivery/outline-intents-workspace-check.log` SHA-256=`59c7e01fb50d889a414646c379c78868185a85cd6107c65db46684603a39296b`。PG与整仓普通用例不重复相加，新镜像及私有流程以随后精确提交CI实际终态为准。
- 首次远端运行`4004920`/44250650621的整仓、来源与预算恢复均已通过；截至06:39:49Z仍在认证/server PG，距06:20:51Z作业启动已19分钟，后续镜像及四组私有流程尚未执行。为容纳新增完整容量和事务回归，将CI总作业预算由20改为30分钟；各测试自身deadline、断言、覆盖率和全部门禁保持。后续以包含此预算变更的精确提交重新验证，不将前一运行的部分通过当作完整成功。
- 此批只交付采用意图基础，认证应用的来源完整重放/角色/分页读取/API/页面接线及OL-6继续，formalAdoption保持false；不宣称完整阶段1完成。用户安排后补的编辑器、法务、设计伙伴及真实文本质量仍后补。

## Revision 13 · 认证大纲采用应用与专用权限

前批`b792fe809490f7f5c2ed343d573394bcd28c531e`完整CI https://github.com/songuu/camery/actions/runs/44253153174 completed/success（06:55:28Z）；本批继续AC-OL-3/4/5，交付可信应用、专用角色及可独立注册的HTTP模块，之后继续部署宿主、完整正式对象分节读取与UI组合，不提前开放原Outline页面的formalAdoption。

| owner / 任务 | 风险 / 前置 | 完成条件 |
| --- | --- | --- |
| [P] IR独立outline-adoption浏览器协议及测试 | L2；冻结本节接口，无Node依赖 | 严格小命令、候选目录/摘要、紧凑回执及完整消息分页，旧Workbench预算保持 |
| [P] 认证应用单测及SQL memory support | L2测试；仅新test文件 | 实际mapper/native engine，先授权后查询、错误scope/来源、输入捕获、重试与分页游标边界 |
| [P] 独立应用/专用角色PG组合测试 | L2测试；复用真实来源/意图fixture | 新LOGIN最小权限实际prepare/adopt/reject/重读、超限完整大纲、撤权/回滚/丢ACK/越权；不自行启动PG |
| 根：OutlineAdoptionApplication/options/projection/catalog/HTTP与新角色 | L4；依赖前批完整意图与源guard | 固定服务器映射与真实来源，动作回执同版本事务；认证目录和逐页完整回执、无自由request/actor/target；角色显式安装、运行仅验证，无旧角色增权 |

新公共入口`@camery/ir/outline-adoption`：prepare命令只含applicationId、五个source摘要和精确snapshot/write CAS；adopt只有CAS，reject另含reason；user actor、formal target、reviewer和project adoption scope由服务器已有身份注册表决定。应用重新校验完整人审来源与身份准备结果再mapper，不接受HTTP提供的draft、固定ID、来源正文或配置。重复application先校验当前write权限和相同command摘要，再复用原intent/receipt；采用/拒绝及历史ACK先验证当前review权限，来源guard由原生adopter同client执行，拒绝允许来源已变化。

读接口：project:read先于存储查询；目录只查有界头字段，单候选不返回完整IR/模型正文；准备回执及本人决策回执的issues/warnings分别分页，游标绑定当前主体/ordinary及formal项目/候选/种类/requestId/section/完整回执摘要与offset，换scope或损坏均拒绝；自适应字节分页保留所有消息，公共响应≤983040字节。读不分配身份、不写意图、不提交变更或调用模型。候选摘要区分当前snapshot/write与原始preparation版本，历史ACK不被刷新后的head替换。

专用adopter只读Outline/旧来源、共享身份注册元信息及原生版本数据；只对共享ID/准备proof、新四表和版本快照/审计INSERT，原生projects仅UPDATE两个counter、changes仅UPDATE(status,record)，序列仅USAGE。不能创建项目、写来源正文、人审或Access/任务/预算表；拒绝额外列权限、所有权、角色成员、GRANT OPTION和未知表权限。旧adopter权限保持。新HTTP模块仅显式可信注册，已有部署和formalAdoption能力待完整宿主/UI组合gate才启用。

目录的`COLLATE "C"` keyset范围/排序必须有同collation索引；默认locale索引不能替代。DB复审发现此缺口后，追加独立`0002-outline-candidate-catalog.sql`，按ordinary scope+formal target+change C DESC和同前缀+run_id+change C DESC建两条目录索引。原v1字节/0347b878…摘要保持，installer核验有序前缀账本后只追加缺少的v2；v2失败回滚保留已提交v1，重复不重建索引。真实PG检查索引有效性、列顺序/collation及有/无run筛选的keyset EXPLAIN，无匹配索引时不以小夹具结果分页证明查询开销有界。

Gate：失败反例→窄测/类型/lint→code/TS/security/DB复审→串行真实PG及覆盖率→整仓→本批显式commit/push与精确CI。用户脏文件保留，生产来源、真实项目及部署角色不自动迁移或授权；不把本批内部可注册模块当完整OL-5/阶段1或真人质量完成。

## OL-5 认证采用与分页验证证据（2026-11-18）

- 独立`@camery/ir/outline-adoption`为纯浏览器协议，实际ESM打包无Node依赖；35项严格命令/摘要/分页schema测试通过。HTTP仅接受applicationId、真实来源五摘要及CAS，操作者、审阅者、正式target、project采用scope、完整draft及固定ID均由可信应用产生。新模块仅在`AccessOptions.outlineAdoption`显式提供时注册；现有部署宿主和页面能力仍关闭，后续继续部署与完整正式对象分节读取/UI组合。
- 应用新增62项实际mapper/native engine单测，未知提交异常与commit后ACK丢失的失败反例已闭合：公共边界保留已知安全错误码，未知异常及opaque proxy不泄露依赖诊断，重试复用原ID/时间及回执；旧共享installer的opaque prototype异常由新role边界安全处理。角色30项与目录17项普通用例、迁移新增10项均通过；迁移原20项保留，已安装v1仅追加v2，v2故障回滚原已提交v1。
- 新增18项实际PG测试。新独立LOGIN从新run实际分配shared IDs/proof，再准备、采用、无变化确认、来源变化后拒绝和新pool恢复；写来源/注册主体/Access/旧意图/额外原生列/创建表均被真实SQL拒绝，额外表/列/GRANT OPTION/成员身份/缺proof权限被verifier拒绝。旧adopter保持独立，无新表授权。真实8并发保留首次IDs，intent/submit/adopt的真实COMMIT后丢ACK由新pool恢复，准备/决策回执失败回滚正式写入，撤权在历史ACK lookup前拒绝。
- 实际HTTP完成1,249操作完整容量大纲采用并新pool逐字段roundtrip；由真实旧依赖产生超过500条native告警，准备和决策回执经HTTP全部逐页读回、无丢失/重复或额外模型调用。跨用户、section、request游标拒绝，错误自由actor/target/draft/request、重复headers和越界body/query拒绝。所有读目录/消息/候选均不分配身份、不改正式版本或意图。
- 目录索引复审P2通过追加v2闭合：v1 SHA-256仍`0347b878b4d6c2f4e08b7ebfb4f0ef518a89f28894facbcee915e7c182f6c46a`；v2 SHA-256=`106f247f082c942041a33187b608684d47c672b30313c322c06885a643ebdaa1`。实际检查btree ready/valid、完整key列、C collation与DESC，专用测试事务`SET LOCAL enable_seqscan=off`下，project/run两种header keyset EXPLAIN分别使用匹配索引且无Sort，证明所需访问路径可用；重复安装账本不变。code/TS/security/DB复审无未闭合P0–P2。
- 封套边界补强前的完整`pnpm test:server:local --coverage`终态0：870项=766普通+104 PG，68文件；覆盖97.59/95.31/99.81/99.86%。日志`artifacts/delivery/outline-adoption-server-pg-verified.log` SHA-256=`04872d1209bb8cfd89f1ad971542ab8f871f446230cf208f96ead116b5e2bf3e`。首轮在新增v2失败反例时明确失败1项，其余859项通过；随后补齐v2 installer与完整prefix测试并整轮重跑，未放宽既有迁移或测试门槛。
- 普通HTTP补充35项真实Nest/Fastify边界测试，仅替换应用依赖，不替换路由或guard。覆盖六路dispatch、撤权/未登录/跨项目/角色、严格DTO/query/幂等键、16KiB body、响应投影及安全错误映射。新增真实失败反例证明只预算data不够：合法data983020字节时旧完整wire983080字节超限；真实分页data983036时封套983096超限。改为校验整个HTTP封套983040，生产分页预留256字节并按实际items推进游标，逐页保持全部完整消息。普通覆盖率不足通过补独立风险反例闭合，95%门槛保持；最终整仓及更新后PG结果随后记录。
- 应用普通用例最终72项：补充opaque依赖异常、错误读绑定、错候选地址、NoChange缺原回执、封套预算和遗漏writer的实际引擎反例。遗漏writer时原生状态确实改变，应用必须安全失败而不误报成功；采用可按原生历史重放恢复回执，拒绝仍受原CAS约束，不伪造回滚或放宽版本检查。
- 最终`pnpm check`终态0：4,611项=20工具+4,591普通，814文件策略零问题；13包类型检查成功（12缓存/1执行）、13包覆盖率全部实际执行。server普通811项覆盖97.85/95.02/99.61/99.72%，IR普通521项；方法6项和Agent10项黄金基线匹配。日志`artifacts/delivery/outline-adoption-workspace-check-complete.log` SHA-256=`e58e6ed229de59a23f677ccd2b6b91d8a78862fc288905217f3e3cb8b752c139`。前几轮普通覆盖率不足记录保留，最终通过不依赖修改95%门槛。
- 最终封套修复后`pnpm test:server:local --coverage`终态0：915项=811普通+104 PG，69文件，覆盖97.79/95.53/99.81/99.86%。日志`artifacts/delivery/outline-adoption-server-pg-final.log` SHA-256=`c0b008dd7cf2b4014cbe9189e344e1c83aeb418a7b790eec74af2191044b46e4`。与整仓普通用例不重复相加；完整镜像和私有组合流程仍以随后精确提交CI终态为准。此批未部署生产配置、未启用formalAdoption，完整OL-5/OL-6与阶段1继续。

## Revision 14 · 正式大纲完整分节读取与配置型宿主

前批`e5c80c9781f10e91bb18edd2bec2926690d35fd8`完整CI https://github.com/songuu/camery/actions/runs/44261552493 completed/success（08:11:46Z）。继续AC-OL-4/5；本批完成新六类正式规划对象的完整分节读取和独立adopter宿主，之后接五件套页面及OL-6组合，旧Workbench单行与公共预算不扩大。

| owner / 任务 | 风险 / 完成条件 |
| --- | --- |
| [P] IR outline-formal浏览器契约/分节定义与测试 | L2；overview+22种typed数组section完全覆盖新六类对象全部字段，拒自由JSON path，无Node依赖；大行逐页可按原schema重组 |
| [P] reader/application/store协议测试与support | L2测试；实际完整mapper/原生采用夹具，鉴权先于所有读；同snapshot完整重组、翻页中新head推进/旧快照、游标隔离/损坏/字节边界，读零分配/零写/零模型 |
| [P] host配置/runtime单测与真实PG/构建后宿主组合 | L2测试；只新文件，先红测；默认关闭/半配置拒绝、secret有界且await前捕获、实际LOGIN、完整容量读取、新pool与新head、真实built main启停；PG/coverage由根串行 |
| 根：formal read store/projection/application/HTTP、host config/runtime/main | L4；原生snapshot单statement绑定scope/package/revision与current counters；精确schema/图验证，历史只读；宿主只验证独立reader/adopter LOGIN，不安装/GRANT/建项目/模型/worker |

只读边界：新`@camery/ir/outline-formal`协议覆盖adaptation_plans、outline_beats、outline_episode_plans、asset_plans、outline_plot_units、outline_adaptation_decisions；关联实人物/实集仍用现有typed正式对象读口。列表按collection/id固定顺序返回ref/plan_ref，不发送整行；对象overview保留全部非分节字段；分节将来源references、配方signature_scenes/failure_modes/ablations、六组成员、季引擎characters/plot_units、审阅emotion_curve/issues/ablations/waivers、beats/prop_states等22组数组完整分页，数组项直接复用正式Zod类型。空数组仍有count=0描述，不丢键或字段；不使用文本截断/省略或自由JSON/任意路径。

另提供独立bulk rows分页：小对象完整typed record按最多50条与同一字节预算批量读取，单个大对象整行仍超限时返回带overview/全部section描述的sectioned标记，再完整读取其数组。metadata目录保持轻量；rows游标与目录kind隔离。完整容量HTTP验收遍历全部1,085个新规划对象并逐字段比对，不用六个代表对象替代全量，也不要求每个小对象单独重载整个snapshot。

`revision`可显式选择已采用的不可变snapshot，首次省略即选择当前head；游标携带所选revision，后续页面读同snapshot，即使有新head也保持原数据。响应同时标selected snapshotRevision与当前headRevision/writeVersion，授权每页重新验证。游标绑定subject、ordinary/formal项目、collection/plan或object/section及实际object版本；改变selector或显式revision与cursor不一致拒绝。不存在snapshot/对象报NOT_FOUND，旧v05/v06在专用新六类口显式SCHEMA_UPGRADE_REQUIRED，损坏或不一致的原生数据安全失败。data预留封套256字节，完整HTTP响应≤983040；所有数组页保留完整项及准确next offset。

宿主：追加`CAMERY_OUTLINE_ADOPTION_ENABLED`与独立`CAMERY_OUTLINE_ADOPTION_DATABASE_URL_FILE`，拒直接凭据和关闭时残留配置。启用需既有Projects和Outline配置、同tenant/实际数据库authority且独立LOGIN；复用Projects reader凭据，新adopter按前批严格profile验证。URL身份/路由不允许query覆盖（已核对本仓pg-connection-string解析器query可覆盖host/user），只支持明确TLS/连接选项；runtime再次验证，不信任只经过外部config的假设。启动前捕获配置，故障关闭全部已拥有pool，退出幂等；main显式接adoption+formal read模块，不改已安装schema、角色、正式项目或调用模型。旧Outline页面formalAdoption能力在UI组合gate前保持false。

Gate：失败反例→窄测/types/lint→code/TS/security/DB复审→串行真实PG/coverage与built main→整仓→本批显式commit/push及精确CI。生产角色与来源不自动改动；用户五份脏文档及不相关文件保留。真实文本质量、编辑器、法务、设计伙伴依原安排后补，完整T1.4/阶段1继续。

## OL-5 完整正式读取与宿主验证证据（2026-11-18）

- 浏览器 `@camery/ir/outline-formal` 新增50项严格协议测试；22种分节保留实际元素判别类型，overview只移除明确分节数组，所有新六类对象可按原schema完整重组。实际浏览器ESM构建无Node依赖。配置/secret增长/运行时34项普通测试验证默认关闭、URL路由覆盖拒绝、await前捕获和故障释放；安装说明见 `deploy/outline-adoption.md`。
- Code复审发现并通过失败反例闭合整包误用每图16MiB预算：合法legacy prop.description为16,777,217字节时，新读取器仍可读取其合法大纲。独立快照捕获64MiB，每图16MiB约束继续由完整图验证实施；损坏driver rows不被当成项目缺失，未知异常不泄露内部凭据。
- 真实完整容量首次触及45秒期限。去除已捕获快照的重复复制，bulk大首行只做一次sectioned退化判定，保留全部1085行、2048来源引用、22节及原期限；`validateOutlineGraph.scope` 用每次调用的ID→版本集合替代重复线性查找，重复引用、精确版本及错误顺序保持。IR全部571项通过，真实PG定向4项终态0、合计32.98秒；不以纯内存基准替代真实PG验收。
- 既有目录索引两行夹具出现actor index→Sort的合法成本选择。验证有序访问路径的测试事务追加 `SET LOCAL enable_sort=off`，保留原完整索引元数据、精确project/run索引名及无Sort断言；定向复验通过。生产SQL、两个索引、迁移字节和checksum均不变；该测试证明路径可用，不承诺默认成本规划必选该索引。
- 正式读取/存储/HTTP新增119项普通测试（59应用及分页、28存储、32HTTP），包括授权先于所有读、撤权/跨scope、合法空集合、超大单行/批量收缩后无丢失续读、完整封套983040字节、伪造版本/末尾offset及损坏依赖安全失败。没有改动95%覆盖率门槛；首次普通分支94.48%的失败记录保留，新增15项风险反例后通过。Code/TS/security/DB复审无未闭合P0–P2。
- 最终 `pnpm check` 终态0：4,814项=20工具+4,794普通，835文件策略零问题；13包类型成功（12缓存/1执行）、13包覆盖率全部实际执行，方法6项和Agent10项黄金基线匹配。Server普通964项，覆盖97.85/95.15/99.48/99.68%；IR571项。日志 `artifacts/delivery/outline-formal-workspace-check-final.log` SHA-256=`17a89b3b54d638c9677590429ce319201f302cb6193aac2587723f36a5db7382`。
- 最终 `pnpm test:server:local --coverage` 终态0：1,072项=964普通+108PG，76文件，覆盖97.8/95.64/99.66/99.81%。新实际PG四项包含全部1085行逐字段重建、2048来源引用和22节完整HTTP、读前后零写/零模型/零分配、新pool恢复历史cursor、相同project跨formal tenant及旧/损坏快照、真实built main默认关闭/启用/错误角色与退出。日志 `artifacts/delivery/outline-formal-server-pg-final.log` SHA-256=`43b99eb17366343107e06d211973c2ea1b35df47eab1aed6e4e3474f996293ea`。PG普通项与整仓不重复相加；全部镜像/私有组合及精确提交CI在推送后核对，不把启动当终态成功。完整五件套页面/OL-6及阶段1继续，formalAdoption保持false，用户安排后补项不变。

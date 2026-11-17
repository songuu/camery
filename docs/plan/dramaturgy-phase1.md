# 阶段 1：T1.4 剧作大纲与方法资产

Revision 6 · 2026-11-17。依据 `implementation_plan_v2.md`、`solution_v2.md` 的当前 v2.1 要求继续实施。编辑器验收、法务签核、设计伙伴确认后补；它们不阻塞独立工程任务。当前不是 T1.4 或阶段 1 完成声明。

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
| OL-2 固定方法、来源适配、生成收据、人工审阅 | script outline runtime / methods / bible 的明确接口；依赖 OL-1 | L3 | AC-OL-3；库级及实际旧来源读口组合已验证，生产持久宿主/API仍属后续任务 |
| OL-3 数据库、恢复与预算 | script node / migrations / PostgreSQL 测试；依赖 OL-2 | L4 | AC-OL-4；核心存储/预算/恢复已验证；常驻宿主及认证服务组合仍待 OL-4/6 |
| OL-4 鉴权 API 和编辑审阅页面 | script transport/read models、server / web；依赖 OL-3 | L4 | AC-OL-3/4/5；先浏览器契约/列表/状态投影，再认证服务/常驻宿主/页面/实际验收，实施中 |
| OL-5 正式 IR 升级、映射与采用 | ir / versioning / projects；依赖 OL-2/3，稳定契约后冻结迁移设计 | L4 | AC-OL-5；待做 |
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

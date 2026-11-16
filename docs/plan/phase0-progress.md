# 阶段 0 开发进展

更新日期：2026-11-16。依据：[实施计划 v2.1](implementation_plan_v2.md)。目标保持为阶段 0 地基建设，**阶段 0 尚未完成**。

## 任务状态

| 任务 | 当前状态 | 证据与剩余工作 |
|---|---|---|
| T0.1 工程与 CI | 进行中；当前镜像与本地检查通过 | Git/pnpm/Turborepo、严格TS、95%门槛、Oxlint/source-policy及任务图缓存已有证据。2026-11-16 npm元数据完整取回，当前冻结锁文件镜像构建成功，同一新digest的API/固定章节worker两项真实Compose验收通过，见[镜像与输入记录](../validation/phase0-image-2026-11-16.md)。先前镜像读取阻塞已解除，旧镜像保留；远端CI与后续发行验收仍待各自证据 |
| T0.2 ADR 001–019 | 设计记录完成 | [19 项 ADR 与索引](../adr/README.md) 已按既定计划落盘并检查链接；决策确认不等于功能实施/外部格式或法规验证完成 |
| T0.3 IR v0.5 | 指定契约与本地验收完成 | [Zod/JSON Schema、ShotTake 多对多/版本/有理数、四种声音、PlotUnit/快照及质量档](../../packages/ir/README.md)已有契约与正反测试；[两个真实 v0.3 样例迁移](../../packages/ir/MIGRATION.md)、[旧规则去向及有界差分审计](../../packages/ir/LEGACY-RULES.md)已落地。预留锚点/机位字段仅结构检查，完整实体按阶段 2、导入 UI 按 T1.1 实施；不承诺任意旧包的全部 schema 约束等价 |
| T0.4 时间线代数 | 库与本地验收完成 | [timeline](../../packages/timeline/README.md)：精确有理数、顺序键、按集/版本推算、端点 DAG、音轨/淡出/范围检查与不可变拆并插移；编辑和独立时间模型各 10k 生成场景。已接入 IR；T0.5 已实现拆并引用联动的纯域计算 |
| T0.5 版本核心 | 纯域及 PostgreSQL 本地验收完成 | [versioning](../../packages/versioning/README.md)：候选、对象冲突、锁、采用/拒绝、历史与拆并联动已落地；[事务/CAS](../../packages/versioning/POSTGRES.md)已用真实数据库验证。认证/RBAC 骨架已另实现，采用/拒绝应用服务与 HTTP 绑定仍待接入 |
| T0.6 持久化执行 | 执行核心及本地故障验收完成 | [durable](../../packages/durable/README.md)：PostgreSQL 步骤日志、租约/fence、重试、定时、闸门、取消与对账已实现；实际杀 worker 并重启恢复已验证，版本域事务/CAS 现已接入。常驻服务编排和生产运行条件待宿主/发行任务完成 |
| T0.7 模型模式连接器 | ComfyUI真实出图/回放通过，其他服务待配 | 注册表、编译、HTTP/WS及三类连接器已有本地证据。2026-11-16用现有Camery连接器在ComfyUI 0.44.2、RTX 5070 Ti上完成[Z-Image-Turbo真实1024×1024出图](../validation/comfy-zimage-live-2026-11-16.md)，仅提交1次；产物下载、完整PNG解码和29条HTTP交换的独立离线回放通过。分体模型与三组件摘要已核对；其他LLM/中转服务真实冒烟、生产归档和更多模式仍待验收 |
| T0.8 方法包及评测 | 指定框架、运行器与黄金集本地验收完成 | [methods](../../packages/methods/README.md)：不可变版本、受限加载、结构化候选、独立 LLM 评分、显式人工表单、四类断言和回退门禁已实现；[章节黄金包](../../method-packs/chapter-segmentation/README.md) 含三类素材和六例。真实模型质量与完整人工抽检产品流程按后续任务验收，不增列为T0.8的隐含条件 |
| T0.9 Agent 运行时 | 核心库及本地回放/数据库/章节 worker 验收完成 | [agents](../../packages/agents/README.md)：角色/权限、[预算](../../packages/agents/POSTGRES.md)、[协作/审查/outbox](../../packages/agents/COLLABORATION.md)、[宿主](../../packages/agents/HOST.md)、[行为基线](../../packages/agents/EVALUATIONS.md)和[追踪](../../packages/agents/OBSERVABILITY.md)已验证；[实际章节 worker](../../packages/server/README.md)以独立身份预留预算、等待人工、正常停止/强杀后新进程恢复。认证业务服务、多树进程管理仍待接入，完整制片角色按阶段 1 实施 |
| T0.10 认证/RBAC | 骨架与本地验收完成 | [access](../../packages/access/README.md) 和 [NestJS/Fastify API](../../packages/server/README.md)：可撤销哈希令牌、逐请求项目角色、固定部署租户及默认拒绝已验证。真实独立最小权限 LOGIN 和实际容器认证通过；完整登录/用户管理、业务服务接入及发行部署待后续验收 |
| T0.11 合规核实 | 指南及分类金额公开依据已补，待签核 | [原文核对包](../compliance/phase0-source-review.md)已取回部门说明/官方转载，区分真人100/300万与AI30/80万，不套统一旧阈值；分类提示正式原件/项目适用性仍待确认。[四份正式元数据指南](../compliance/metadata-guides-2026-11-16.md)已定位承载结构，写入器及真实保留链路未验收；法务/产品和真实项目授权仍缺，没有激活新规则 |
| T0.12 设计伙伴 | 访谈/确认模板已备，待真实外部协作 | [按产品方案第10章五项假设建立访谈包](../validation/design-partner-kit.md)，含中性问题、匿名记录、参与确认及样例授权核对；实际访谈/确认/授权样例均0，至少2家参与证据仍缺。未联系任何人，未将准备模板计为招募完成 |
| T0.13 交付格式验证 | 夹具通过，编辑器步骤由用户稍后处理 | [准备记录](../delivery/phase0-readiness.md)及[验收记录](../delivery/phase0-import-report.md)：25fps三段剪辑与独立音频已生成。2026-11-16 Resolve 21 PUBLIC BETA实际启动至项目管理器，新建按钮遇桌面工具坐标越界后失去窗口，日志记正常退出；用户选择稍后手动打开独立项目。尚未导入，剪映/PR亦待实际版本；不能以启动或文本结构通过替代验收 |

## 当前代码与验证

- 2026-11-16当前冻结锁文件应用镜像构建与同镜像API/worker Compose各1项通过；原数据库仍健康，临时容器已清理。随后整仓检查重新通过，见[六项退出条件、输入快照与本轮检查](../validation/phase0-exit-audit-2026-11-16.md)及[本轮镜像验收](../validation/phase0-image-2026-11-16.md)。远端全部Actions运行集合返回0条，不能认定CI全绿；累计不同测试仍1711。

- [IR 契约及限制](../../packages/ir/README.md)：实际源码、测试和生成 JSON Schema 均已落盘。
- 2026-11-16 `pnpm check` 各环节通过：source-policy 316个文件零问题、Oxlint通过；九包类型检查通过，5项命中缓存、4项实际执行。工具20、timeline118、IR365、versioning165、durable67、model-modes223、methods168、agents324、access26、server53，共1529项测试，9个覆盖率任务全部实际执行而非缓存重放；6个章节黄金案例与10个Agent基线也实际执行。普通pnpm test本轮未另跑。IR四项99.28% / 98.63% / 99.25% / 100%，其余包均满足≥95%。完整数据库专项沿用前轮；不把类型检查缓存日志当作数据库或容器重新执行证据。累计不同测试1711，覆盖率明细及快照见本轮退出核对，逐轮历史证据见下方。
- 代码审查发现的音频悬空、关键帧就绪、取用来源、口型语义、快照归属、替代覆盖及文件路径竞态均补了回归测试；最后复审确认原发现关闭。
- `pnpm schema:generate` 需通过包过滤运行：`pnpm --filter @camery/ir schema:generate`。生成物一致性由测试检查。
- 现有研究文件保持原位；2026-11-16用户已授权提交并推送，当前优先完成远端CI，结果以匹配提交的Actions记录为准。编辑器验收、法务签核和设计伙伴确认由用户安排后补；不据此将阶段0判为完成。用户的其他未跟踪改动不纳入清理。

## T0.4 与 ADR 本轮证据

- timeline 编辑生成测试运行 10,000 组插入→移动→拆分→合并场景，核对身份、业务字段、顺序、计划/测量时长和输入不变。
- 另 10,000 组时间求解用独立整数毫秒参考模型核对双集、双版本、随机镜头/声音顺序及实际时长；5,000 cue 长链证明不使用递归依赖展开。
- 精确数值导出先复现中点舍入缺陷，再实现二进制中点取偶；审查方额外用 9,997 个有限非零 double 往返验证，未见失败。
- IR 新增锚点循环、重叠、淡出、范围、节拍锚点及跨集伪覆盖回归。跨集伪覆盖先复现交付错误放行，再同时修公共求解、IR 归属和交付覆盖过滤，最终复审确认关闭。
- ADR-001–019 每项都有既定选择、代价/边界、实施证明条件与任务引用；不将剪映可用性、法规或模型连接器写成已经验证。

## T0.5 与真实样例迁移证据

- 版本域库保持候选与正式 head 分离，采用时重新检查对象基版本、作用域和锁；追加对象版本链、删除记录和采用记录。同一 ChangeSet 的所有操作及引用联动作为一次纯域计算完成，失败不产生部分 head。
- 拆并联动关键帧、声音锚点、取用和 lineage；预览分配的身份在采用时保持一致，依赖变化要求重新提交。当前及历史内容身份和嵌套位置身份不能复用。
- 锁所有者冒认、锁自环、历史嵌套身份复用、拆并区间舍入成零和拒绝候选时绕过作用域等审查发现均补了回归测试，独立代码/安全复审确认关闭。拒绝作用域使用提交时的历史对象归属，不能因另一候选实现相同结果或删除对象而绕过。
- 两个原始 v0.3 样例均通过原 Python 校验器；真实迁移的 88 个测试覆盖显式语义选择、完整审计、确定性、生成物一致性及逐版本/集/镜头/cue 时间核对。迁移保留 candidate、未知授权和交付/发布阻塞，不虚构素材就绪、事实验证或 ShotTake。
- 迁移审查发现的场次排序改变秒点、音频尾静音丢失和小数端点误差均先复现再修复，并经独立复审。两个样例迁移通过不代表全量旧规则已迁完。

## T0.6 本轮执行核心证据

- 使用已核实版本的 `pg 8.23.1` 与 `drizzle-orm 0.45.4`；固定 `camery_durable` schema 的迁移显式执行，以事务级 advisory lock、版本/checksum 保护重复迁移和历史一致性。任务/步骤/信号复合身份包含租户；所有状态转换优先锁任务行，领取使用 `FOR UPDATE SKIP LOCKED`。
- 租约依赖数据库时间与单调 fence，旧 worker 不能续活过期租约或提交迟到结果。已完成步骤读取持久化结果；工作流版本、输入、步骤身份/顺序改变会拒绝。正常定时/闸门恢复不消耗失败预算，异常和崩溃受自动重试上限约束。
- 真实子进程测试实际强制终止 worker，再启动另一个 worker：已完成的外部步骤没有再次执行；中断中的外部步骤转为 unknown/reconciling，明确对账后才继续。取消撤销租约并保留未知外部结果，对账不会复活已取消任务。
- `pnpm test:durable:local --coverage` 已通过 78 个测试：51 个单元测试、20 个存储测试、7 个运行时数据库/进程测试。全持久化源码覆盖率：语句 98.23%、分支 97.68%、函数 97.72%、行 99.67%。该命令包含单元测试，不能与根检查重复相加。
- 审查发现的外部步骤错误标记绕过对账、对账理由被后续重试清除、超时后才完成准备仍启动远端调用、漏 await 导致未处理拒绝，以及忽略非法操作后误报成功等问题均有先失败再修复的回归。数据库和运行时独立复审核对关闭；内部库未实现会话/RBAC/RLS，不视为产品授权验收。
- CI 新增 PostgreSQL 16 服务和必跑集成/故障测试；本机集成检查通过不代表远端 workflow 已成功。集成测试无测试 URL 时明确失败，不跳过；无数据库的 `pnpm check` 不计算存储/迁移覆盖率。
- 执行核心落地时，`pnpm audit --prod --audit-level high` 返回 `No known vulnerabilities found`；结论限于当次公开漏洞库和生产依赖图，不替代代码安全审查。当时检查合计 671 个不同测试，当前总数见下方版本域记录。

## 版本域 PostgreSQL 本轮证据

- 独立 `@camery/versioning/node` 入口不改变根纯域 API；PostgreSQL 正式快照、候选决定、对象历史/删除记录和采用记录分表保存，复合主外键包含租户与项目。项目行锁内加载最新状态并调用现有内核，最后以 head 修订和 writeVersion 做 CAS。
- `pnpm test:versioning:local --coverage` 通过 187 个测试（165 个纯域 + 22 个新增数据库集成/迁移验收测试），全版本包语句 98.85%、分支 97.08%、函数 99.31%、行 99.81%；Node 适配器语句 99.28%、分支 98.59%、函数/行 100%。迁移实际执行并验证可重复运行；未知/篡改历史的拒绝分支另用隔离模拟连接验证。
- 同对象并发仅一个采用成功，另一候选记录冲突；不同对象并发重放到最新 head，无丢失修改。同租户/项目下重复初始化、候选和采用幂等；不同租户即使项目/内容 ID 完全相同也保持隔离。
- PostgreSQL 故障触发器分别令采用记录、最终项目写入失败，以及使候选/CAS 写入返回零行；每种失败后同时核对完整状态和各表记录数，确认候选、快照、对象历史和采用记录一起回滚，没有返回未提交成功。
- 真实数据库测试还覆盖冻结输入/授权元数据捕获、授权失败不写入、删除身份保留、拆并取用及关键帧/cue 引用、预览身份复用、数值溢出及损坏正式快照拒绝。独立 TypeScript、数据库与安全审查未发现新增高置信度缺陷；不据此认定正式会话/RBAC/RLS 已实现。
- 最终代码复审发现误传异步授权时，拒绝结果的 Promise 会成为未处理拒绝；纯域及 Node 入口均先复现再修复。共享授权函数只接受同步 true，观察其他异步返回的拒绝且不授权；fulfilled/rejected Promise 回归均通过，复审确认关闭。
- CI 增加版本域数据库验收；本机统一 PostgreSQL 启动脚本后，原 durable 的 78 个测试及全源码覆盖率再次通过。当前累计 695 个不同测试：根检查 646 + durable 额外 27 + versioning 额外 22，已扣除集成命令重复执行的单元测试。另在无原 node_modules 的隔离副本以冻结锁文件离线安装全部依赖，并完成版本包类型检查，未依赖当前工作区的旧依赖链接。
- 大项目性能未验收：对象历史仍逐行 INSERT，项目锁期间有多次数据库往返；后续服务接入前需批量写入与压测。迁移/运行最小权限、备份恢复、认证和客户端读权限过滤仍待完成。

## T0.7 本轮模型模式证据

- 注册表严格验证模式与来源/适用版本/验证状态/评测引用，相同模式版本不可换内容；已入队 pin 保持原摘要。编译器按 anchor/keyframe/video/text recipe 选择字段、排序参考并检查已声明能力，未知能力不冒充已支持；软/硬提示限制区分，缺 tokenizer 不估算 token 数。
- OpenAI 兼容连接器单次结构化调用，修复须显式再发一次并更换调用身份，无隐藏重试。ComfyUI 以模板参数映射、/prompt、/history、/queue、/view 实现提交/状态/字节下载，WebSocket 会话提供进度、有限重连和 HTTP 兜底；成功事件仍需查历史。fal 使用固定配置的提交/查询路径，不跟随返回 URL，COMPLETED 不直接当作远端成功。
- HTTP 连接固定受信租户/连接/基础 URL，检查并固定 DNS 地址；内网和 HTTP 分别只接受字面量 true，字符串配置拒绝。无重定向/自动重试；凭据只在传输层解析，超时包括 DNS 与凭据阶段。提交发出后的异常保持 unknown，不盲目重提。
- `model-modes` 223 个测试全部通过；包语句 98.39%、分支 95.99%、函数 98.26%、行 99.66%，覆盖全部源码并通过四项 ≥95% 门槛。组合测试实际使用回环 HTTP 协议服务运行三个连接器，录制 [合成 cassette](../../packages/model-modes/test/fixtures/providers.synthetic.json)，关闭服务后完成相同 pin/调用身份的离线回放，无网络 fallback。
- 安全审查复现的响应头/JSON 属性名回显凭据、非布尔网络配置被当作开启，以及录制失败错误标记为 not_sent，均有先失败再修复的回归。代码、TypeScript 与安全复审检查本地实现；不将合成协议响应当作真实供应商录制或 GPU 出图证明。
- 截至该轮已验证范围累计 1015 个不同测试（含最初 T0.8）：当轮根检查 966 + 先前未变更数据库专项 49，已扣除集成命令重复执行的单元测试。最新测试数见文首及下方生成/评分记录。真实端点、凭据、工作流和具体模式限制由用户后续补充；暂不调用外部付费服务，不把缺少配置变成虚构验收。

下一项重点：推进阶段0明确列出的合规原文核实、授权台账和交付格式可行性验收，真实节点与设计伙伴需各自外部证据；远端CI按仓库实际连接状态补证。T0.10认证/RBAC骨架已有本地证据；完整业务端点按相应模块接入。完整制片角色属于阶段1，锚点/导演实体属于阶段2，不能把后续产品实体与导入UI扩为阶段0的隐含必做项。真实模型质量/账单核实、人工审片、自动对账与媒体验证仍须各自验收，不将本地库验收替代阶段0整体验收。

## ComfyUI WebSocket 本轮证据

- HTTP 与 WebSocket 共用作用域、相对路径、网络开关、DNS 检查/固定及凭据解析策略。WS 不跟随 upgrade 重定向；限制会话/握手时间、连接数、帧大小、缓冲字节/消息和总消息数。二进制预览不当作进度或生成结果，实际凭据回显明确拒绝。
- 监听已有 prompt，保留原提交 clientId；初始、周期、终态提示与断线时查询 HTTP，有限重连后继续 HTTP 兜底。只从 HTTP 查询确认终态，不重新提交、不调用全局 interrupt，不把本地监听超时当作远端任务失败。
- 实际回环 HTTP/WebSocket 组合测试断开首个连接，以同一 clientId 重连并通过历史读取结果；核对请求只有已有任务的 history/queue 查询。安静流仅保留一个 next()，非合作传输清理不拖住监听，异步回调也受总时限并观察迟到拒绝。
- 自检先复现再修复远端关闭后取消仍可读取缓冲进度，以及监听拒绝提交阶段允许的中文/空格 clientId；两项新增回归通过。根 `pnpm check` 最新通过 966 个测试、六包类型检查、全部覆盖率门槛和六个章节黄金用例；本轮没有重跑未变更的数据库专项。
- 先前独立复审/自动审批服务的 403 已恢复。独立安全复审先复现 JSON Unicode 转义的凭据可穿透进度解码，再补充解码后字符串/属性名检查；大数组遍历不使用 spread，避免事件回调栈溢出。27 个 WS 定向测试通过，复审关闭发现。`pnpm audit --prod --audit-level high` 已补跑，返回 No known vulnerabilities found；限当次生产依赖公开漏洞库。
- 最新本地提交仍是 `1fdb5a8 feat: add phase 0 core foundations`；此后的版本域 PostgreSQL、模型模式与方法包实现留在工作区，未再次提交、未推送。真实 GPU/供应商验收等待用户后续补充配置。

## T0.8 方法包与章节黄金集本轮证据

- 新增 `@camery/methods`，受信注册表锁定 manifest、来源、方法正文、规则、样例、卡片及全部评测资产。重复版本换内容拒绝；仅按显式 pin 路由，歧义拒绝。运行器捕获输入/作用域/版本，工具只由宿主注册；输出通过 schema 与规则后仅返回候选。
- JSON Schema 支持明确子集，不远取 schema 或执行包脚本。独立复审先复现 enum 绕过 type/范围和误拒对象/数组，再以结构约束与递归深 JSON enum 相等检查相交修复，包含嵌套回归。取消/总超时观察迟到拒绝；付费请求未知结果保留 unknown，不自动重试。
- `loadMethodPack` 读取严格 JSON 子集的 pack.yaml 与声明资产，每文件 1MiB／总计 2MiB；拒路径逃逸、非法 UTF-8、重复 JSON 键、symlink/junction，核对同句柄身份及读取快照。动态增长、身份变化和字节上限均有故障注入回归；不把这些检查当作 OS 沙箱。
- 评测分别记录过程、内容、结构和质量。缺失人工/模型评分保持 unscored，不能通过闸门。报告含产物/工具轨迹/评分，门禁依据受信 pin 重算断言；伪造 passed 摘要、错配源摘要、旧包配候选报告及伪套件归属均明确拒绝。真实 trace/review 仍由宿主提供，不声称远程签名鉴真。
- [章节黄金包](../../method-packs/chapter-segmentation/README.md) 包含《老殘遊記》《西遊記》开头短节选、自写三集素材，以及 CRLF、BOM、无显式标题变体。固定来源版本与许可、实际输入和独立标题/边界 oracle 已落盘；六例只证明当前章节方法，不冒充整部小说、长文本、LLM 艺术评分或人工审片。
- `pnpm test:methods:evals` 已纳入根 `pnpm check`，默认只比较固定基线，变更套件或超过阈值时阻止通过。基线读写复用有界身份检查；显式更新使用独占临时文件、完整写入、fsync 与 rename，拒链接，失败保留旧文件及 hardlink 别名。真实 CLI 同内容替换后 SHA-256 不变，默认比较再次通过。
- 原位方法包类型检查、97 个测试通过，覆盖率：语句 96.97%、分支 96.44%、函数 99.14%、行 99.72%；包含 41 个加载器/基线边界测试。根检查共 966 个测试、六包类型检查、source-policy 160 文件零问题、全部覆盖率门槛及 1 套件／6 黄金案例通过。独立代码、TypeScript 和安全复审关闭已报发现。
- 依赖安装初期因已有 node_modules 权限与自动审批 403 失败，部分依赖一度需要恢复；服务恢复后已在原工作区正式离线安装并通过冻结锁文件检查。临时隔离副本与缓存引用已清理，原有全局缓存保留；当前结论来自真实工作区，不以临时副本替代。
- 生产依赖审计无已知漏洞；未再次提交或推送，未改变研究文件和其他用户改动。T0.8 仍需结构化生成/评分接入与更丰富黄金集，阶段 0 保持未完成。

## T0.8 结构化生成与评分本轮证据

- 新增宿主绑定的 ModelSession 与 method.generate：输入/输出结构、租户/连接/模式、调用身份、次数、字节与总时限均受限；尝试失败仍占用次数，无隐藏重试/修复。方法正文作为可信指令，来源/few-shot 输入保持不可信封套，eval 答案不送生产模型。模型输出经 schema/规则校验，只产生候选；未知 usage 保留 null。
- 独立 LlmReviewer 要求评分模型身份与模式摘要均不同于生产模型，依据版本化 rubric/分数锚点一次返回全部指标及理由。人工表单创建不生成分数，明确提交且核对宿主保存的 formDigest 后才产生 human_record。租户、输入/输出、方法、rubric、生产/评审模型均进入绑定；身份/evidence 由受信宿主配置，尚无正式认证、UI 或表单持久化。
- updateEvaluationReviews 只给保留产物补评分，无生产模型调用。requiredEvidence/rubricDigest 可锁定证据；缺评分仍 incomplete。不同 rubric、证据或评审模型不直接比较。报告升级 v2，强制租户/连接作用域并核对回执；v1 拒绝，不猜测迁移。章节基线显式重新生成，比对只改变报告版本及本地作用域，包内容、六例产物和分数未变。
- 组合测试使用真实 OpenAI 兼容连接器、注册模式 pin 和两条进程内合成响应，录制 [生成/评分 cassette](../../packages/methods/test/fixtures/generation-review.synthetic.json)，再离线完整回放；生成与独立评分各一次，无网络 fallback。usage 缺失保留 null，不声称真实模型推理、计费或实际人工质量结论。
- 独立代码、TypeScript 和安全复审先发现再回归修复：不同评分标准被直接比较、评分跨租户回放、发送前通用错误误记付费状态，以及取消/评分失败/接近 2MiB 产物序列化失败丢失付费状态。最后一处先红后绿验证；未知调用保持 unknown，已完成调用后的处理失败保留 completed。三类复审最终关闭发现。
- 原位 methods 类型检查及 168 个测试通过，四项覆盖率 97.03% / 95.63% / 98.86% / 99.63%（语句/分支/函数/行）。根 pnpm check 通过 1037 个测试、source-policy 169 文件、六包类型检查、全部覆盖率门槛和六个黄金案例。加上先前未变更数据库专项 49 个，累计有 1086 个不同测试记录；本轮没有重跑数据库或远端 CI。
- 当轮尚未实现费用/token 总预算、durable 模型外部步骤、Agent 调度/权限与真实模型/人工验收；后续进度见 T0.9 记录。用户暂缺 ComfyUI/API 节点与模型配置，后续补充；未新增提交或推送，最新本地提交仍为 1fdb5a8。

## T0.9 执行核心与制片骨架本轮证据

- 新增 [agents 内部宿主库](../../packages/agents/README.md)。Agent/工具严格 schema 与不可变 pin，工具契约兼容 MCP 数据格式但未开放 MCP 服务。调用严格限制到角色精确工具/方法 pin；对象由宿主参数提取器获取，不能越分配范围；非只读工具再检查角色写类型与阶段单写者。候选输出和恢复/对账输出均检查契约与目标范围，不触碰正式 IR。
- paid/publish 工具通过宿主审批 authority，请求包含租户、项目、任务、阶段、角色/工具 pin、输入摘要、对象及实际调用身份。只接受 boolean true；令牌不进模型/步骤/报告/工具参数。跨调用复用被拒绝，回放不重复消费审批；正式签发、认证和令牌原子消费服务尚未实现。
- durable 新增从实际领取任务捕获并冻结的 context.task，先失败后通过的回归证明来源自报字段不会替代真实租户/任务。Agent 绑定策略/输入/角色与工具 pin 后再开始循环；每次决策/工具各一个步骤。live/paid/publish 走 external，未知故障进 reconciling，不自动重试；已知安全失败保留结果封套及状态。上下文、步数/token/整数微币预算受限，未知用量按保守预留占用，恢复从保存结果重建消耗。
- 该轮项目预算还是宿主预分配份额，尚无事务共享账本；当时不能宣称并发项目总预算已保证。模型档位当时仅为声明，通用决策和角色文件加载待实现；后续验收见下文。源文本单独标作不可信数据，章节驱动不从来源获取授权。
- Task 树验证唯一根、父/依赖无环、同租户/项目、子范围不扩大，终态不复活。Issue 有定位、严重度、观众影响、改法、连带影响及 text/media 证据类型。Question 创建不虚构答案，明确提交核对可信 scope/digest/选项；这些纯域对象尚无跨工作流消息数据库。制片骨架把逻辑研究子任务保存在同一 durable 流程中，不冒充通用多任务并行调度器。
- 制片→研究→实际磁盘章节方法包→候选→producer.review 人工闸门已在真实 PostgreSQL 跑通。accept 只产生 reviewed_candidate，reject 保持 rejected_candidate，均不采用 IR。杀子 worker 时已确认方法步骤提交，随后启动独立进程，重放到人工闸门且方法调用计数为零；租约过期事件真实落库。合成付费工具未知故障进入对账，自动领取被阻止，显式补已完成结果后恢复且提交/审批均只发生一次，无模型外呼或计费。
- 复审先复现再修复 async 资源回调未观察拒绝、Question 接受选项外答案、producer 输出契约漂移、长父 ID 导致子任务超限，以及外部对账结果误标 not_applicable。另先红后绿补恢复输出 schema/对象范围检查。代码、TypeScript、安全最终复审关闭发现，未把复审者无 Docker 权限的失败探测当作其独立 PG 验收。
- 原位 agents 81 个单元测试与类型检查通过，覆盖率 99.01% / 96.11% / 100% / 100%（语句/分支/函数/行）；pnpm test:agents:local --coverage 84 个含真实数据库/进程测试全部通过。冻结锁文件离线安装通过。最终根 pnpm check 串行通过 1119 个测试、184 文件检查、七包类型检查、全部覆盖率门槛及六例黄金基线；累计不同测试记录为 1171（根 1119 + 先前数据库专项额外 49 + 本轮 Agent 数据库/进程额外 3，扣除重复单元）。
- 最终验证时曾误将根覆盖率与 Agent 数据库覆盖率并行，Vitest 正确以共享报告目录锁拒绝根运行；数据库命令完成后串行重跑根检查通过。CI 新增 Agent 数据库验收，但远端未运行。未再次提交或推送，未改研究文件；阶段 0 及 T0.9 均保持进行中。

## T0.9 角色加载与模型决策本轮证据

- 新增 loadAgentDefinition 与 agents/node 入口，读取严格 JSON 的 agent.yaml + 固定 instructions.md，注册校验后冻结。抽取 methods 的 dataDirectoryReader/parseDataJson 共用原有路径、链接、文件身份/快照、UTF-8 与 1MiB/2MiB 限制，methodPackReader 保持原窄路径白名单。33 个角色加载测试、原 41 个方法加载/基线测试及全部 168 个 methods 测试通过；未复制第二套文件读取边界。
- [研究角色](../../agents/research/agent.yaml) 与 [制片角色](../../agents/producer/agent.yaml) 已落盘并实际加载注册。研究角色精确锁定磁盘章节方法与可复用 research.chapter 工具；balanced 档及零费用预算供合成验收。确定性制片骨架仍有代码内默认角色，尚未变成通用文件驱动制片调度；真实调用需宿主选择已核实模式及授权预算版本。
- createModelDecisionDriver 通过 ModelSession/OpenAI 兼容连接器一次返回结构化 action，可信指令/工具从 registry 重建，来源与工具/人答观察只作为不可信 user 消息数据。输出工具必须在白名单且参数有效；最终输出过角色 schema；Question 不代填答案；模型不能自报 usage/approved 或隐藏重试。modelTier 与定义匹配，供应商/连接由宿主显式选择，不自动路由到未知模型。
- 模型回执进入 durable 步骤与 span。新/缓存/对账结果均验证调用身份、原始 API 请求/输出摘要、租户/连接/模式/模型/证据及用量。纯 requestDigest 与真正调用共用 prepare；durable.stepIdempotencyKey 抽取并复用原算法，API 请求摘要进入步骤指纹。已验证回执不能跨任务/决策移植，不能把 envelope 用量改零而继续。
- token 预留必须为正；live 的价格未知或为正时成本预留也必须为正，明确输入/输出价格都为零才允许零费用预留。价格以整数微币/百万 token 配置，BigInt 乘加后统一上取整，溢出拒绝。未知总量仍为 null，但已知部分作为下限：输入已知 1000/输出未知时，不会退回仅 50 的预留，而是保留至少 1000 并立即 QUOTE_EXCEEDED。宿主报价/价格估算不能替代供应商账单、tokenizer、远端限额或项目并发事务预算。
- [两次决策合成 cassette](../../packages/agents/test/fixtures/agent-decisions.synthetic.json) 实际经过磁盘研究定义/方法、真实连接器与进程内协议响应，再离线精确回放相同报告。章节工具调用一次；第二条响应缺 usage，token 未记零，预算占用 79、usageUnknown 保持 true。没有网络 fallback，不视为真实模型推理、质量评分或计费。
- PostgreSQL 新验收保存两次模型决策及回执，闸门恢复时创建全新模型会话/worker，供应商调用和 session.callsUsed 均为零，既有决策/工具完全从日志恢复。初始失败已定位为测试夹具把带 Date 的整个入队记录扩散到 JSON scope；改为仅取可信 tenantId/taskId 后通过，未放宽正式 JSON/权限边界。
- 代码复审的零预留付费放行、缓存回执移植/少记用量及部分已知用量丢失均先红后绿修复，代码/TypeScript/安全复审关闭发现。最终 agents 144 个单元及类型检查通过，覆盖率 99.01% / 95.80% / 100% / 100%。Agent 真数据库命令共 148 个含单元测试通过；durable 真数据库 79 个含单元测试及全源码覆盖通过（98.24% / 97.68% / 97.75% / 99.68%）。
- 冻结锁文件离线安装、根 pnpm check（1182 测试/193 文件/七包类型检查/所有覆盖率门槛/六例黄金基线）均通过。累计不同测试记录为 1235：根 1182 + durable 数据库额外 27 + 本轮 Agent 数据库/进程额外 4 + 先前未变更版本域数据库额外 22，已扣重复单元。真实端点、正式模型质量、跨任务账本/调度/消息、两轮审查升级及 T0.10 仍待验收；无新提交、推送或学习写入，阶段 0 保持进行中。

## T0.9 项目预算与两轮审查本轮证据

- 新增 [PostgreSQL 项目预算账本](../../packages/agents/POSTGRES.md)，固定 camery_agents schema 显式迁移，checksum/advisory lock 防历史改写。项目额度/币种不可变，分配绑定实际 durable 任务指纹、角色 pin 与份额；同任务跨项目唯一，分配 ID/收据身份不能挪用。所有写操作统一 task→project→allocation 锁序，同项目锁内 SUM(numeric)/BigInt 比较，累计超过 JS 安全整数也不丢精度。
- held 份额不设 TTL，不因任务终态、失败、取消或缺 usage 自动返还。settleConfirmed 必须在任务终态后由受信宿主明确提供 actual/actor/receipt/reference，还须无 running/unknown external；completed 或对账完成本身不证明账单已知。库不联网鉴真凭据，也不自证 actor 认证，实际量须覆盖所有尝试。已确认超 quote 仍入账形成 debt，阻止新分配；不同结算不能覆盖已结算金额。
- createBudgetedAgentWorkflow 把幂等预算分配放入 replayable 步骤，以数据库返回份额构造 RunBinding，随后运行已有模型/权限路径。来源在首 await 前复制冻结；该问题由独立 TypeScript 审查复现，补失败测试后修复。真实模型协议工作流重启时不再调用 allocator 或模型；DB 已提交而 journal ACK 丢失的故障注入中，allocator 重试两次仍仅一条 allocated 事件/一份额度，不把该注入冒充额外真实杀进程。
- 新增两轮审查纯域 createReviewLoop/submitReviewRound/submitReviewRevision，绑定任务、对象、方法、候选摘要及独立角色/model/mode。Issue 必须有位置/观众影响/改法/ripple 并匹配 text/media；首轮失败须明确改候选才可第二轮，第二轮仍失败仅产开放 Question。通过仅 reviewed_candidate，绝不采用；无第三轮、自动答案或虚构媒体观看证据。28 项定向测试通过，尚未接跨工作流消息存储/实际审片模型/人工收件箱。
- 真实数据库测试覆盖竞争最后份额仅一方成功、错误租户/项目/币种/Agent/任务指纹、未知取消后占用保持、非终态结算拒绝、收据冲突、超额 debt、累计安全整数以上、真实触发器异常与零行写入时分配/结算/审计一起回滚。迁移未知版本/改 checksum、连接/回滚失败和损坏汇总的拒绝另有隔离单元故障注入；无任意驱动错误回显。
- 最终 agents 单元测试 180 项及类型检查通过；无数据库范围覆盖率 98.89% / 96.11% / 100% / 100%，明确排除 node/budgets.ts，不冒充 SQL 覆盖。pnpm test:agents:local --coverage 全部 196 项通过并覆盖所有 Agent 源码，98.97% / 96.34% / 100% / 100%；既有模型回放、对账、闸门和实际进程故障验收仍通过。CI 原数据库任务会执行新用例，远端未运行。
- 根 pnpm check 通过 1218 项测试、200 文件基础检查、七包类型检查、所有覆盖率门槛及六个黄金案例。累计不同测试记录 1283：根 1218 + 本轮 Agent 数据库/进程额外 16 + 先前未改 durable 数据库额外 27 + 先前版本域数据库额外 22，已扣重复单元。代码、TypeScript、安全与数据库只读复审关闭/无遗留发现；未再次提交、推送或写学习库，阶段 0/T0.9 仍进行中。

## T0.9 持久化协作与人工升级本轮证据

- 新增 [持久化协作宿主接口](../../packages/agents/COLLABORATION.md)：初始 queued 任务树及完整角色/工作流路线固定，queueReady 为显式依赖已成功的任务写 enqueue outbox；syncTask 从真实 durable 日志核对身份、版本、输入、初始入队时间及角色输出契约，blocked/损坏报告不解锁下游。物理任务分开执行；尚无常驻调度宿主或自动通用制片角色选择。
- Task/Issue/Question、两轮 ReviewLoop、操作历史回执与事件保存于含租户/项目的复合身份下。项目锁内更新、revision/loopDigest 双 CAS；相同操作完整重试返回原历史快照。制作角色的方法完整 pin 必须在白名单内，审查身份/对象/候选契约继续校验；第二轮失败原子保存 Issue 和开放 Question，不生成答案、不采用 IR。
- relayOutbox 有界投递到现有 durable store。enqueue/signal 成功后才 ACK，丢失 ACK 可幂等重投；Question 的 answered 与 delivery 分开保存，实际 gate 类型/输入摘要和 signal 回执均匹配才确认送达。提前回答保留 pending，错误同名 gate 不误确认，成功投递后目标已终态仍能补 ACK。last_selected_at 轮转避免有限失败前缀饿死后续任务。
- 真实数据库验证两轮审查失败→持久化 Question→workflow 等待同一 Question→人工回答→outbox 投递→worker 恢复，审查仍保持 needs_human。当轮独立通用 AgentRuntime Question 自动入箱尚未实现，后续接入见下节；前端人工操作和真实审片模型仍待实现，text/media 与模型身份仍为受信宿主声明。
- 新增迁移 0002 与 0003；已应用的预算/协作迁移保持原内容，约束加强与队列索引通过追加迁移实施。migrateAgents 验证严格连续版本和 checksum，migrateAgentBudgets 为完整迁移器别名。协作锁内只做 durable 普通 MVCC 查询，不反向锁 durable task，避免与预算账本 task→project→allocation 顺序构成死锁。
- 回归先复现并修复等待连接时原始参数可变、未验证方法白名单、Issue 查询静默截断、signal ACK 缺 gate 证明、失败 outbox 前缀饥饿及私密错误回显。额外 route、伪造初始成功、跨作用域、损坏 job/manifest/收件箱、终态/未知外部结果均有拒绝验收；真实触发器使 INSERT/UPDATE 返回零行或最终事件失败，核对全表快照确认整笔回滚。
- pnpm test:agents:local --coverage 通过 316 项，全源码语句 97.98%、分支 96.05%、函数/行 100%。根 pnpm check 随后串行通过 1267 项、214 文件检查、七包类型检查、所有覆盖率门槛和六例黄金基线。累计已验证不同测试 1403 = 根 1267 + Agent 数据库/进程额外 87 + 先前未变更 durable 数据库额外 27 + versioning 数据库额外 22；未重复计数单元测试。
- 代码、TypeScript、安全、数据库只读复审关闭旧发现，无新增高置信度缺陷。真实供应商配置仍按用户说明后补，无外部付费调用、提交、推送或学习库写入；阶段 0/T0.9 保持进行中。

## T0.9 通用运行时 Question 收件箱本轮证据

- 新增 QuestionInbox 宿主能力和 createCollaborationQuestionInbox 适配器，AgentRuntime 构造器第五参数显式配置。RunBinding.logicalTaskId 与原 taskId 分别表示逻辑任务和实际 durable 任务；适配器读取物理 assignment，核对租户、项目、逻辑/物理身份、对象范围和角色完整 pin。actor 由宿主工厂固定，模型只提出 prompt/choices，不能指定身份或代填答案。
- 原始开放 Question 先在 replayable 的 agent.N.question.open 步骤中保存，核对精确回执，再等待同一 Question 输入的 durable 闸门。inbox descriptor 与 logicalTaskId 纳入 agent.bind，变更须升级宿主工作流版本；能力函数与输入等待前复制固定。配置 inbox 时缺少逻辑身份在决策前拒绝，失败不继续开 gate，取消前后检查，原始存储错误不回显。
- createBudgetedAgentWorkflow 的 planFor 支持 logicalTaskId，并通过原有事务账本按实际物理任务分配份额。真实数据库链路覆盖分配→模型合成决策提问→自动入箱→等待→宿主回答→outbox→新运行时恢复→candidate/逻辑任务同步；等待和终态不自动退款，额度仍 held。
- 故障验收实际强制终止子进程，窗口位于 Question 已提交但 open 步骤仍 running。人工回答提前保存，outbox 在 gate 尚不存在时明确 pending；另一进程恢复，不重复决策、不重复创建 Question，保留 answered 记录并建立原 gate，随后投递并完成。question_opened、question_answered、gate_signalled 均各一份，没有自动采用 IR 或供应商调用。
- 六项运行时/二十六项适配器定向回归先失败后实现；另外两项真实数据库/进程用例通过。pnpm test:agents:local --coverage 全部 350 项通过，全源码语句 98.09%、分支 96.29%、函数/行 100%。随后串行 pnpm check 通过 1299 项、221 文件、七包类型检查、所有覆盖率门槛和六个章节黄金基线；Agent 无数据库范围 261 项、覆盖率 98.72% / 96.36% / 100% / 100%。累计已验证不同测试 1437 = 根 1299 + Agent 数据库/进程额外 89 + 先前未变更 durable 数据库额外 27 + versioning 数据库额外 22。
- 代码、TypeScript、安全只读复审无高置信度新增缺陷。未新增数据库迁移、依赖、提交、推送或学习库写入，真实连接按用户说明后补。当轮行为评测尚未落地，后续见下节；常驻调度宿主、制片通用角色调度与 T0.10 等仍待完成，阶段 0/T0.9 保持进行中。

## T0.9 合成行为评测基线本轮证据

- 按 ADR-013 新增 [Agent 行为评测](../../packages/agents/EVALUATIONS.md) 与 [首份冻结基线](../../packages/agents/evals/baseline.json)。十个固定案例运行实际 AgentRuntime/工具/ReviewLoop，包括候选、来源指令边界、未授权工具、对象越界、预算熔断、付费无审批、显式 Question、两轮升级、独立审查身份及磁盘章节研究角色/方法。每例用新内存日志执行后精确回放，最终用新注册表再次比较；无真实模型、审片或付费服务调用。
- 输出 oracle 预先声明，章节边界为独立 UTF-16 常量，改变实际成功产物的负回归会失败，未从运行结果反算期望。报告比较 suite/oracle、角色 pin、计数、计量与轨迹摘要；默认只读，首次创建基线使用明确 eval:baseline 命令，后续检查不会自动改写。
- 区分断言通过、业务任务完成、人工升级与人工辅助。十例全部断言通过；完成 5/10、升级 1/10、辅助 2/10，15 决策、6 次工具尝试、1 个已答 Question、3 轮审查。预期权限拒绝可以通过断言，但不算业务完成；candidate 未通过输出断言也不算完成。这些比例仅描述混合合成案例集，不代表生产成功率。
- 未知 token/费用保持 null；已知部分下限为 21 token / 9 CNY 微币，预算占用为 25 token / 14 CNY 微币，均为夹具数据。BigInt 汇总避免跨案例超安全整数丢精度；执行证据缺失不补零。模型 receipt 与 span 使用同一 meterModelUsage 计量规则，完整/部分回执矛盾和 live 模型证据拒绝。报告仅存身份元数据、计数和摘要，不存来源、产物/审查正文或原始异常消息。
- 新增通用 runner、验证/精确基线检查、固定 Node 案例和 CLI，根 pnpm check 纳入 test:agents:evals，CLI 实际子进程检查通过。复用 methods 的受限读取/原子替换，没有新增文件写入机制或依赖。
- 新增 24 项测试通过。真实 PostgreSQL 全组合 374 项通过，覆盖所有 Agent 源码（仅排除薄 CLI 入口）：语句 97.66%、分支 95.78%、函数 99.65%、行 99.78%。随后串行根 pnpm check 通过 1323 项、228 文件、七包类型检查及两类基线（章节 6 例、Agent 10 例）。Agent 无数据库 285 项，97.93% / 95.63% / 99.48% / 99.70%。累计不同测试 1461 = 根 1323 + Agent 数据库额外 89 + 先前未改 durable 数据库额外 27 + versioning 数据库额外 22；基线命令重复执行的案例未另计入测试总数。
- 代码/TypeScript 复审复现的模型回执计量不一致、基线参数首次等待前未捕获，以及输出断言失败仍计完成，均先失败再修复并确认关闭；安全复审无新增高置信度缺陷。最初 PG 组合运行拾取到正在补充的红回归，源码修复冻结后完整重跑通过；未把红测期间的结果作为最终验收。
- 未新增迁移、依赖、提交、推送或学习写入；真实供应商配置按用户说明后补。常驻调度宿主、制片通用角色调度、T0.10 认证及阶段 0 外部验收仍待完成，目标保持进行中。

## T0.9 任务树轮询宿主与精确领取本轮证据

- 新增 [AgentDispatchHost](../../packages/agents/HOST.md)，固定一个已授权租户/项目/树，提供有界 tick 与可停止 run 轮询。每轮读取/校验不可变定义和任务快照、同步实际日志、解锁依赖、投递本树 outbox、精确执行已注册路线，再同步状态。只返回身份、状态、revision 和安全码，不返回输入/产物正文。
- durable 新增可选 claimTask、Postgres exact-target 实现与 worker.runTask/hasWorkflow；与原 claim/runOne 共用租约、fence、未知 external 对账、timer、失败预算和步骤执行核心。目标不存在、尚未到期或不可领取均返回空闲，不回退租户队列，不扫描其他过期任务；领取身份/owner/fence/status 不匹配拒绝 handler。
- 宿主先确认固定完整路线已注册，核对实际物理任务的工作流版本、输入、重试上限和稳定 hash ID。项目 outbox 只投递自身物理 ID 的记录，其他树命令保留；扫描可更新项目级选择提示。同步与执行各自有界轮转，执行预算截断时从最后实际检查项之后继续，失败重试/等待不能一直占据队首。
- run 的停止信号阻止新领取与轮询，在途执行按既有 timeout/lease 排空，不冒充业务取消。等待中的 Question、回答和 outbox 保留；新宿主可以继续。失败/取消的依赖派生 blockedTaskIds，不伪造未运行子任务终态，仍允许独立分支完成；complete 仅表示逻辑树成功，pending 投递仍明确返回。
- 真实 PostgreSQL 验证制作任务→两个研究分支、两个并发宿主实例、同租户更早无关任务与其他树 outbox 隔离，以及项目预算/Question 等待→停止→人答→新宿主恢复。底层九项新 PG 用例验证 exact claim 唯一租约、external 过期只处理目标、失败预算、stale fence、timer 和 runTask/runOne 双向缓存恢复。既有真实杀进程验收继续覆盖共用执行核心；本轮并发宿主测试使用同一测试进程内两个实例，不宣称新增跨进程部署验收。
- 回归复现并修复 strict logical key 多带 treeId、扫描预算大于执行预算时跳过未访问尾部、误传 async hasWorkflow 留下未处理拒绝。同步 callback guard 从 runtime 抽为共享实现，fulfilled/rejected Promise 均拒绝并观察；代码、TypeScript、安全与数据库只读复审核对关闭，无遗留高置信度发现。
- 本轮新增 Agent 单元 17 项/PG 4 项，durable 单元 15 项/PG 9 项。pnpm test:durable:local --coverage 全部 103 项通过，98.14% / 97.47% / 97.89% / 99.69%；随后 Agent 数据库全组合 395 项通过，97.48% / 95.57% / 99.69% / 99.79%。最后串行 pnpm check 通过 1355 项、234 文件、七包类型检查、所有覆盖率门槛、六例章节与十例 Agent 基线。累计不同测试 1506 = 根 1355 + Agent 数据库额外 93 + durable 数据库额外 36 + 先前未改 versioning 数据库额外 22。
- 宿主仍是可嵌入轮询组件，未安装系统服务或加入应用/worker Compose。当轮 ADR-012 OpenTelemetry 尚无包实现/依赖，后续接入见下节；未把结构化 span 当作已经接入。完整制片角色按阶段 1 实施，阶段 0 保持制片骨架验收范围。当轮未新增迁移、依赖、基线改写、提交、推送、真实供应商调用或学习写入。

## T0.9 本地 OpenTelemetry 本轮证据

- 新增 [工作流手动埋点与本地 SDK](../../packages/agents/OBSERVABILITY.md)。官方 npm registry 核实并锁定 @opentelemetry/api 1.10.0、@opentelemetry/sdk-trace 3.1.1，使用当前 SDK 的实际类型/API；Node 最低要求提高为 22.15.0。显式创建 provider，不注册全局 SDK、环境 exporter、资源检测或网络/文件输出，不改变工作流版本、日志步骤或候选摘要。
- 装饰器对实际 workflow/step/decision/tool/gate/timer/question 生成真实 SDK 父子 span，显式 ROOT_CONTEXT 避免无关 ambient 上下文串链。普通步骤标 executed/replayed，gate/timer 返回标 journal；等待、未知 external、租约/超时等标 interrupted，不把观察状态当作 Task 已提交终态。宿主可明确传入此前真实 span 的 parent，新 provider/worker 延续关联；默认不自动持久化或跨进程传播 parent。
- 属性仅含作用域/任务/工作流/步骤摘要、二次哈希 pin、输入/输出/安全错误摘要、已知用量及 known 标志、预留/预算占用与固定枚举。保留未知用量，费用不等同账单；不记录来源、答案、产物正文、actor、异常消息/堆栈、resource、events 或 status message。元数据与 scope accessor 不执行，伪装成 64 位 hex pin 的来源凭据也不会原样导出。
- 本地 exporter 在写缓冲前核对当前 tenant/project 并清洗固定字段，默认 1000/最大 10000 个已结束 span，环形丢弃并报告 dropped；快照冻结且只由明确 snapshot 调用取得，flush/shutdown 错误归一化。未安装 Collector、OTLP 远端 exporter、持久化追踪服务或完整诊断包文件流程，按部署/发行任务单独实施。
- 实际 PostgreSQL 运行磁盘章节方法的制片→研究→工具→人工闸门，随后新 worker/provider 显式接续此前真实 root span。记录执行与回放不同标记、相同任务摘要和正确 parent；工具 handler 总计一次，gate 信号一次，日志工具步骤一条。导出快照不含来源、租户/项目/任务原文、actor 或预算分配身份。
- 三项代码/TS 复审问题已先失败再修复并确认关闭：新增 observed Promise 的忘 await 拒绝保护、invalid timer 不覆盖原 durable 验证、unknown/lease 类不误标业务失败。另补 accessor 和伪装 pin 负向回归。代码、TypeScript、安全最终复审无遗留高置信度发现；遥测失败不改变原输出或原始拒绝。
- 本轮新增单元 22 项、PG 1 项。pnpm test:agents:local --coverage 全部 418 项通过，97.61% / 95.43% / 99.73% / 99.81%；随后串行 pnpm check 通过 1377 项、241 文件、七包类型检查、所有覆盖率门槛和六例章节/十例 Agent 基线。Agent 无数据库 324 项，97.79% / 95.03% / 99.63% / 99.75%。累计不同测试 1529 = 根 1377 + Agent 数据库额外 94 + 先前未改 durable 数据库额外 36 + versioning 数据库额外 22。
- 使用现有 pnpm store 完成冻结锁文件离线安装；新增生产依赖审计返回 No known vulnerabilities found，限当次公开漏洞库和依赖图。未改迁移/评测基线、提交、推送或学习库，未调用真实模型或外部付费服务。T0.9 核心库/本地验收范围完成，阶段 0 整体仍未完成，T0.10 与宿主集成及外部验收继续推进。

## T0.10 认证与项目 RBAC 本轮证据

- 新增 access 和 NestJS/Fastify server 两包，使用 npm registry 核实的 NestJS 12.4.2 / Fastify 5.12.8，沿用 ADR-002，不新增外部身份服务。可撤销 opaque 会话使用 Node 密码学随机 32 字节原始令牌，数据库仅接收 SHA-256 哈希；寿命 60–86400 秒。可信安装者显式签发，HTTP 不公开签发/初始化能力，也未虚构密码注册、OIDC 或登录 UI 已完成。
- 部署配置固定 tenantId；请求体、query 和代理身份头不能选择租户、用户或角色。每次鉴权使用数据库时钟检查撤销、过期和账号状态，并重读项目角色。viewer/editor/reviewer/admin 均限当前项目，未知角色/操作、无成员及跨租户/项目均拒绝；请求身份脱离回调对象并冻结，字段 accessor、数组空洞、proxy 异常不执行 getter、不泄漏原生诊断。
- 实际 Nest/Fastify 入口提供公开存活检查、受保护的自身身份/项目权限查询及撤销当前会话。全局 guard 对没有显式策略的业务 handler 默认拒绝；真实原始重复 Authorization 头在任何存储读取前拒绝。安全响应头、no-store、随机请求 ID、正文限额和固定错误码已接通；不记录请求凭据或底层数据库错误。
- PostgreSQL 迁移使用事务/advisory lock/checksum，表键与外键包含租户。运行进程不自动迁移；启动检查拒绝 superuser/BYPASSRLS、DDL、身份/角色写权限、全表会话 UPDATE，以及管理员连接加 role 参数伪降权或可 SET ROLE 的其他身份。独立随机密码 LOGIN 实际鉴权/撤销成功，同时实际拒绝修改成员、签发令牌及创建表；不将管理员连接的通过作为最低权限证明。
- 三项代码复审发现（重复原始认证头、停机 hook 失败未释放连接、未知身份 getter 异常泄漏）与一项 TypeScript 复审发现（缺数据库 URL 集成测试假绿）均先失败再修复并关闭。代码、TypeScript、安全、数据库最终复审无遗留高置信度发现。安全方另以 20 个交错请求验证身份不串用。应用关闭失败仍独立释放数据库池。
- `pnpm check` 通过 1421 项测试、九包类型检查、267 源文件零策略问题、覆盖率与既有基线。access 真实数据库全组合 44 项、server 真实数据库/HTTP 全组合 19 项均通过。累计不同测试 1592 = 根 1421 + Agent 数据库额外 94 + durable 额外 36 + versioning 额外 22 + access 额外 18 + server 额外 1；历史未改模块的 PG 项沿用前轮执行记录。
- Windows 包间并行覆盖率在测试全部通过后两次出现临时目录 EBUSY；同一源码改为包间串行后整仓检查通过，故根 coverage 脚本固定串行，不降低门槛。冻结锁文件离线安装通过；生产依赖审计无已知漏洞。CI 加入两项真实数据库命令，但未执行远端 CI。
- 本轮完成的是单租户认证/RBAC 骨架及本地证据。完整登录/安装、TLS/限流、业务候选/调度服务接入和应用/worker Compose 尚未验收；数据库连接只供受信任服务端持有，未声称提供 RLS 或对不可信 SQL 客户隔离。已开始的请求不因之后的角色变更自动中断，敏感写服务需在其事务内再次验证。上线仍需 L4 安全人工 gate。真实模型配置按用户说明后补，阶段 0 整体仍未完成；未新提交、推送、调用真实付费服务或写入学习库。

## T0.1 / T0.10 API 镜像及私有化运行本轮证据

- 新增 [多阶段 API 镜像](../../deploy/Dockerfile.api)和[可选 Compose 档案](../../deploy/compose.api.yml)，沿用基础 PG 档案。官方 Node 24.22.2 bookworm-slim 使用已拉取摘要 `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`，本机验证 linux/amd64。新增开发构建依赖 esbuild 0.28.2，内部工作区代码编译为原生 Node ESM bundle；pnpm deploy 保持锁定第三方生产依赖闭包，隔离运行目录中的内部源码副本在边界校验后移除。
- 构建上下文采用 allowlist，显式排除所有环境/凭据文件、研究资料、本机状态、node_modules 和测试。最终镜像 `/app` 仅 bundle、瘦 manifest 与 production node_modules；实际检查 UID 1000，工作区文件/开发工具不可解析。最终镜像 `camery-api:phase0` 为 `sha256:381618d01f67a12a12378b6f962ff366728f9c1427b4c800ae8a86b6107af408`，bundle SHA-256 为 `a23780d706e96151db8a54de6ac3bc07a2619f877d5ed1cc76ed7dcf4ca35a03`。未推送镜像仓库。
- 运行凭据支持 URL 或 URL_FILE 二选一；文件是普通文件，实际读取限制 8 KiB，可有单个尾换行，拒绝双来源、控制字符或格式错误。五项环境配置在首次等待前按 own-data 快照，之后修改环境不会改变此次 tenant/host/port，也不执行 getter。错误不含文件内容。宿主默认回环监听，容器内可显式绑定 0.0.0.0，Compose 只发布到宿主 127.0.0.1。
- 容器使用只读根目录、capabilities 全移除、禁止提权、进程/内存上限及临时 tmpfs；真实独立低权限 LOGIN 的 URL 只以运行文件 secret 挂载。实际 HTTP 验证有身份读取/项目权限、无凭据 401、跨项目 403、退出 204，以及容器重启后旧令牌 401；检查日志不含密码/原始令牌/URL。SIGTERM 正常停止后退出码 0，缺配置原生 bundle/镜像自然安全退出 1。健康检查只代表进程存活，不替代数据库持续就绪验证。
- 冒烟用唯一临时 API 项目复用已有 PG 外部网络，`--no-deps` 不重启数据库。Docker 的随机端口在重启后可能变化，测试从实际 port 命令重新获取。只清理自身容器、空卷、随机租户/角色和自建文件；资源清理逐项独立，数据库或 pool 失败也继续尝试删除 secret。最终观测无遗留冒烟容器/卷，原 `camery-phase0` 数据库仍 healthy。
- 复审发现的清理失败残留凭据、await 期间环境改变、运行包畸形依赖/外部 scope symlink 越界均先红后绿修复；9 条路径攻击测试只 mock rm，不实际删除隔离目录外内容。代码、TypeScript、安全最终复审无遗留发现。构建子进程一度两次超时，根因未证明；保持超时失败、自然退出和 killed=false 条件，后续组合及最终整仓通过，未将早期失败算作验收。
- 新增单元 18 项、Compose 1 项。最终 `pnpm check` 通过 1439 项、276 文件、九包类型检查及全部覆盖率/基线；`pnpm test:server:local --coverage` 全部 37 项，四项 100%；`pnpm test:private-api:local` 最终冻结镜像实际 1 项通过。累计不同测试 1611 = 根 1439 + Agent PG 额外 94 + durable 36 + versioning 22 + access 18 + server PG 1 + Compose 1，未改模块的 PG 沿用历史记录。
- CI 已加入镜像构建、独立 Compose 数据库 fixture、认证/重启/撤销验收及带 owner marker 的清理；远端 CI 尚无新运行证据。本机冻结锁文件联网校验与之后离线安装均通过，生产依赖审计无已知漏洞。部署说明已记录权限、凭据文件和实际命令。
- 本轮补的是实际 API 运行路径，未把只有配置文件当作容器已运行。worker/前端/media 编排、认证到版本采用/调度应用服务、完整静态 lint 和 T0.3 余项仍需推进；真实供应商、合规、设计伙伴、剪辑器导入维持各自外部验收边界。未新提交、推送或写入学习库，阶段 0 整体继续进行。

## T0.1 / T0.9 同镜像章节 worker 本轮证据

- 新增 worker 原生入口、配置、内容绑定、固定章节工作流和宿主适配，复用实际 AgentDispatchHost、PostgresCollaborationStore、DurableWorker 与项目预算账本。部署配置锁定 tenant/project/tree/worker ID，首次等待前整体快照；不读取来源中的配置，不自建项目/树、迁移或授予数据库权限。每轮只接受固定内置路线及单一 source 对象，返回同一份已验证冻结树快照。
- 内容加载只使用明确的 8 个角色/方法数据文件，保留方法包声明中必须的黄金评测文件及原 pin。方法 pin 嵌入派生制片身份的 methods，持久任务因此锁定具体方法版本；升级镜像不能静默替换排队任务的方法。原仓库角色、方法包和黄金基线未改写，不声明这些内容是新的真实模型质量证明。
- 预算预留记录为 durable 幂等步骤，8 steps/0 tokens/0 cost micros（CNY），回执完整匹配作用域/任务/制片和 held；项目不足时不运行方法。继续原研究→章节候选→producer.review 流程，不包装 durable 暂停/租约异常。结果投影到外层制片 state/candidateDigest 契约，正文留在日志与闸门，不采用 IR。终态分配仍 held，真实量由后续受信宿主确认，不自动伪造结算。
- [独立 worker SQL 身份](../../packages/server/WORKER-POSTGRES.md)只授固定表/列，禁止更新预算限额、既有分配状态/回执或认证数据；仅保留必要锁列 UPDATE，identity 事件追加无需直接序列权限。真实 LOGIN 专项 7 项覆盖调度/预算/闸门/同步、缺权限和额外权限。DB 复审发现 SET FALSE 仍可能继承/管理其他角色，以及漏查认证 schema CREATE/ownership，均先红后绿修复；API 角色同步收紧，保守拒全部 MEMBER 和四个受保护 schema CREATE/所有权。未通过转移现有 schema owner、DROP 或读服务器文件测试；这是可信服务 SQL 配置，不是 RLS/不可信 SQL 的值级沙箱。
- 统一镜像增加 worker.mjs 和必要第三方闭包；内部全部 bundle，独立 pnpm deploy 遍历清除全部 workspace 副本，提升相同实际安装的第三方绑定，有 peer/版本歧义则拒绝。本地 dist 另生成开发链接供原生 Node 运行，生产 Docker 不复制这些开发链接。构建相对输出在入口统一绝对路径，start:worker 使用 built 入口避免缺 content 默认路径。最终镜像为 `sha256:e4ad5807f2428e2f070b75a31cf987eb27f37a7450141d166b2f746b0be64d4d`（linux/amd64、UID 1000）；镜像未推送。
- 真实同镜像 Compose 测试使用独立受限 LOGIN 与运行文件 secret，生产为只读/删除全部 capabilities/禁止提权。实际章节方法运行到人工闸门，SIGTERM 正常停止退出 0且保留 waiting；另以 SIGKILL 退出 137，再由新进程取得受信测试审阅信号并成功完成。预算分配和方法步骤日志各一条，较早无关任务仍 queued/attempts 0，日志不含密码、连接 URL 或原文/候选专用标记。临时探针关闭自动重启以明确边界，发布策略仍最多失败重启三次；不把这次等待中的强杀说成新增“工具执行中途杀容器”，既有执行中进程故障注入证据不变。没有新增真实人工 UI 或生产审批链验收。
- 代码复审发现宿主返回可变原树快照、TS 复审发现源入口 content 路径和相对构建目录不一致，均建立失败回归后关闭。构建初期真实缺 Drizzle 裸导入、两处 PG 测试误传严格项目键已修，不把这些红测算作最终验收。代码、TypeScript、安全与数据库最终复审无遗留高置信发现；内部 SQL 的合法追加能力不被表述为能抵御任意直接 SQL 调用。
- 最终 pnpm check 1456 项通过（server 单元 53），291 文件/九包类型/四项覆盖率及既有 6+10 基线均通过；server 真实 PG 63 项为 98.38% / 97.08% / 100% / 100%，access 真实 PG 44 项通过并维持 ≥95%。同镜像 worker/API Compose 各 1 项最终通过。累计不同测试 1638 = 根 1456 + Agent PG 额外 94 + durable 36 + versioning 22 + access 18 + server PG 10 + 两个 Compose；未改模块的 PG 额外项沿用此前记录。冻结锁文件离线安装、生产依赖审计、diff 检查通过。
- CI 已加入 scoped worker 容器恢复验收，远端 workflow 尚未执行。本机临时容器/卷/角色/凭据已清理，原 PG 仍 healthy。当前剩余包括认证 HTTP 采用/调度/审阅服务、完整静态 lint、T0.3 旧规则/实体审计、真实供应商、外部合规/伙伴/编辑器验收；前端/media 按实际实现加入，不创建虚假服务。未新提交、推送、调用真实付费模型或写入学习库，阶段 0 保持进行中。

## T0.3 旧规则审计与交付声明闸门本轮证据

- [旧规则核对表](../../packages/ir/LEGACY-RULES.md)记录原 Python 70 个报告调用点（67 error、3 warning）的去向，区分新语义、仅旧导入检查及必须实际文件验证的边界。该计数不包含 JSON Schema 的全部字段约束，不宣称任意旧包与新模型等价。
- 在删除旧字段/规范化前补采用指针、空集、cue 场次和 shot 时间交集、旧分组顺序/范围/成员、ready/produced 声明、coverage 正反边与按目标覆盖、export 一致性守卫。33 项新增回归；原 88 项迁移测试及两个样例生成物未改写。遇矛盾返回 ok:false/package:null，reset_readiness 仍只降级 planned，delivery/publish 始终 blocked，不虚构取用、文件认证或授权。
- 新 delivery 要求声明 adopted 修订、ready 目标、非空集与每目标/集内容、消费引用 actual/ready；规划保留空骨架和未消费计划候选。补直接 self-replacement 拒绝与三种声明限制 warning，新增 7 项回归。另 2 项 token 边界测试确认原 ULID/order key/hash 拒绝末尾换行和分隔符，未修改 schema。生产夹具只补齐声明，不充当真实素材证明。
- 永久手动 audit:legacy 实际运行两个原始 fixture 的 10,595 个单点变体，迁移接受 134 个，原 Python/schema 拒绝其中 0 个；输入摘要随报告输出。独立复审发现审计脚本若全拒绝会真空通过，已加入两个原样例的双边正向控制和固定阶段错误上下文；实际临时故障注入将迁移替换为全拒绝，确认在 baseline-migration 退出 1，临时文件清理。它不是全部合法包、多点组合或全部 schema 等价证明。
- 最终整仓 pnpm check 1498 项通过、295 文件 source-policy 零问题、九包类型检查、全部覆盖率门槛及既有 6+10 基线通过；IR 350 项、99.27% / 98.6% / 99.24% / 100%。真实 versioning PostgreSQL 全组合 187 项回归通过、98.85% / 97.08% / 99.31% / 99.81%，其余未改模块数据库/容器证据沿用前轮。累计不同测试 1680 = 根 1498 + Agent PG 94 + durable PG 36 + versioning PG 22 + access PG 18 + server PG 10 + 两个 Compose；不重复计入组合中的单元测试。
- 代码、TypeScript、安全只读复审发现均关闭；四份相关 Markdown 的本地链接及 diff 检查通过。T0.3 其余实体/引用、全部结构字段和产品导入验收仍待核对，认证 HTTP 业务服务及外部验收维持各自剩余项。未新提交、推送、改写原样例或评测基线、调用真实供应商或写入学习库，阶段 0 继续进行。

## T0.1 静态 lint 与 T0.3 取用精度本轮证据

- 根 lint 先运行原 source-policy，再对 packages/scripts 全部源码、测试与配置运行锁定的 Oxlint 1.93.0 + oxlint-tsgolint 7.0.2006，开启 correctness 和原生类型感知 Promise 检查，警告/无效禁用指令均失败。官方 npm 与文档核实当前 typescript-eslint 的支持范围不含本仓库 TypeScript 7，因此没有为 lint 降级各包编译器；选型来源和命令见根 README。
- 4 项新实际 CLI 正反测试分别验证 JS 常量重赋值、未处理 TypeScript Promise、异步回调误赋同步契约会被拦截，以及已处理 Promise/正常 JS 通过。source-policy 仍保留自己的 4 项测试。独立代码审查核对实际 debug 文件清单，253/253 个工作区代码文件无遗漏或依赖/产物混入；测试仅对 mock 方法引用、稀疏数组与恶意 thenable 样例关闭对应三条规则。安全输入过滤和清理拒绝保留带原因的单行例外，不全局禁用保护规则。
- lint 暴露的正则无效转义、隐式 URLSearchParams 字符串化、字符串 spread、reader 方法引用和冗余 unknown 联合均作等价修正；死 yield 改为实际拒绝的异步迭代测试路径。不自动重排格式、改评测基线、删除研究资料或改变业务策略。
- 独立范围核对复现取用的 0.5µs 前置缺口与内部重叠会被原 1e-6 容差放行，先红后绿新增 15 项测试。取用时长、源区间、handles、排序与覆盖改用 BigInt 有理数；无中间 Number 乘除溢出/下溢。为保持原版本域拆镜的数值快照契约，按每个字段实际 IEEE 半 ULP 加 decimal 差额传播舍入预算，且另有 ≤1ns 硬上限；非精确接受明确发 TAKE_TIME_ROUNDED。首段偏移（含5e-324）、超出预算的亚纳秒缺口/重叠、源越界与尾缺口仍拒绝。没有把 1ns 当作通用容差，也没有修改素材或 schema 来掩盖误差。
- 原 versioning shot-edits 36 项通过，包含分数播放率切点的 TIME_ROUNDED 案例。最终 pnpm check 1517 项通过（工具8、IR365）、298 文件 source-policy 零问题、完整代码 lint、九包类型检查、全部覆盖率及既有6+10基线通过；IR四项99.28% / 98.63% / 99.25% / 100%。实际 versioning PostgreSQL 全组合187项再次通过，98.85% / 97.08% / 99.31% / 99.81%。其余模块数据库及容器验收沿用前轮，不把已有镜像当作本轮源码重新构建运行的证据。
- T0.3 明确指定的契约基础及本地验收已有对应证据，README 按 ShotTake、声音、PlotUnit/快照、质量档、旧迁移列出实际测试。完整 AnchorVersion/派生/机位模块属于阶段2，Shot 的预留 anchor_refs/camera_placement_id 当前只查结构、不证明引用可解析；导入 UI 属于T1.1。任意旧包/全部schema等价仍不是现有差分审计的结论，不再以整个产品实体表或后续 UI 无限扩大阶段0。
- 冻结锁文件离线安装通过；包含新开发工具的 pnpm audit 返回 No known vulnerabilities found，限当次公开漏洞记录。独立代码/TS复审核实数学边界与等价修正，无遗留高置信发现；极值短探针确认最小次正规数、最小正规数、1、最大有限数均无异常，NaN/Infinity/负值仍由schema拒绝。文档本地链接、diff和临时fixture清理检查通过。累计不同测试1699，根1517 + 历史/本轮PG额外180 + 两个历史Compose，不重复统计组合内单元。
- 阶段0整体继续进行：ADR-001任务编排/缓存、远端CI及T0.7/T0.11–T0.13外部验收仍待各自证据。真实供应商配置按用户说明后补。未新提交、推送、外联、真实付费调用或学习写入。

## T0.1 Turborepo 任务图与缓存本轮证据

- 新增锁定开发依赖 Turbo 2.11.10、根 turbo.json 和 workspace.mjs。typecheck 通过 ^typecheck 传播上游源码哈希，默认包内文件、根 tsconfig/工作区配置、方法包/Agent 数据与旧契约/样例登记为输入；Node完整版本、OS/架构、真实检出路径生成运行指纹，NODE_ENV/NODE_OPTIONS/CI/TZ/LANG等影响缓存键。只读核对原生依赖平台映射与已装包optionalDependencies一致，没有编译器降级。
- 仅成功的 typecheck 可命中本地缓存；测试、覆盖率、评测、构建都cache:false，普通测试并发4、覆盖率1。build先执行/核对自身typecheck，并真实生成API/worker bundle与8个固定内容文件。dist/node_modules包含当前安装的开发链接，因此不缓存构建输出。PG/Compose仍使用原专用入口，不进入Turbo；远端缓存关闭、遥测关闭，不使用缓存token或上传构建产物。
- 根check/test/typecheck/build及两个eval入口已统一调度。参数仅接受已知任务、fresh/dry及合法包过滤器，核对包名与对应script，错误名称/没有该任务不能空跑通过。继承TURBO_*剥离，固定严格环境；fresh仅跳过本地缓存读取，不能启用远端缓存。生成.turbo目录在Git/source-policy/Oxlint中排除，避免把缓存元数据当源码。
- 新增4个入口单元和2个真实Turbo隔离探针，共6项：实际执行计数证明冷/暖缓存、上游与本地源码分别失效、根tsconfig/方法包/环境变化失效、失败不缓存且阻止下游，以及test/coverage/eval/build每次都运行。探针只运行Node内置模块并使用自有临时目录；其最小workspace显式禁隐式初始化，正式仓库verifyDepsBeforeRun:error保持不变；初始化失败也清理自有目录。
- 代码复审发现Turbo默认JS shim在缺原生binary时会尝试npm install；通过只读mock确认后改为解析已安装的精确平台binary直接spawn，并--skip-infer防再次委派，无installer/legacy/仿真fallback。缺binary/不支持平台明确失败；没有为通过检查自动安装依赖。另一项复审发现探针固定NODE_OPTIONS可能与caller相同，已改为保留原值追加合法flag，按原复现场景NODE_OPTIONS=--no-warnings运行已通过。初始化中断清理LOW也已修复；代码、JS/TS、安全最终只读复审无遗留高置信发现。
- 整仓pnpm check与普通pnpm test各1523项通过；check中9个coverage任务及6+10评测均实际执行、0缓存重放，全部≥95%门槛保持。最新工具14项再次通过；source-policy302文件零问题，Oxlint实际256个代码文件，9包类型检查实际冷执行9/9后暖缓存9/9。pnpm build两次实际通过：首次10任务均执行，第二次9个类型检查命中、server build仍真实执行；本轮未新增业务源码、数据库迁移、评测基线或真实模型调用。
- 冻结锁文件离线安装通过；包含新开发依赖的pnpm audit无已知漏洞。新锁文件Docker重建两次均在frozen install读取registry.npmjs.org/typescript完整元数据响应时以ERR_PNPM_RESOLVING_NPM_RESOLVER_BODY_READ_ERROR终止，未到源码编译。宿主pnpm view同现；独立精确版本接口HTTP200返回7.0.2，根因未证实。没有更换registry、跳过供应链/锁文件校验或改依赖版本，不能记为新镜像验收。原镜像仍为sha256:e4ad5807f2428e2f070b75a31cf987eb27f37a7450141d166b2f746b0be64d4d，原phase0数据库实际仍healthy；未拿旧镜像重跑冒烟并冒充当前增量证据。
- 已观测origin配置存在，本轮工作区增量未新提交/推送，故没有匹配当前增量的远端CI结果。当前累计不同测试1705 = 根1523 + 各PG额外180 + 两个历史Compose，数据库/容器证据不重复计数也不声称本轮重跑。文档链接/diff/临时fixture清理检查通过。阶段0仍进行中；后续推进T0.11–T0.13及真实节点/远端CI与镜像环境余项，不扩入后续阶段产品模块。未学习写入或外联。

## T0.11 原文证据与 T0.13 准备本轮记录

- 新增[合规原文核对包](../compliance/phase0-source-review.md)，区分原文定位、业务适用性、规则批准与技术实现。实际读取广电总局2026年令第16号与网信办标识办法，核对2026/2025两组不同施行日期、分类并非只按金额，以及播出单位的审核/节目编号责任；没有把旧30万/100万口径自动套入当前分类，也不从未检索到配套原文推断“未发布”。
- 国家标准登记页当前状态和封面编号/日期相符；从政府网站取得GB 45438-2025的19页PDF镜像，记录SHA-256，并用Poppler渲染阅读第6.1节及规范性附录E（PDF第8/17页）。字段拼写以附录E为准，不拿资料性F不同拼写覆盖。TC260旧PDF/正式指南RAR入口实际返回HTML首页，未取得的容器细则保留未知；没有用搜索缓存、征求意见稿、元数据键存在或任意FFmpeg参数证明全格式支持。
- 新增[授权台账模板](../compliance/rights-ledger-template.md)，覆盖具体对象/版本、权利链、许可行为/地域/期限/平台/克隆用途、受控材料引用、核验状态与修订影响。当前真实记录为零，没有生成合同、真实签字人、许可编号或人身数据；文件存在/摘要/声明状态不替代真实授权。模板本身未接数据库/审批或产生交付发布权限，法务/产品签核与生效规则版本仍待真实证据。
- 独立文档复核实际重取S1/S2并核对日期、主体范围和条次，另独立核PDF摘要及两张源页图。复审建议将“平台审核编号”收紧为原文“播出单位播前审核及节目编号”，已修正；本次是来源一致性复核，不是法务签核。原研究文档和README仅补入口链接，不改已确认产品决策、ADR或运行时门禁。
- T0.13只读清单确认本机Resolve.exe文件/产品版本21.0.0.20（注册表21.0.00020），实际执行FFmpeg/ffprobe版本命令得到2026-01-29-git-c898ddb8fe-full_build-www.gyan.dev。两工具位于C:/App/ffmpeg/bin且不在PATH。Free/Studio、GPU与启动可用性未知；剪映/CapCut/PR在限定安装范围未检出，不能断言整机不存在。仓库尚无可导入交付工程/真实媒体fixture，本轮未启动GUI、创建项目或导入文件；下一步可用自生成媒体先做Resolve真实导入。
- 本轮仅文档/模板与只读来源、软件核对，无业务源码、依赖、测试或schema变化，未重跑整仓/数据库来增加测试计数。1523项根检查与1705累计不同测试保持上一轮证据，不声称本轮重新验收。文档本地链接/diff检查通过；不留整本标准PDF副本在仓库，不将个人授权材料写入Git。未新提交/推送、联系伙伴/供应商、调用真实模型或写入学习库；T0.11/T0.13及阶段0整体仍进行中。

## T0.13 合成夹具与导入阻塞本轮记录（2026-11-12）

- 新增[固定夹具生成器](../../scripts/delivery-fixture.mjs)和[6项测试](../../scripts/delivery-fixture.test.mjs)，不接生产IR/供应商。实际生成25fps、1080p红/蓝ProRes视频及48kHz单声道WAV，ffprobe核对帧数/时长/音轨/时间码与288000采样；颜色及440Hz来自生成参数，未做像素或频谱分析。三段剪辑A[25,75)→B[0,50)→A[75,125)共150帧，FCPXML连接音频跨越两个切点，EDL仅视频并明确伴随音频手工对齐。详见[六个本地产物、五个hash与验收核对表](../delivery/phase0-import-report.md)。媒体目录已忽略，不将其当作生产导出器或实际导入证明。
- Computer Use发现Resolve未运行，启动调用返回`Computer Use app approval timed out`，随后窗口列表为空；没有创建项目、导入、播放或截图。manifest保持`importAcceptance.status:not_run`、targets为空。没有改用其他方式绕过工具授权。Resolve需完成工具应用授权后再验收；Premiere/剪映仍需可操作版本，T0.13保持进行中。
- 独立复审补齐素材URL的XML转义和EDL事件总数断言，6项测试通过；媒体文档列名改为区分生成参数与探测证据。5个产物hash、生成器hash、FCPXML/EDL内容与当前源码独立核对一致，代码和TypeScript复审无遗留发现。
- 首次整仓check在server测试的API子进程20秒启动上限失败，定向构建3项立即通过；第二次启动通过，但已验证的唯一临时目录清理出现Windows `EBUSY`。仅为该清理增加3次、100ms基准间隔的有界重试，最终失败仍抛错，未改生产源码、启动时限或成功断言。server全53项coverage通过，代码/TypeScript复审确认删除范围未扩大；已清理明确属于该失败轮的临时目录。首次启动超时根因未稳定复现，不将其写成已定位修复。
- 最终`pnpm check`退出0：工具20+九包1509=1529项，9个coverage任务无缓存、全部≥95%；6个方法黄金用例和10个Agent基线通过。source-policy305文件零问题，Oxlint258代码文件；类型检查8项缓存命中、server实际执行。本轮新增6个不同测试，累计1711=根1529+历史PG额外180+历史Compose2；未重跑数据库/容器或将早期失败轮计为通过。四份当前索引/交付文档89个本地链接及diff检查通过。
- 本轮无依赖/数据库/规则包变更，无新提交、推送、伙伴联系、真实付费模型调用或学习写入。阶段0继续进行，真实编辑器导入、节点/供应商、法务产品签核、设计伙伴和远端CI/当前锁文件镜像各自保持待验收。

## 本机数据库实测（基础设施先前记录；本轮复用于 worker/认证验收）

专用 Compose 项目为 `camery-phase0`，与默认 `camery-private` 分开。固定端口 55432 被占用后，改用 Docker 分配的随机回环端口；当时确认 healthy，查询为 `127.0.0.1:32771`，并在真实数据库执行持久化测试。凭据保存在被 Git 忽略的 `deploy/.env.phase0`，不写入报告或版本库。

当时观察到容器 `healthy`；SQL 返回 PostgreSQL `16.15`、pgvector `0.8.7`，向量 `[1,2,3]` 与 `[1,2,4]` 距离为 `1`。这些数据库观测本身只证明当时数据库/扩展可用，执行引擎证据见上方 T0.6。

```sh
docker compose --project-name camery-phase0 --env-file deploy/.env.phase0 -f deploy/compose.private.yml ps
docker compose --project-name camery-phase0 --env-file deploy/.env.phase0 -f deploy/compose.private.yml port postgres 5432
docker compose --project-name camery-phase0 --env-file deploy/.env.phase0 -f deploy/compose.private.yml stop postgres
```

端口可能在重建后变化，以 `port` 输出为准。数据库保留用于后续集成测试；普通停止不删除数据卷。环境文件是本机生成的，不是新克隆仓库自带文件；新环境按 [部署说明](../../deploy/README.md) 配置。

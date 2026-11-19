# 阶段1 T1.6 剧本定稿与四账约束消费

## Revision 2 · 非认证定稿内核与实际四账交接

2026-11-19 用户指定认证相关先后补，优先 T1.6；保留已有数据/版本访问边界，不新增登录或认证 HTTP 前置。接续[四账采用与前集证明](continuity-phase1.md)。现有旧 IR 已承载 scene/beat/line 及四类 line.kind，无需为正文修改 v05/v06/v07/v08。原生纯引擎探针已确认新增正文与 text 锁可同 ChangeSet 采用，首个 line revision 即 version1/locked=true；锁定既有未锁台词则提升版本。具体实现必须补对应冻结回归，不能把候选 ID 当作已采用事件。

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与价值：将正式采用的大纲推进成可审阅、估时、导出台词本并明确锁定的完整节拍流剧本；下一集只能消费真实、唯一且新鲜的前账，避免角色提前知情或遗失人物状态/伏笔。
- 范围：正式大纲/原文引用及四账读取组合、完整剧本候选与生成适配、可定位规则问题、独立人改审阅、声音语义与范围估时、台词本、受信任人工定稿和原生 text 锁、定稿后四账及下一集交接。认证入口/新登录页按用户安排后补；真实文本模型、真人作品评分不由协议夹具冒充。
- 备选与选择：OutlineBeat 是规划，不能当 ScriptBeat 或证据；选择新局部 scene/beat/line 身份、显式 Outline refs 及固定 native 映射。现有 native lock 负责权限与锁状态，不直接写 locked=true。完整四账不裁剪，不用自由 adopted 字段或摘要代替原生证明。
- 组件：`script/screenplay` 纯契约、context/validate/timing/line-book；Node source/generation/workflow/store/review/native 组合复用既有版本、Methods/Agent/durable/预算，读取依赖 script/outline 与 continuity，禁止反向依赖 server。
- 状态与失败：source/配置不足可保存可定位问题；结构/引用/过期/未知模块定义不能强行定稿。主观钩子/模块质量必须形成明确人工决定，规则不能替真人评价。候选/审阅/正式发布/定稿锁/四账就绪分别保留，未知提交沿原 ID 恢复，不重发模型或新分配对象 ID。
- Acceptance Criteria：
  - AC-SC-1: WHEN 为一集准备剧本 THE SYSTEM SHALL 从真实 adopted head 完整投影该集正式大纲、角色和原文目录，核对精确版本与来源新鲜度；非首集只消费已采用、唯一、完整且当前有效的前账链。
  - AC-SC-2: WHEN 生成或人工修改候选 THE SYSTEM SHALL 保留完整场次与动作/台词顺序、局部身份和 Outline/原文引用；四类声音绑定实际 speaker，拒绝虚构原文、素材和已采用事件。
  - AC-SC-3: WHEN 检查首集与开场 THE SYSTEM SHALL 按版本化五模块配置定位实际节拍，并核对开场前三拍的钩子定位；配置缺失及主观判断有明确问题和人工处理记录，不伪造五项定义或自动签发质量结论。
  - AC-SC-4: WHEN 估时或导出台词本 THE SYSTEM SHALL 完整保留原台词、声音类别、speaker、delivery及顺序，按显式语速和动作/停顿配置给出估计区间，并与 TTS 实测状态明确区分。
  - AC-SC-5: WHEN 人工定稿或恢复 THE SYSTEM SHALL 绑定真实来源、人改结果、固定对象/操作身份与原生人类决定，显式应用 text 锁；并发、过期、失败或丢 ACK 不得覆盖已定稿台词、重发已完成模型任务或伪造成功。
  - AC-SC-6: WHEN 定稿剧本交给场记或下一集 THE SYSTEM SHALL 以实际正式剧本对象版本核对四账证据，保留完整账本、问题及采用证明；旧账版本变化使下游约束过期，历史采用 ACK 保留原事实。
<!-- design-authority:end -->

## 已验证复用与未知项

| 边界 | 当前事实 | 本轮约束 |
| --- | --- | --- |
| 剧本正文 | IR Episode→Scene→Beat→DialogueLine，四类声音均已存在 | Scene.script_text 与台词本从同一完整稿确定性渲染；Outline ID 不充当剧本 evidence |
| 旁白 | 旧 IR 旁白仍要求实际 speaker 且属于 scene 参与者 | 仅引用真实角色，不塞 null 或自造旁白 ID，不自动创建声音素材 |
| 定稿 | 原生显式 text lock、人类 owner/解锁门禁已存在；新增 line+lock 同 CS 首版即锁定，既有 line 单独锁定会升版 | 正文与显式锁同一次采用；四账在实际锁定后的 script head 准备。`script_locked`、`ledger_pending`、`handoff_ready`分开，前两者不能冒称整集交接就绪 |
| 五模块 | 计划/产品/现有方法包及用户 prompt 均未提供五项名称/判定定义 | 严格版本化五项配置；缺配置显式失败，不凭经验填名称；其它定稿路径先推进 |
| 估时 | Beat/Line 无实测时长字段 | 候选/定稿记录保存版本绑定的估计；语速、动作及停顿显式配置，不伪造 measured 字段 |
| 模型调用 | Methods canonical 与输入/输出上限均 2MiB，默认 HTTP request 1MiB | 原生源可读更大，但调用只用完整目标集投影/完整前账；envelope 超限失败，不截账本/正文、不默默放宽 Methods |

## 有序任务与 gate

| 任务 / owner | 文件范围 / 前置 / 风险 | 完成证据 |
| --- | --- | --- |
| 根：冻结契约、真实来源与约束读取 | screenplay/contracts/context/node/source；依赖已验证四账；L3 | AC-SC-1/2/6；真实 current/historical 区分、源版本/范围/引用/链反例 |
| 独立纯检查 | screenplay/validate 与独立 test；依赖冻结契约；L2 | AC-SC-2/3；完整稿、四声音、模块/前三拍定位与明确问题 |
| 独立估时/台词本 | screenplay/timing/line-book 与独立 test；依赖冻结契约；L2 | AC-SC-4；区间/Unicode/完整原文及导出往返；不冒称音频实测 |
| 根：不可变人审与原生定稿 | screenplay/node、显式新迁移；依赖以上；L4 | AC-SC-5；真实 PG/并发/新pool/原意图恢复/回滚/丢ACK/原生 text 锁 |
| 根：定稿与四账交接、交付 | 实际正式脚本/ledger组合、方法/Node入口、文档；L4 | AC-SC-6；实际两集正式来源与精确 CI；认证 UI 与真人质量按用户安排后补 |

TDD→窄测/types/lint→code/TypeScript/security/DB按实际风险复审→根串行 PG/覆盖率/整仓→授权 commit/push 与精确远端 CI。只有文件不相交、契约已冻结、风险≤L2的实现任务可并行；SQL、来源/发布和总体验收由根负责。回滚撤新入口并保留任何已采用剧本、锁与四账历史；用户五份脏文档和无关文件保持。

## 本轮实现与证据

已实现[内部 Node 定稿入口及使用说明](../../packages/script/SCREENPLAY_POSTGRES.md)，输入完整人工/宿主候选稿。纯入口为 `@camery/script/screenplay`，Node 入口为 `@camery/script/screenplay/node`；没有新增认证 HTTP 或自动付费生成路径。

| AC | 已实现的可观察行为 | 验证 |
| --- | --- | --- |
| AC-SC-1/6 | 实际 adopted 大纲与原文完整读取；非首集只从真实 typed native predecessor 链取得完整四账；current 与 historical 分开 | 源版本/范围/引文反例，实际上游 brief 更新后 current:false 且正式采用拒绝 |
| AC-SC-2/3 | 完整 scene/beat/line 与独立 ID；四声音/角色/原文引用；前三拍开场钩子、末拍卡点、明确配置的首集五模块 | 可定位错误不可豁免；主观钩子、模块、四账完整性逐项人审，不给自动质量结论 |
| AC-SC-4 | 显式四声音语速/停顿的估计区间、Unicode L/N 计数、安全整数；完整原文台词本与实际角色顺序 | 四声音/组合符号/emoji/边界/溢出及 8192 台词完整导出 |
| AC-SC-5 | 原候选与人改稿追加留存；授权前捕获输入；固定 scene/beat/line/操作/锁 ID；同次采用正文和 text 锁 | 原生 line v1 即锁定；八并发一份采用；实际 proof INSERT 后失败全回滚；真实 COMMIT 丢ACK后新pool恢复；首次提交丢ACK可按候选key恢复原ID |
| AC-SC-6 | 历史快照、原生请求、对象版本、正文/text 锁、实际人工审计交叉核对；当前完整写作依赖/场次事件流；实际四账正式采用后才 handoff_ready | 真实两集流程：ledger_pending→四账人审与native采用→handoff_ready→下一集完整继承与伏笔消费 |

审查发现并修复：来源/同连接异常原型泄漏、current 只看原生 head 而忽略上游变化、宿主回调修改输入、历史 snapshot 正文与对象审计脱节、跨 Outline/剧本锁序反转、JSONB 物理预算、public advisory 函数精确重载遮蔽，以及继承 REPEATABLE READ 时等待源锁后仍读取旧快照。owned transaction 显式 RC，当前 handoff 拒绝非 RC 调用者事务，历史 ACK 不伪装 current。实际双会话屏障确认 Outline 宿主采用成功、竞争剧本读以精确源变化拒绝；另一屏障确认实际 brief INSERT 后提交的新版会被等待者看到，不能用单路径八并发或 mock 隔离字符串代替。

- 冻结普通 script：92 文件、2268 项通过；覆盖率 statements 97.17%、branches 95.22%、functions 98.95%、lines 99.43%。
- 冻结完整 script PG：110 文件、2397 项（2268 普通＋129 实际 PG）通过；覆盖率 97.42%/95.50%/99.33%/99.80%，402.51s，日志 `artifacts/delivery/screenplay-script-pg-frozen.log`，SHA256 `4314679b6d4ec50515a0af8a2586f379c1c8e3f15234ee552e0e087ed746ec60`。新增 T1.6 的 8 个实际隔离库场景均通过。
- 冻结整仓 `pnpm check`：6137 项（20 工具＋6117 普通）通过，13 个 types 与13 个 coverage 均实际运行、0 缓存；978 个源文件政策0违规；6 方法/10 Agent 金标匹配。日志 `artifacts/delivery/screenplay-workspace-check-frozen.log`，SHA256 `6d678c51f1e1f4d86e932c901bc12347e7b4dd0da33a8318d4a6bf6b8ee81216`。新增公开 pure/Node 包入口导入 smoke 通过。
- code/TypeScript/security/DB 分层复审及最终 delta 均已闭合 P0–P2；46 个冻结源码/配置文件与验收时一致，用户五份脏文档未改。随后执行已授权提交/推送，精确提交的远端 CI 仍须终态全绿；远端 proof 单独保留在 ignored delivery artifacts，避免文档补写再次触发同一轮 CI。

## Revision 2 后续边界

本轮交付定稿及四账消费内核；编剧 Agent 的独立生成入口、Methods/Agent/Durable 调度和预算组合继续按已有 2MiB 调用边界接入，不把人工候选 API 冒称已完成文本生成或真人质量验收。首集五项生产语义仍由项目提供版本化配置；缺定义不会自动通过。认证 API/UI、编辑器、法务、设计伙伴及真实文本模型/真人评分按用户安排后补，现有访问保护保持。

## Revision 3 · 编剧生成与持久化调度

接续已提交且远端 CI 27 步全绿的 `7dc545948eeaa506522554c364bb33517b6bf1a9`。继续完成原 AC-SC-1/2/5/6 中的生成适配与原任务恢复，不改变 AC 语义或既有定稿记录。当前原始目标仍为 v2.1，最新用户指定的阶段1/T1.6优先顺序及认证/真人验收后补继续有效。

| 契约 | 既有行为 | 此轮新增与消费者 |
| --- | --- | --- |
| 完整正文 | 手工/宿主提交 ScreenplayDraft，逻辑上限1MiB | 模型严格 DTO→无损领域稿；保留原 DTO、真实 Method/ModelReceipt 与派生候选，不改旧 v1 candidate/preparation |
| 四账 | 领域判别联合、局部 evidence，完整前账 | provider 不支持对象联合/nullable object，故使用7个显式声明数组、全局连续order与严格空值约定；转换后仍由原演算器验证，不能补造原文、原生ID或人审 |
| 模型输入 | 没有编剧专用调用 | 完整目标集/原文目录/完整前账＋实际物理引用及分集ID；排除完整旧native事件上下文；Methods请求含指令/envelope后仍≤2MiB，超限拒绝而不裁账 |
| 模型输出/journal | Durable单条JSON≤1MiB、Methods≤2MiB | 编剧原始DTO≤512KiB，完整decision/receipt仍受既有journal总量约束；手工1MiB稿件边界不变，不隐式扩容底层协议 |
| 生成与定稿 | 旧定稿表追加，native采用另有证明 | 独立不可变generation run/result；保存模型结果不等于人审。实际来源过期仍保存已付费结果；只有当前源匹配才能原子交付旧定稿候选 |
| 恢复/预算 | 既有Methods/Agent/Durable/ledger | 固定run/task/call/PIN及reference-only task；一份预算、一次模型决策；保存/交付/finish丢ACK由原journal与原结果恢复，unknown外部调用不得自动重发 |

| 任务 / owner | 文件范围 / 依赖 / 风险 | 完成证据 |
| --- | --- | --- |
| 根：冻结契约与计划 | model-contracts / generation contracts / 本计划；前置现有定稿内核；L3 | 严格DTO与旧draft、request/journal总量及状态边界读回一致 |
| [P] 模型输出与固定方法包 | model-output.ts、method-assets.ts及独立test；依赖冻结model-contracts；L2 | 7类声明、有序/空值/四声音/完整稿转换及严格provider schema；不授予采用 |
| [P] 模型写作输入投影 | model-input.ts及独立test；依赖已冻结context与limits；L2 | 完整前账/引用不丢失，排除旧事件，大小/输入捕获反例 |
| 根：模型收据、run存储与交付 | generation.ts / generation-store.ts / 新独立迁移；依赖以上；L4 | actual source、固定profile/receipt/输出摘要、历史结果/当前状态；交付与旧candidate同事务且可恢复 |
| 根：Agent/Durable调度与预算 | generation-workflow/dispatch / 旧store同client提取；依赖以上；L4 | 原task/call/budget、实际PG并发/新pool/丢ACK/原journal恢复；禁止自动重发unknown |
| 根：交付 | public Node入口与文档；L4 | 分层复审、串行完整PG/整仓、授权commit/push、精确远端CI全绿 |

回滚撤掉新增生成入口/handler，不删除已有生成收据、候选、人审、锁或账本，不改已发布迁移字节。没有真实文本provider凭据时继续协议与实际PG验收，保留live质量未知，不以fixture签发真人/法务结论。人工授权与源新鲜性均由现有可信宿主边界提供，不新增登录前置。

### Revision 3 实现

- 固定 `screenplay.write@1.0.0` 严格 provider DTO，完整七组声明转换、原始收据与派生稿分别绑定。模型完整请求≤2MiB、原输出≤512KiB；首集缺真实五模块配置明确拒绝。前账四列及真实原文/角色/物理引用完整消费，不执行 source 指令。
- 新增显式 generation installer 和独立追加表，不改已发布定稿 migration；run≤64MiB、generated≤16MiB，progress 按两者加小凭据聚合，避免合法结果保存后无法读取。当前源锁仍先 Outline→native，再 generation→candidate；同 client 的 preparation 与 delivery 原子提交。
- 原任务引用、固定 Model/PIN/call、一次预算和一次 Agent decision。来源变化仍保存原结果并阻止首次交付；未知付费决策保留原 task、人工对账，不修补重发。模型结果是候选，人工 review、native text 锁及真实四账采用仍是独立后续步骤。
- 复审修复了未知 runner 异常泄漏、交付缓存缺少数据库凭据/原 run 交叉、prepare 撤权后仍能先调用模型、RC 并发读先见子后丢父的混合视图，以及 progress 聚合预算小于合法独立记录之和。对应反例含零预算/零 provider、跨作者、真实双连接屏障、近64MiB完整记录、原结果恢复且调用数为1。
- code/TypeScript、安全与数据库复审均已关闭 P0–P2。真实 PG 首轮 15 场景通过，包括8路并发、实际 INSERT 后回滚、实际 COMMIT 丢 ACK 新 pool、unknown 决策人工对账、真实 worker 强杀后从已提交 journal 无凭据恢复；补充的实际第二集模型消费与最终完整大门以本节最终证据为准。

本轮仍不新增认证 API/UI，不完成编辑器、真人作品评分、法务或设计伙伴签核。后续可接可信宿主真实文本模型与生产五模块配置；不能将合成 live_model 协议字段解释为真实调用或账单已验收。

### Revision 3 冻结验证

- 整仓 `pnpm check`：6375项（20工具＋6355普通）通过；13个types、13个coverage均实际执行，0缓存。1005个源文件政策0违规，6个Method/10个Agent金标匹配。script普通101文件、2506项，覆盖率97.16%/95.15%/99.02%/99.47%。日志 `artifacts/delivery/screenplay-generation-workspace-check.log`，SHA256 `7a02689774eed8b2096eb3513f142f61451800c0c0e0c206d2b9a8422e76dc78`。
- 完整script PG：119文件、2642项（2506普通＋136实际PG）通过，470.56s；覆盖率97.40%/95.43%/99.38%/99.81%。包括本轮15项隔离库场景，以及真实首集四账正式采用→第二集模型完整输入/原始收据/四列保留→候选交付→独立人审与锁定的组合。日志 `artifacts/delivery/screenplay-generation-script-pg.log`，SHA256 `5f25d77730bf39ee06025231a27fdea92a06ac4610d4506c60733d00e023a1bb`。
- 独立types/严格typed lint与pure/Node导出smoke通过；28个源码/配置文件冻结，五份用户脏文档与原定稿SQL字节保持。随后执行已授权的30文件commit/push；精确新提交远端CI仍须终态全绿，最终proof保存在ignored delivery artifacts，避免验收后补写文档再次触发CI。

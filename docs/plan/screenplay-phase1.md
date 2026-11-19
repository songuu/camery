# 阶段1 T1.6 剧本定稿与四账约束消费

## Revision 1 · 非认证领域与工作流

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
| 根：生成、不可变人审、durable/预算与原生定稿 | screenplay/node、显式新迁移/角色；依赖以上；L4 | AC-SC-5；真实 PG/并发/新pool/原任务恢复/回滚/丢ACK/原生 text 锁 |
| 根：定稿与四账交接、交付 | 实际正式脚本/ledger组合、方法/Node入口、文档；L4 | AC-SC-6；实际两集正式来源与精确 CI；认证 UI 与真人质量按用户安排后补 |

TDD→窄测/types/lint→code/TypeScript/security/DB按实际风险复审→根串行 PG/覆盖率/整仓→授权 commit/push 与精确远端 CI。只有文件不相交、契约已冻结、风险≤L2的实现任务可并行；SQL、来源/发布和总体验收由根负责。回滚撤新入口并保留任何已采用剧本、锁与四账历史；用户五份脏文档和无关文件保持。

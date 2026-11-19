# 阶段1 T1.7 合规预审

2026-11-19：接续 `093feb6851aa7b2be19dc7ab7dfb4512e35ed114` 的实际27步全绿CI。前一目标回合是已验证进展：T1.6生成/定稿/四账消费完成本轮工程交付，认证入口、真实文本模型及人工验收按用户安排后补。继续v2.1阶段1，原总目标不缩减。

<!-- design-authority:start -->
## Design Authority（shadow）

- 问题与价值：在继续制作前定位剧本风险文字，并结合可配置字面规则和模型分类提供可复核的预审建议，避免把“没有命中”当作法律许可或遗漏正文当作通过。
- 范围：新独立compliance模块；完整剧本文本投影/精确UTF-16位置、版本化建议规则、分批完整模型分类、原ModelReceipt及覆盖范围、实际剧本来源/当前性、不可变持久结果、人类逐项处理、Durable预算与恢复、可复现评估。来源是实际已保存的T1.6原候选或人改稿；不能由请求自报采用/审阅。认证HTTP/UI、规则法律生效、真实法务签核与真实模型召回属于用户明确后补项，不以夹具替代。
- 备选：单次整稿输出会超出Methods2MiB和Durable1MiB，不能裁剪正文或仅让模型返回风险列表而推断其余已查。选择稳定完整文本片段、每批最多32片段且片段×类别最多256条显式判定、独立固定任务与预算；模型每对必须返回flag/not_flagged/uncertain及理由。缺批、漏分类、未知结果保持未完成。
- 组件与消费者：纯contracts/boundary/corpus/rules/classification；Node固定原创方法、source/store/workflow/dispatch/review；依赖script公开读口及现有Methods/Agent/Durable/Budget，禁止script反向依赖compliance或写入已有定稿/锁/四账。新迁移显式安装并保留旧历史，未签核法律材料只作参考，不预置实际法律规则或强制发布闸门。
- 状态与错误：所有规则包固定unverified_configuration，所有输出固定advisory且requiresHumanReview；“not_flagged”只是该模型对该对文本/类别的判断，不等于合法或全量通过。原稿/规则/模型版本严格绑定；旧源上的已完成结果保留，首次调用检查新鲜度；原task/call及付费unknown不得自动换身份重发。文字从不执行，URL只保存参考、不任意抓取。
- Acceptance Criteria：
  - AC-CP-1: WHEN 开始预审 THE SYSTEM SHALL 从实际持久剧本读取完整原候选或指定人改稿，固定来源、规则和模型版本；缺失/过期/越权拒绝首次新调用，历史恢复不伪造current。
  - AC-CP-2: WHEN 检查配置字面规则 THE SYSTEM SHALL 无截断地返回全部命中及准确原文UTF-16区间，保留四类声音和结构路径；不运行用户正则/代码、不做改变字符位置的隐式归一化。
  - AC-CP-3: WHEN 调用模型分类 THE SYSTEM SHALL 对完整稳定分批和全部配置类别取得显式判定，校验原文证据、唯一/完整覆盖及原收据；缺批/漏判/未知均不能被解释为通过。
  - AC-CP-4: WHEN 人工处理或读取预审 THE SYSTEM SHALL 保留独立不可变决定及逐项理由，区分规则命中、模型判断和待确认；输出不能批准法律生效、发行或替换已定稿文字。
  - AC-CP-5: WHEN 任务失败、并发、丢ACK或进程终止 THE SYSTEM SHALL 使用原任务/预算/收据恢复，保留已完成付费输出；实际源改变阻止新调用与当前结果消费，不能自动repair调用。
  - AC-CP-6: WHEN 评估预审 THE SYSTEM SHALL 用明确版本的人工标签和完整覆盖分别计算召回/精确率及未完成项，不把合成回放指标称为生产召回或法务签核。
<!-- design-authority:end -->

| 契约 | 现状 | 新增与一致性 |
| --- | --- | --- |
| 法律材料 | T0.11证据索引待签核，未激活 | 不改原法务材料；仅显式建议配置，无自动法律结论 |
| 剧本 | 完整Draft、人改审阅、当前/历史来源与text锁 | 单向只读同连接来源；原文/全部叙事字段形成稳定片段，正文不改 |
| 模型 | Methods2MiB、decision1MiB | 每批≤256判定、输出≤512KiB；完整覆盖聚合到独立持久记录 |
| 预算/恢复 | 既有单阶段durable与PG预算 | 每批固定身份和单次预算，整run预检总shares；原journal恢复，不重发unknown |

| 有序任务 / owner | 文件集合 / 前置 / 风险 | 完成证据 |
| --- | --- | --- |
| 根：契约与全量文本/来源 | compliance contracts/boundary/corpus、script同client公开读口；T1.6已交付；L3 | AC-CP-1/2完整字段/四声音/范围/源竞态 |
| [P] 配置规则引擎 | compliance rules.ts及独立test；冻结契约；L2 | AC-CP-2完整命中/重叠/Unicode/无正则及容量反例 |
| [P] 分类契约与方法包 | classification.ts、node/method-assets.ts及独立test；冻结契约；L2 | AC-CP-3矩阵完整/证据/空值/稳定分批和provider schema |
| 根：实际来源、持久记录、人审 | compliance node source/store/migrate/review、新SQL；前述核心；L4 | AC-CP-1/4/5实际PG来源、并发/丢ACK/回滚/同client/不改锁 |
| 根：批任务预算/恢复与评估 | compliance node workflow/dispatch/generation/evaluation；持久核心；L4 | AC-CP-3/5/6完整多批、原任务/实际预算、SIGKILL/unknown/人工标签指标 |
| 根：完整交付 | 导出/说明/新包workspace锁/CI接线；前述全部；L4 | code/TS/security/DB复审、串行PG/覆盖率/整仓、授权commit/push和精确CI全绿 |

风险/回滚：只撤新增入口与任务注册，保留所有预审/人审/预算和原始剧本，不修改或删除任何旧迁移。无真实文本凭据/人工标签时完成协议与实际PG验证，生产95%召回保持未知；不激活未经法务/产品核实的规则。全量PG、覆盖率和整仓均串行。

计划内联核对：无占位成功条件；AC只在本区定义；认证与法律签核按用户指示后补；模型分类/实际来源/恢复/评估全部保留，不能以纯字符串匹配替代完整T1.7。

## Revision 2 · 完整预审材料与已锁定稿

AC语义保持。实际定稿渲染还会插入台词本的真实说话者姓名，因此来源快照追加只读speakers目录，片段补充speaker_name；不是只扫台词正文而遗漏渲染姓名。path相对逻辑视图`{...draft,speakers}`，字段与原文UTF-16仍不归一化。目录只取实际候选/人改台词本的已用说话者并核完整身份，不接受请求自造名字。

已锁定稿可显式绑定真实native adoption与receipt，再用现有current handoff核对原正文/text锁/写作依赖；不能把旧preparation的native源已过期直接当成当前。新批次调用仍检查当前；历史Source/模型结果保留，不把Model分类升级为法务状态。

## Revision 3 · 持久预检与恢复

已实现独立不可变run、原始批次结果、逐项人工处理与完整覆盖报告。每批固定task/call，首次调用前检查实际来源、scan权限及原作者；factory await之后再次检查。原paid decision的缓存尾部只保存原DTO/收据，unknown必须在原任务上人工对账。完整报告分页重放全部批次及判定矩阵，不根据零命中推断合规。已锁定稿明确绑定实际native receipt；来源变化后保留历史结果，首次完整报告与人审拒绝继续使用旧源。

原始provider顺序及outputDigest保持；normalized分类和findings只是派生值。人工决定必须处理目标的全部finding，固定原结果/作者/时点，不能覆盖或变成法律许可。`readReview`提供字面规则/模型批次的只读历史；当前性通过`isCurrent`单独取得。

AC-CP-1/4/5实际PG新增7例，与原T1.6夹具共22例通过：实际人改/锁定稿、8路并发、SQL nullable CHECK和跨scope FK、INSERT后回滚、实际COMMIT后丢ACK、新pool、paid unknown对账、实际SIGKILL和原budget/task恢复。正文及锁的前后实际版本对比保持，外部模型传输明确是合成协议，不冒称真实推理/账单。源码/类型/安全/数据库最终复审均无P0–P2。

验证记录：

| 门槛 | 实际结果 | 日志 SHA-256 |
| --- | --- | --- |
| 普通coverage | 15文件424项；97.93/95.41/100/100% | `073d52c1002ddf83dd89620b11c557398db8c24317baa9f9372dad07f1925fad` |
| 独立compliance实际PG coverage | 16文件446项，含424普通与22 PG；98.19/96.41/100/100% | `22961ac6316487d1037bcadeea5f8ac0d27e46517a3781ce173c02db03370224` |
| script完整实际PG回归 | 119文件2651项（含2508普通）；97.42/95.46/99.38/99.81% | `e7d864c83ccbcd897af3b779dd4232baf73c88f2dfdcf6b45bc3b0ddbb70c32e` |
| 整仓pnpm check | 6801=20工具+6781普通；1056文件策略零问题，14包类型检查（4实际/10缓存）、14包coverage均实际执行，6方法/10 Agent基线匹配 | `e5fc7ead7f18e6da4cc65969073421738e8e052cd57193e27c0288f561204396` |

普通与PG分别运行，不重复相加。根命令`pnpm test:compliance:local -- --coverage`复用实际script PG源夹具；CI新增同等独立步骤，原检查不删除。既有script完整PG及整仓门槛已串行通过；55个源码/配置输入冻结并核对，旧剧本迁移SHA保持，用户五份文档改动未动且不纳入提交。随后按授权提交推送，远端镜像/私有API组合仍须以精确提交的最终CI为准；提交前不提前声称该远端结论。

安装、宿主API与限制见[compliance说明](../../packages/compliance/README.md)。独立实际规则配置/标签可以后续补入，当前无默认生产法务规则、认证HTTP/UI或真实召回95%结论。编辑器验收、法务签核与设计伙伴确认按用户安排后补；阶段1其余任务继续保留。

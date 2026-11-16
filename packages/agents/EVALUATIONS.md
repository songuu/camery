# Agent 行为评测基线

[ADR-013](../../docs/adr/013-durable-agent-runtime.md) 要求报告任务完成率、回路次数、人工升级率和成本。本包使用固定合成案例运行实际 AgentRuntime、工具注册表与 ReviewLoop，记录指标及摘要，并逐项比较 [基线文件](evals/baseline.json)。这验证宿主行为契约，不代表真实 LLM 的推理质量、抗提示注入能力、人工审片结果或真实账单。

```sh
pnpm test:agents:evals
pnpm check
```

根检查会执行行为基线与既有章节方法黄金集。正常检查只读基线，缺失、格式错误、oracle/版本/计数/成本/轨迹摘要变化均明确失败，不自动接受新结果。

## 案例与测量范围

| 案例 | 验证 |
|---|---|
| candidate-tool | 白名单工具提出候选，回放不重复 handler |
| source-injection | 来源指令留在不可信数据区，未知工具用量保留 null |
| tool-denied | 未注册工具被拒绝 |
| object-scope | 工具输入对象越界被拒绝 |
| budget-cutoff | 预算不足时不启动决策或工具 |
| paid-without-approval | 未获得宿主审批，不执行付费 handler |
| question-answer | 只接收显式选项回答，作为不可信观察传给后续决策 |
| review-escalation | 首轮问题、显式修订、第二轮问题，升级开放 Question |
| independent-review | 独立审查身份和明确通过，仅产生 reviewed_candidate |
| chapter-research | 实际磁盘角色、章节方法包和研究工具，对照预先写定的 UTF-16 边界 oracle |

每个案例创建新注册表和内存步骤日志，执行两次，核对输入、步骤位置、报告及 effect/gate 计数一致；再用全新日志独立复跑与基线比较。内存回放不代替 PostgreSQL 租约、杀进程和事务验收，后者由单独的数据库命令执行。章节案例只测研究运行时范围，完整制片→研究→人工闸门已有其他数据库用例。

输出 oracle 在执行前声明。负向回归会改变实际成功产物，确认评测仍失败；没有从实际返回值反算期望值。来源注入案例使用脚本化合成决策，验证上下文边界与权限检查，不声称验证真实模型抵抗攻击的能力。

## 指标口径

- `passed` 是所有案例断言通过；预期拒绝可以通过评测，但不计入任务完成。
- `completion.completed/total` 的分母为全部案例；分子要求候选通过输出/状态断言，且没有审查或审查已明确通过。输出错误、blocked、revision_required、needs_human 都不算完成。无法取得有效执行证据的案例计入 `unknown`。
- `decisionCycles` 统计决策 span，`toolCalls` 统计工具尝试 span（包括未获审批的拒绝），`questions` 统计已回答的运行时 Question，`reviewRounds` 统计实际纯域审查轮次。这些计数不等于真实供应商请求数。
- `humanEscalation` 统计两轮失败后 needs_human；`humanAssistance` 另包含已回答的运行时 Question。开放升级 Question 不生成答案，不采用 IR。
- `tokens/costMicros` 是报告的已知总用量，任何部分未知则总量为 null。`knownTokens/knownCostMicros` 保留已知部分下限；模型回执的部分 token 也保留。`chargedTokens/chargedCostMicros` 是运行时预算占用，含未知用量的保守预留，不作为真实费用。执行证据缺失时占用总量也为 null。
- 聚合量使用 BigInt 并输出十进制字符串，避免跨案例求和超过 JavaScript 安全整数后丢精度。币种由套件固定，混币结果拒绝；模型回执与 span 用量使用运行时同一计量规则核对，live 模型证据不纳入本合成套件。

当前基线为 10 例，完成 5/10、人工升级 1/10、人工辅助 2/10，15 个决策、6 次工具尝试、1 个已答 Question、3 轮审查。合成总 token/费用均未知，已知下限为 21 token / 9 CNY 微币，预算占用 25 token / 14 CNY 微币。混合正向和预期拒绝案例的比例不是生产完成率或质量得分。

## 更新与接口

只有明确修改案例、角色、方法或运行时契约后，才主动运行：

```sh
pnpm --filter @camery/agents eval:baseline
```

该命令复用 methods 的受限文件读取与原子基线替换机制，只写包内 evals/baseline.json。检查完整差异和指标原因后，再单独运行只读检查。基线不因测试失败自动重写，写文件不等于已经审阅并接受行为变化。

纯域入口 `runAgentEvaluations(suite, execute)` 接受受信宿主执行回调，返回冻结报告；它不是代码沙箱或外部调用授权层。每例执行/结果错误记录固定安全码并继续下一例，未知消耗不会补零。`validateAgentEvaluationReport` 核对结构、摘要、计数、标志和汇总；`assertAgentEvaluationBaseline` 要求当前与既有通过报告精确一致。Node 入口 `runAgentBehaviorEvaluations(prior?)` 提供上述固定案例，既有基线在首次等待前验证并捕获。

报告保存 role pin、预声明断言、计数、整数计量与输出/轨迹摘要，不保存来源、产物正文、审查正文或异常消息。它来自受信宿主观察，不是远程签名证明。真实模型质量、账单核对、端到端服务/界面和媒体证据仍需后续验收。

# 项目预算账本

`@camery/agents/node` 导出 migrateAgents 和 PostgresBudgetLedger，复用宿主提供的 pg Pool；库不创建或关闭 Pool，不在导入时执行 DDL。先显式运行 migrateDurable，再由迁移身份运行 migrateAgents。原 migrateAgentBudgets 保留为同一完整迁移器的别名。固定 camery_agents schema，迁移以 advisory transaction lock、严格版本前缀和文件 checksum 验证重复执行与历史一致性。SQL 文件固定 LF，已应用文件不修改：0001 为预算账本、0002 为协作/审查/outbox、0003 追加闸门约束与队列轮转索引。协作接口见 [COLLABORATION.md](COLLABORATION.md)。

```sh
pnpm test:agents:local --coverage
```

复用本机阶段 0 专用 PostgreSQL，或注入 CAMERY_TEST_DATABASE_URL 运行包内 test:integration --coverage。无数据库的 pnpm check 只计纯域/宿主接口和文件读取器覆盖率，明确排除 node/budgets.ts、node/collaboration-store.ts 和 node/reviews.ts；CI 的真实数据库命令计算全部源码并执行四项 ≥95% 门槛。不能用单元覆盖率代替存储验收。两个命令应顺序执行，避免竞争同一覆盖率目录。

## 分配

createProject(definition, actorId) 创建不可变的租户/项目预算：currency 为三位币种代码，limits 包含 steps/tokens/costMicros 安全非负整数。相同内容重复创建幂等，改变额度或币种拒绝；本轮未实现项目追加预算。actorId 来自受信宿主，不是本库认证结果。

allocate({tenantId,projectId,taskId,allocationId,agent,budget}) 给实际 durable 任务预留完整份额。Agent 必须为精确 pin，budget 为 maxSteps/maxTokens/maxCostMicros/currency。任务跨项目也只能有一个 allocation；同分配 ID 不能给别的任务。实际任务指纹从数据库的租户、任务、工作流版本、输入、maxAttempts 和初始 enqueue_at 生成，不采信请求自报指纹或可变 available_at/fence。

事务统一锁 durable task → project → allocation，锁内汇总 held 完整预留与 settled 实际用量，再决定是否分配。只接受 queued/running 且尚未出现任何 external 步骤的新分配，不给已发生外部调用补写事前授权。相同完整请求/任务指纹重试返回原分配，不追加事件或再占份额。

项目余额用 PostgreSQL numeric 汇总与 BigInt 比较，累计超过 JS 安全整数也不转浮点。project(key) 返回 definition、used、remaining、debt；汇总量为十进制整数字符串。主外键和所有查询均包含租户，审计事件随分配/结算事务一同提交。

createBudgetedAgentWorkflow({name,version,runtime,agent,ledger,planFor}) 将分配放在 replayable durable 步骤中。planFor 依据实际 context.task 返回授权项目/对象/单写者、taskBudget、allocationId 与 allocationBudget；最终 RunBinding.projectAllocation 使用数据库返回份额。等待计划前已复制冻结来源。步骤确认丢失后会重新查询幂等分配，成功缓存后则不再调用分配器。该接口不启动常驻 worker，也不自动采用内容。

配置持久化 QuestionInbox 的运行时还要求 planFor 提供 logicalTaskId，宿主可从协作 store.assignment(context.task) 取得。逻辑身份用于收件箱范围；分配 taskId 仍为实际 durable 物理任务，不能把两者互换。预算额度在人工等待、进程中断与答复恢复期间保持 held，终态后仍需明确确认结算。

## 保留与确认结算

held 份额没有 TTL，不因等待、worker 中断、失败、取消、task terminal 或缺 usage 自动返还。未知外部结果和未确认账单均继续保留。模型 quote 和 AgentRunReport.charged 不能作为真实费用已知的证据。

settleConfirmed({tenantId,projectId,taskId,allocationId,actorId,receiptId,reference,actual}) 是内部受信宿主操作。actual 必须明确提供 steps/tokens/costMicros 安全非负整数，不能为 null；单位继承项目币种。宿主须核对完整步骤日志、所有尝试和实际供应商记录，reference 指向该确认依据；数据库不会联网核实这份依据，不应直接暴露为客户端退款接口。

结算须在 DurableWorker.runOne 返回并已提交终态后进行；在同一 workflow 尾部 step 调用会因 task 仍 running 而拒绝。账本还检查没有 running/unknown 的 external 步骤；已取消但未知的调用仍需先对账。completed 且 usage 缺失不证明账单已知，即使外部步骤已对账，仍不能省略实际费用确认。

相同完整结算请求幂等；不同 actor/receipt/actual/reference 不能覆盖已结算记录，同项目 receiptId 不能重复用于另一分配。结算与审计原子提交，失败完整回滚。已确认实际量超原份额/项目上限仍照实入账，形成 debt 并阻止新分配；不能通过拒绝超支记录来丢弃已发生费用。后续账单更正、追加预算、对账自动化尚待独立实现。

## 已验证与边界

[真实数据库验收](test/budget.integration.test.ts) 覆盖并发最后份额、跨租户/项目/币种/Agent/任务指纹、未知取消保留、明确结算与收据幂等、债务超过安全整数、触发器异常/零行写入时回滚、模型工作流重启，以及分配提交后丢失日志确认时仅保留一份额度。[故障单元测试](test/budget-node.test.ts) 检查未知迁移/改 checksum、连接/回滚失败与损坏数据拒绝。

这保证事务配额不重复分配，不证明真实供应商一定遵守 quote 或远端费用上限。价格、tokenizer、远端限额、真实账单核实、会话/RBAC、运行角色最小权限、备份和大项目性能仍由宿主/后续阶段验收。库没有付款或实际模型外呼。

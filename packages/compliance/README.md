# 剧本预检

`@camery/compliance` 提供完整剧本的建议规则匹配、模型分类、独立人工处理和指标计算。规则包必须显式传入并固定版本；不会激活法律材料或改变剧本、定稿锁、四账与发行状态。

- 纯入口：`projectScreenplayCorpus`、`validatePolicy`、`checkLiteralRules`、`createClassificationBatches`、`validateClassification`、`classificationFindings`。
- Node 入口：`migrateCompliance`、`PostgresPrecheckStore`、`enqueuePrecheckBatch`、`createPrecheckWorkflow`、`generateClassification`、`evaluatePrecheck`。

安装顺序为现有剧本迁移之后显式执行 `migrateCompliance(pool)`；构造 store 不安装迁移。运行宿主提供同一人类身份、项目范围、同步权限回调和真实 screenplay/outline repositories。认证 HTTP/UI 接线后补，JSON 参数与摘要不能代替宿主授权。

扫描先以 `start({key, source, policy, execution}, host)` 固定实际已保存原候选或指定人改稿。已锁定稿在 source 中另行绑定真实 native change 与 adoption receipt；旧准备稿不会自动升级为已定稿来源。每批固定 task/call 和预算，先创建项目预算，再逐批 `enqueuePrecheckBatch`，由宿主注册 workflow。缺批或分类矩阵缺项时 `complete` 拒绝生成完整报告。完成报告仍是建议，必须人工复核。

`read` 返回历史完整性、批次引用及完整报告；`isCurrent` 单独检查实际来源。`readBatch` 返回原始 DTO、派生分类、原 ModelReceipt 和该批人审；`readReview` 可读取字面规则或模型批次的人审。`review` 必须为指定结果的全部 finding 提供唯一处理及理由；决定不可覆盖。来源变化后已完成付费输出可保存和读取，首次新调用、首次完整报告及首次人审要求来源当前。unknown 留在原 Durable 任务等待明确对账，不能换身份补调。

投影保留标题、场景首尾、动作、四种声音、delivery、来源说明/引文、钩子、连续性声明/证据和真实说话者姓名。位置为原文 UTF-16 区间，path 相对 `{...draft, speakers}`。字面匹配只支持 exact 或 ASCII 不区分大小写；参考 URL 仅保存，不抓取。

限制：规则包 256 KiB，完整语料 8 MiB，字面报告 16 MiB；每批最多 32 个片段、256 个片段/类别判定，完整模型请求 2 MiB、原始输出 512 KiB。超额明确拒绝，不返回截断的“完整”结果。整 run 在调用前检查全部批次的请求体和预算份额。

`evaluatePrecheck` 绑定版本化案例、来源/规则摘要及标签，分别统计确认召回、分诊召回、精确率、缺失与不确定项。合成协议测试不证明生产质量；真实标签、模型质量和法务签核待补，`productionRecallVerified` 始终为 false。

验证：`pnpm --filter @camery/compliance test:coverage`；`pnpm test:compliance:local -- --coverage` 复用实际剧本 PostgreSQL 夹具，包含真实来源、并发、SQL 约束、丢 ACK、新连接池、unknown 对账及 SIGKILL 恢复。协议传输使用明确的合成输出，不调用外部模型。CI 对普通门槛和实际 PG 分别执行。

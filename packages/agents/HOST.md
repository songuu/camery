# 任务树调度宿主

AgentDispatchHost 是受信应用可嵌入的轮询组件，将已有协作 store、outbox 和 DurableWorker 接在一起。它固定一个 tenant/project/tree，不自行规划任务、选择角色/模型、加载脚本或授予工具权限。树和路线先由宿主授权并 createTree，工作流 handler 由宿主明确注册。

```ts
import { AgentDispatchHost } from '@camery/agents';
import { DurableWorker } from '@camery/durable';

const worker = new DurableWorker(durable);
worker.register(authorizedWorkflow);
const host = new AgentDispatchHost({
  tree: { tenantId, projectId, treeId },
  workerId: 'internal-worker-1',
  collaboration,
  durable,
  worker,
  pollIntervalMs: 1000,
  maxTasksPerTick: 25,
  maxExecutionsPerTick: 10,
  outboxLimit: 100,
});
const controller = new AbortController();
const result = await host.run(controller.signal);
```

示例变量均来自既有受信宿主配置；不从来源正文取得租户、路线或权限。组件不创建/关闭 Pool，不自动迁移，不安装系统服务或启动容器。具体的[章节 worker 与最小身份](../server/README.md)及[同镜像 Compose](../../deploy/README.md)已另行接入；通用多树服务仍待后续实现。

## 每轮行为

tick(signal?) 执行一次有界轮次：读取并验证树、同步部分非终态任务、为显式依赖成功的任务 queueReady、投递本树 outbox、按精确物理任务 ID 执行 worker，再从实际日志同步和读取最终快照。首轮固定定义摘要；后续定义、逻辑任务不可变字段、物理 hash ID、路线、输入或重试上限变化均拒绝。所有路线必须已在 worker 中注册。

同项目 outbox 的读取轮转可以更新选择提示，但宿主只投递本树物理 ID 的命令，不投递其他树的 enqueue/signal。任务执行使用 DurableWorker.runTask，完全不回退 runOne 的租户队列；目标不存在、未到期、等待人工、仍被租用或需对账时返回空闲，其他任务不受影响。

同步与执行扫描分别轮转。maxTasksPerTick 限制每类扫描检查数（1–1000），maxExecutionsPerTick 限制实际尝试数（1–100）；执行预算小于扫描预算时，从最后实际检查位置后继续，不跳过未访问尾部。outboxLimit 为 1–100，pollIntervalMs 为 50–60000。树自身仍受既有 1000 任务限制；大树性能、数据库往返与生产吞吐未验收。

结果只含树身份、逻辑/物理任务 ID、状态与 revision、队列/投递结果及阻塞身份，不含输入/产物正文或原始异常。

- active：还有依赖已满足的 queued 工作。
- waiting：剩余工作等待人工、定时、其他租约或外部对账。
- complete：全部逻辑任务 succeeded；仍是候选结果，不采用 IR。
- blocked：失败/取消及其依赖已阻断全部剩余分支。blockedTaskIds 是派生诊断，不伪造未执行子任务的失败/取消状态。独立可执行分支会先继续运行。

relay.pending 原样返回，失败命令留在数据库；complete 描述逻辑树状态，不代表所有历史 outbox 已确认。后续 tick 或新宿主可继续幂等投递/补 ACK。

## 轮询与停止

run(signal) 持续执行 tick 并轮询等待，complete/blocked 时返回相应 reason，收到停止信号则返回 aborted。一个实例拒绝并发 tick/run；多个实例可协作同一树，互斥与恢复由 PostgreSQL 租约、fence、幂等 outbox 和步骤日志提供。

停止信号不等于业务取消：它阻止后续领取和轮询，已经开始的目标执行按 DurableWorker 的时限与租约完成，宿主等待它返回。需要取消任务时，受信宿主另行调用 durable.cancel；未知外部结果仍须对账。停止期间持久化的 Question 和回答不会丢弃，新宿主可接着等待或投递。

host 捕获配置与能力函数，工作流检查只接受同步 true；误传 Promise/thenable 被拒绝并观察迟到拒绝。宿主错误统一为安全码，底层异常消息不进入结果。

## 已验证与剩余范围

[宿主数据库验收](test/host.integration.test.ts) 实际执行制作/研究任务分支、两个并发宿主、同租户较早无关任务隔离，以及带项目预算的 Question 等待→停止→人工回答→新宿主恢复。底层 [精确领取验收](../durable/test/target-claim.integration.test.ts) 覆盖竞争唯一租约、目标 external 过期对账、不扫描其他过期任务、失败预算、timer、stale fence 和两种 worker 入口之间的缓存恢复。既有真实杀进程验收继续覆盖共享执行核心。

本组件不提供正式认证、前端、任意多树服务管理、通用制片规划或真实模型质量证明。接口是内部授权之后的执行协调，不替代 T0.10 或部署验收。

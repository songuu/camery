# @camery/durable · PostgreSQL 持久化执行

T0.6 的内部执行库，按 ADR-003/005 使用 PostgreSQL 16、Drizzle 和 `pg`。包含任务、顺序步骤日志、租约与单调 fence、重试预算、持久定时、人工闸门、取消、未知外部结果对账及追加事件。它不启动常驻 worker 服务，不实现业务认证或 Agent 调度。

## 运行与验证

```sh
pnpm --filter @camery/durable test
pnpm --filter @camery/durable typecheck
pnpm test:durable:local --coverage
```

第三条命令使用已有 `camery-phase0` Compose 项目、被 Git 忽略的 `deploy/.env.phase0` 和动态回环端口；不会打印数据库 URL。没有该本机环境时，先按 [基础设施说明](../../deploy/README.md) 准备专用测试 PostgreSQL，再通过环境注入 `CAMERY_TEST_DATABASE_URL`：

```sh
pnpm --filter @camery/durable test:integration --coverage
```

集成测试缺少 URL 会明确失败，不自动跳过。测试在 `camery_durable` schema 创建真实表并保留随机租户的测试记录，不删除其他 schema 或清空共享库；应使用专用测试库。CI 配置了 PostgreSQL 16 服务并执行同一集成命令；远端结果尚未验证。

`pnpm check` 的无数据库检查不包含存储/迁移覆盖率；真实数据库配置会包含全部源码与单元/集成测试，并对语句、分支、函数、行统一执行 ≥95% 门槛。不能用无数据库测试通过代替真实存储验收。

## 宿主接入

```ts
import { Pool } from 'pg';
import { migrateDurable, PostgresDurableStore, DurableWorker } from '@camery/durable';

const pool = new Pool({ connectionString: process.env.CAMERY_DATABASE_URL });
// 用部署迁移身份显式执行；模块导入不会自动修改数据库。
await migrateDurable(pool);
const store = new PostgresDurableStore(pool);
const worker = new DurableWorker(store);
worker.register({
  name: 'example', version: 1,
  async run(input, ctx) {
    const prepared = await ctx.step('prepare', { kind: 'replayable', input }, async ({ input }) => input);
    const approved = await ctx.waitForSignal('approve', { prepared });
    return approved;
  },
});
await store.enqueue({ tenantId: 'trusted-tenant', taskId: 'host-generated-task', workflow: 'example',
  version: 1, input: { text: 'review' }, maxAttempts: 3, availableAt: new Date() });
await worker.runOne('trusted-tenant', 'worker-1');
```

宿主应分别配置迁移角色与最小权限运行角色；示例复用 Pool 仅展示调用关系，不代表生产权限配置已完成。库不会创建或关闭调用方传入的 Pool。迁移使用事务级 advisory lock、版本与 checksum，重复执行不重建表，已应用脚本变化或未知迁移版本会拒绝继续。

`runOne` 领取一个任务并返回数据库中的最新 Task；没有可领取任务返回 null。调度循环、进程管理和背压由宿主负责。任务按租户领取；所有查询同时约束 tenantId/taskId。数据库只接受内部受信调用，**tenantId、actorId 必须来自认证后的服务上下文，不能直接采用请求自报身份**。当前没有 RLS、会话、RBAC 或面向公网的端点，T0.10 仍需独立验收。

`runTask({tenantId,taskId}, workerId)` 只领取指定任务，供 [Agent 任务树宿主](../agents/HOST.md) 等已明确分配范围的调用方使用。目标不可领取返回 null，绝不回退租户队列；`hasWorkflow(name,version)` 可在调度前核对精确注册版本。PostgresDurableStore.claimTask 与原 claim 共用领取、租约过期、未知结果、timer、重试预算与 fence 逻辑，选择条件始终固定目标身份；不会顺便恢复其他任务。自定义 DurableStore 可以暂不实现可选 claimTask，但 runTask 会明确返回 STORE_CAPABILITY 错误而非调用 claim。

两种 worker 入口共用同一执行核心，允许在保持工作流版本和步骤历史一致时交替恢复。runTask 等待前捕获身份，核对领取记录的 task/lease/owner/fence/status 并分离输入；领取回执不匹配时拒绝执行 handler。本轮没有新增数据库迁移。

工作流 context.task 是从实际领取记录捕获并冻结的 tenantId/taskId，供 [Agent 运行时](../agents/README.md) 绑定执行范围；来源 input 中的同名字段不改变它。该内部身份不替代应用认证和对象权限检查。

stepIdempotencyKey(taskKey, stepKey) 导出运行时共用的稳定身份算法，供 Agent 在不重新执行外部调用时核对缓存/对账回执。它只使用已验证的租户、任务与步骤键，格式保持原 camery_ + SHA-256；不是审批令牌或身份认证。

## 步骤与恢复规则

- 相同 tenantId/taskId 只能重复提交完全相同的工作流版本、输入、重试预算和初始时间，其他内容返回 `TASK_CONFLICT`。工作流名称/版本必须注册；逻辑变化需新版本。
- 每次执行从 handler 开头重放，已完成步骤直接返回保存结果；步骤身份、顺序、类型、输入指纹、幂等键变化会拒绝。不可把付费调用或业务写入放在 handler 的步骤外。
- 每个步骤都必须 await，且同一工作流不能并发启动多个步骤。库检测重复、并行、未等待及步数超限，并观察操作 Promise，避免处理器误用产生未处理拒绝退出进程。任一 context 操作拒绝都会中止本次执行，即使 handler 捕获或忽略该拒绝，也不能将本次任务标记成功；需要恢复时从持久化步骤重试。
- `replayable` 仅用于无副作用或宿主已证明可安全重放的操作。worker 中断、步骤异常或非法 JSON 可按预算重试；已完成结果保留。`maxAttempts` 是自动失败预算，内部 failure_count 统计失败/崩溃；公开 attempts 统计所有领取次数，正常闸门/定时恢复不消耗失败预算。
- `external` 用于付费、提交任务或其他不可盲目重放的调用。回调获得稳定 idempotencyKey 和 AbortSignal；超时、异常、非法返回、取消或租约丢失时，未知结果保留为 unknown/reconciling，不自动重发。幂等键仍需实际连接器发送给支持幂等的远端；本库不能使任意外部服务天然“恰好一次”。
- 心跳与写入必须使用仍有效的 owner/fence/数据库时间租约，过期租约不能续活。步骤准备在 deadline/租约丢失后才返回，也不能继续启动回调。超时后的迟到回调无法提交结果；不响应 AbortSignal 的远端请求仍可能实际完成，需后续对账。

JSON 只接受有限数值、普通对象与稠密数组，拒绝循环、accessor、特殊原型/属性、过深或超过 1MiB 的数据；持久化输入输出脱离原引用。任意回调错误消息/堆栈可能含凭据，worker 仅存步骤/工作流上下文及自身错误代码；低层存储 API 的错误文本由受信宿主负责脱敏。

## 等待、信号、对账与取消

`ctx.sleepUntil(key, finiteDate)` 使用固定绝对时间，并将 deadline 放入步骤指纹；等待释放租约，由数据库时间到期后再次领取。不要每次重放重新计算一个不同的未来时间。

`ctx.waitForSignal(key, input)` 保存等待状态并释放租约。受信宿主在人工授权后调用 `store.signal({ tenantId, taskId, gateKey, signalId, value, actorId })`；只接受实际等待的闸门。同一信号 ID 和相同内容幂等，改内容或第二个信号不能覆盖原决定。信号不会直接采用版本内容。

未知外部步骤只能经 `store.reconcile` 恢复：提供已知完成结果，或在远端确认未受理后提交 `{ kind:'retry', reason }`。人工身份、决定和完整证据写入追加事件，后续重试不会清除。该接口仅记录宿主已核实的结果，不负责查询模型服务。人工显式恢复与自动重试预算不同，宿主仍应审查重试成本与授权。

`store.cancel(key, actorId)` 撤销当前租约并保存取消记录，迟到写入拒绝；正在执行的外部步骤仍保留未知结果。之后可对账补齐审计，但不能恢复已取消任务。取消不是外部服务已经停止或费用已经退回的证明。

## 已验证与后续边界

真实 PostgreSQL 测试覆盖竞争领取、过期与陈旧 fence、重试预算、信号幂等/租户隔离、定时、取消、流程变化及迁移一致性。进程故障测试实际强制终止子 worker，再启动新进程：已完成的外部步骤不重发；执行中的外部步骤要求对账。另覆盖提供者超时、非法结果、迟到步骤准备和漏 await。

当前仍未接入版本域的 PostgreSQL 事务/CAS、真实模型连接器、业务会话/租户授权、常驻 worker 编排、观测/清理策略或大队列压测。生产备份/恢复和最小权限角色仍待完成。本库本地验收不能替代阶段 0 整体验收。

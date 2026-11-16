# 本地 OpenTelemetry 追踪

本轮落实 [ADR-012](../../docs/adr/012-observability.md) 的阶段 0 手动追踪：实际工作流/步骤生成 OpenTelemetry span，默认只保存在进程内，不配置网络 exporter、全局 provider、环境资源检测或自动上下文传播。使用锁定的 API 1.10.0、SDK 3.1.1；仓库 Node 最低版本相应为 22.15.0。接口依据 [官方手动埋点说明](https://opentelemetry.io/docs/languages/js/instrumentation/) 与 [当前追踪 SDK](https://github.com/open-telemetry/opentelemetry-js/tree/main/packages/sdk-trace)。

```ts
import { instrumentAgentWorkflow } from '@camery/agents';
import { createLocalWorkflowTracing } from '@camery/agents/node';

const local = createLocalWorkflowTracing({ tenantId, projectId, maxSpans: 1000 });
worker.register(instrumentAgentWorkflow(authorizedWorkflow, {
  tenantId, projectId, tracer: local.tracer,
}));
try {
  await worker.runTask({ tenantId, taskId }, 'internal-worker');
  await local.forceFlush();
  const diagnostics = local.snapshot();
  // 由受信宿主在明确操作后读取/保存 diagnostics。
} finally {
  await local.shutdown();
}
```

tenantId/projectId 来自宿主授权配置。装饰器拒绝实际 durable task 的租户与配置不匹配；这不是登录、RBAC 或客户端授权接口。调用方注入其他 Tracer 时，其 provider/exporter 策略由调用方明确负责；本地工厂本身没有网络、文件或控制台输出路径。

## 记录范围

instrumentAgentWorkflow 捕获工作流与 tracer 能力，保持原名称、版本、日志步骤输入、结果和幂等键。它包装 ctx.step/waitForSignal/sleepUntil，以显式上下文生成 workflow 与 decision/tool/gate/timer/question 子 span；不会因为启用埋点增加持久化步骤或改变候选摘要。

普通步骤的 execution 为 executed 或 replayed，依据 durable 是否实际调用 effect；gate/timer 返回时为 journal，表示读取日志结果，不推断它首次创建还是缓存命中。等待/未知中断为 interrupted。每次恢复都会产生新的一组观察 span，replayed 不代表再次调用模型或工具。

已知验证错误记 failed；人工闸门暂停、未知异常、未知 external、租约丢失及超时等记 interrupted，未知 external 另标 outcome=unknown。工作流根 span 的状态描述 handler 观察结果，不能代替 durable 的实际 Task 终态、对账和正式 IR 状态。实际的业务采用/发布仍走既有人工权限边界。

记录的字段限于固定名称和标量白名单：

- 租户、项目、物理任务、工作流名、步骤键的稳定摘要；角色/工具/方法 pin 再做 digest({pin})，避免来源中的伪装 pin 被原样导出。
- 输入/结果摘要、安全错误码摘要、工作流版本、步骤类别与 deterministic/synthetic_replay/live_model 标记。
- 已知 token/微币、明确的 known 标志、币种与预留额度；未知用量不补零。根结果为 Agent 报告（或既有制片输出内 research 报告）时，另记录 charged、usage_unknown、行为步数。预算占用不作为真实供应商账单。

不记录来源、提示词、答案、产物或审查正文、凭据、原始标识、异常消息/堆栈、事件、resource、任意 status message 或未知属性。先做 JSON 数据边界校验，不触发元数据 accessor；scope 只读取自有数据属性。snapshot 只接受当前 tenant/project 摘要及固定 span 名，并在写入缓冲前删去未授权字段，不保留原始 SDK ReadableSpan。

## 关联、容量与生命周期

workflow 与子步骤使用真实 SDK 的 trace/span ID 和显式父上下文，忽略无关的 ambient context。宿主可把此前真实 span 的 traceId/spanId/traceFlags 作为 parent 传入新装饰器；这必须是受信宿主的明确传递，不从来源正文或未经授权的请求读取。

默认不持久化父上下文，也不自动跨进程传播。即使未传 parent，恢复前后的 tenant/project/task 摘要仍相同，可用于本地关联查询。数据库验收验证了新 worker/provider 显式接续此前真实 span，并核对缓存读取与零重复工具调用。

本地缓冲默认 1000、最大 10000 个已结束且匹配范围的 span，超限环形淘汰旧记录，并返回 dropped 计数。错误范围和未知 span 名不占本范围容量。snapshot 返回冻结副本，不因后续记录变化；它是显式读取，不自动写文件或上报。关闭是幂等的，结束前应先 forceFlush，再读取所需快照。flush/shutdown 失败只返回安全码。

遥测 start/set/end 出错或误传异步回调时，不改变业务输出和原始拒绝；装饰器新产生的 Promise 也观察未等待的拒绝，保留 durable 的忘 await 保护。无效日期仍由原 sleepUntil 返回原有验证错误。

## 验收与剩余范围

[单元验收](test/observability.test.ts)、[本地 SDK](test/local-tracing.test.ts)、[字段边界](test/telemetry-data.test.ts) 覆盖真实父子关系、并发隔离、回放、未知计量、敏感字段、scope/accessor、十六进制伪装 pin、环形丢弃和生命周期。

[真实 PostgreSQL 验收](test/observability.integration.test.ts) 运行磁盘章节方法的制片→研究→工具→人工闸门；新 worker/provider 在明确父上下文后恢复，工具 handler 总计一次，轨迹输出不含来源、租户/项目/任务原文、actor 或分配身份。

本轮不提供 OTLP/Collector 后端、跨服务自动传播、持久化追踪数据库或完整诊断包文件导出。它们按部署/发行任务单独接入；真实模型计费、正式认证与脱敏诊断包产品流程仍需各自验收。

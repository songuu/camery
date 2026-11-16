import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Context, Span, SpanContext, Tracer } from '@opentelemetry/api';
import { z } from 'zod';
import { DurableError } from '@camery/durable';
import type { Json, Workflow, WorkflowContext } from '@camery/durable';
import { digest, freeze, jsonCopy, Pin } from '@camery/methods';
import { AgentError, Name, ReservationSchema, UsageSchema } from './registry.js';
import { AgentRunReportSchema } from './runtime.js';
import { synchronous } from './trusted-callbacks.js';
import { sanitizeTraceAttributes, traceScopeHashes } from './telemetry-data.js';
import type { SafeTraceAttributes, TraceSpanName } from './telemetry-data.js';
export interface WorkflowTracingOptions { tracer: Tracer; tenantId: string; projectId: string; parent?: Pick<SpanContext, 'traceId' | 'spanId' | 'traceFlags'> }
const Parent = z.strictObject({ traceId: z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/), spanId: z.string().regex(/^(?!0{16}$)[a-f0-9]{16}$/), traceFlags: z.int().min(0).max(255) });
const Driver = z.object({ evidence: z.enum(['deterministic', 'synthetic_replay', 'live_model']), currency: z.string().regex(/^[A-Z]{3}$/) }).passthrough();
const Policy = z.object({ agent: Pin.optional(), producer: Pin.optional(), method: Pin.optional(), driver: Driver.optional() }).passthrough();
const Frame = Policy.extend({ policy: Policy.optional(), pin: Pin.shape.digest.optional(), reservation: ReservationSchema.optional() });
const Envelope = z.object({ kind: z.enum(['result', 'error']), usage: UsageSchema, outcome: z.enum(['not_applicable', 'not_sent', 'rejected', 'completed', 'unknown']) }).passthrough();
function quietly(run: () => unknown): void { try { synchronous(run()); } catch { /* Telemetry failures must not change journal effects or workflow results. */ } }
function metadata(input: Json, tool: boolean): SafeTraceAttributes {
  const parsed = Frame.safeParse(jsonCopy(input)); if (!parsed.success) return {};
  const frame = parsed.data; const policy = frame.policy ?? frame; const agent = policy.agent ?? policy.producer;
  return sanitizeTraceAttributes({ ...(agent ? { 'camery.agent_pin_hash': digest({ pin: agent.digest }) } : {}), ...(policy.method ? { 'camery.method_pin_hash': digest({ pin: policy.method.digest }) } : {}), ...(tool && frame.pin ? { 'camery.tool_pin_hash': digest({ pin: frame.pin }) } : {}),
    ...(policy.driver ? { 'camery.evidence': policy.driver.evidence, 'camery.currency': policy.driver.currency } : {}), ...(frame.reservation ? { 'camery.reserved_tokens': frame.reservation.tokens, 'camery.reserved_cost_micros': frame.reservation.costMicros } : {}) });
}
function usage(input: Json): SafeTraceAttributes {
  const parsed = Envelope.safeParse(jsonCopy(input)); if (!parsed.success) return {};
  const { usage: value, outcome } = parsed.data;
  return sanitizeTraceAttributes({ 'camery.outcome': outcome, 'camery.tokens_known': value.tokens !== null, 'camery.cost_known': value.costMicros !== null, ...(value.tokens !== null ? { 'camery.tokens': value.tokens } : {}), ...(value.costMicros !== null ? { 'camery.cost_micros': value.costMicros } : {}) });
}
function summary(input: Json): SafeTraceAttributes {
  const captured = jsonCopy(input); const direct = AgentRunReportSchema.safeParse(captured); const nested = z.object({ research: AgentRunReportSchema }).passthrough().safeParse(captured); const report = direct.success ? direct.data : nested.success ? nested.data.research : undefined;
  return report ? sanitizeTraceAttributes({ 'camery.state': report.state, 'camery.agent_pin_hash': digest({ pin: report.agent.digest }), 'camery.charged_tokens': report.charged.tokens, 'camery.charged_cost_micros': report.charged.costMicros, 'camery.usage_unknown': report.usageUnknown, 'camery.behavior_steps': report.steps }) : { 'camery.state': 'succeeded' };
}
/** Manual, explicit-context instrumentation. No global SDK registration, network exporter or journal changes. */
export function instrumentAgentWorkflow(workflow: Workflow, options: WorkflowTracingOptions): Workflow {
  const config = z.strictObject({ tenantId: Name, projectId: Name, name: Name, version: z.int().min(1).max(2147483647), parent: Parent.optional() }).safeParse(jsonCopy({ tenantId: options.tenantId, projectId: options.projectId, name: workflow.name, version: workflow.version, ...(options.parent ? { parent: { traceId: options.parent.traceId, spanId: options.parent.spanId, traceFlags: options.parent.traceFlags } } : {}) }));
  if (!config.success || typeof workflow.run !== 'function' || typeof options.tracer?.startSpan !== 'function') throw new AgentError('INVALID_WORKFLOW_TRACING');
  const captured = freeze(config.data); const run = workflow.run.bind(workflow); const start = options.tracer.startSpan.bind(options.tracer); const scope = traceScopeHashes(captured);
  const base = { 'camery.tenant_hash': scope.tenantHash, 'camery.project_hash': scope.projectHash, 'camery.workflow_hash': digest({ name: captured.name }), 'camery.workflow_version': captured.version };
  const parent = captured.parent ? trace.setSpanContext(ROOT_CONTEXT, captured.parent) : ROOT_CONTEXT;
  const begin = (name: TraceSpanName, attributes: SafeTraceAttributes, context: Context): Span | undefined => {
    try { const span = synchronous(start(name, { attributes: sanitizeTraceAttributes(attributes) }, context)); if (typeof span?.end !== 'function' || typeof span.setAttributes !== 'function' || typeof span.setStatus !== 'function') return undefined; return span; } catch { return undefined; }
  };
  const failed = (span: Span | undefined, error: unknown): void => {
    const known = error instanceof DurableError || error instanceof AgentError;
    const interrupted = !known || ['AGENT_EXTERNAL_UNKNOWN', 'LEASE_LOST', 'RUN_TIMEOUT', 'STEP_TIMEOUT', 'RUN_STOPPED', 'TASK_CANCELLED'].includes(error.code) || (error instanceof AgentError && error.outcome === 'unknown');
    if (span) quietly(() => span.setAttributes({ 'camery.state': interrupted ? 'interrupted' : 'failed', 'camery.execution': 'interrupted', 'camery.error_hash': digest({ code: known ? error.code : 'INTERRUPTED' }), ...(known && (error.code === 'AGENT_EXTERNAL_UNKNOWN' || (error instanceof AgentError && error.outcome === 'unknown')) ? { 'camery.outcome': 'unknown' } : {}) }));
    if (span && !interrupted) quietly(() => span.setStatus({ code: SpanStatusCode.ERROR }));
  };
  return { name: captured.name, version: captured.version, async run(input, context) {
    if (context.task.tenantId !== captured.tenantId) throw new AgentError('TRACE_SCOPE');
    const attributes = { ...base, 'camery.task_hash': digest({ tenantId: context.task.tenantId, taskId: context.task.taskId }) };
    let root: Span | undefined; quietly(() => { root = begin('camery.workflow', { ...attributes, 'camery.kind': 'workflow', 'camery.input_hash': digest(input) }, parent); });
    const childContext = root ? trace.setSpan(ROOT_CONTEXT, root) : parent;
    const step = context.step.bind(context); const wait = context.waitForSignal.bind(context); const sleep = context.sleepUntil.bind(context);
    const observed = async (key: string, kind: 'replayable' | 'external' | 'gate' | 'timer', original: Json, invoke: (executing: () => void) => Promise<Json>): Promise<Json> => {
      const name: TraceSpanName = kind === 'timer' ? 'camery.timer' : kind === 'gate' ? /^agent\.\d+\.question$/.test(key) ? 'camery.question' : 'camery.gate' : /^agent\.\d+\.decision$/.test(key) ? 'camery.decision' : /^agent\.\d+\.tool$/.test(key) ? 'camery.tool' : 'camery.step';
      let span: Span | undefined; let executed = false;
      quietly(() => { span = begin(name, { ...attributes, ...metadata(original, name === 'camery.tool'), 'camery.step_hash': digest({ key }), 'camery.kind': kind, 'camery.input_hash': digest(original) }, childContext); });
      try { const value = await invoke(() => { executed = true; }); if (span) { quietly(() => span!.setAttributes(sanitizeTraceAttributes({ ...usage(value), 'camery.output_hash': digest(value), 'camery.execution': kind === 'gate' || kind === 'timer' ? 'journal' : executed ? 'executed' : 'replayed', 'camery.state': 'succeeded' }))); quietly(() => span!.setStatus({ code: SpanStatusCode.OK })); } return value; }
      catch (error) { quietly(() => failed(span, error)); throw error; } finally { if (span) quietly(() => span!.end()); }
    };
    // The decorator creates a new Promise too: preserve the journal's forget-await rejection protection.
    const tracked = (pending: Promise<Json>): Promise<Json> => { void pending.catch(() => {}); return pending; };
    const wrapped: WorkflowContext = { task: context.task, signal: context.signal,
      step: (key, definition, effect) => tracked(observed(key, definition.kind, definition.input, executing => step(key, definition, async actual => { executing(); return effect(actual); }))),
      waitForSignal: (key, original = null) => tracked(observed(key, 'gate', original, () => wait(key, original))),
      sleepUntil: (key, at) => { let value: Json = null; quietly(() => { value = Date.prototype.toISOString.call(at); }); return tracked(observed(key, 'timer', value, () => sleep(key, at))); } };
    try { const output = await run(input, wrapped); if (root) { quietly(() => root!.setAttributes(sanitizeTraceAttributes({ ...summary(output), 'camery.output_hash': digest(output) }))); quietly(() => root!.setStatus({ code: SpanStatusCode.OK })); } return output; }
    catch (error) { quietly(() => failed(root, error)); throw error; } finally { if (root) quietly(() => root!.end()); }
  } };
}

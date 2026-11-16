import { afterAll, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import { DurableError, DurableWorker } from '@camery/durable';
import type { DurableStore, Json, Workflow, WorkflowContext } from '@camery/durable';
import { digest, chapterPack, MethodRegistry } from '@camery/methods';
import { instrumentAgentWorkflow } from '../src/observability.js';
import { traceScopeHashes } from '../src/telemetry-data.js';
import { createChapterResearchWorkflow } from '../src/producer.js';
const providers: TracerProvider[] = []; afterAll(async () => { await Promise.all(providers.map(provider => provider.shutdown())); });
function fixture() {
  const exporter = new InMemorySpanExporter(); const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }); providers.push(provider); const tracer = provider.getTracer('camery-test');
  const cache = new Map<string, Json>(); const context: WorkflowContext = { task: { tenantId: 'private-tenant', taskId: 'private-task' }, signal: new AbortController().signal,
    step: async (key, options, effect) => { if (cache.has(key)) return structuredClone(cache.get(key)!); const value = await effect({ input: options.input, signal: new AbortController().signal, idempotencyKey: key }); cache.set(key, structuredClone(value)); return value; },
    waitForSignal: async (_key, input) => ({ decision: 'accept', candidateDigest: (input as Record<string, Json>)['candidateDigest']! }), sleepUntil: async () => null };
  return { exporter, provider, tracer, context, cache, options: { tracer, tenantId: 'private-tenant', projectId: 'private-project' } };
}
it('uses actual SDK parent/child spans while leaving workflow output and journal cache unchanged', async () => {
  const f = fixture(); const effect = vi.fn(async () => ({ kind: 'result', usage: { tokens: null, costMicros: 0 }, outcome: 'completed', output: 'private-provider-output' }));
  const flow: Workflow = { name: 'private-workflow', version: 1, run: async (_input, ctx) => ctx.step('agent.0.decision', { kind: 'external', input: { reservation: { tokens: 10, costMicros: 2 }, policy: { agent: { id: 'research', version: '1.0.0', digest: 'a'.repeat(64) }, driver: { evidence: 'synthetic_replay', currency: 'CNY' } }, source: 'private-source' } }, effect) };
  const wrapped = instrumentAgentWorkflow(flow, f.options); const first = await wrapped.run({ secret: 'private-source' }, f.context); expect(await wrapped.run({ secret: 'private-source' }, f.context)).toEqual(first); expect(effect).toHaveBeenCalledOnce(); await f.provider.forceFlush();
  const spans = f.exporter.getFinishedSpans(); const roots = spans.filter(span => span.name === 'camery.workflow'); const children = spans.filter(span => span.name === 'camery.decision'); expect(roots).toHaveLength(2); expect(children.map(span => span.attributes['camery.execution'])).toEqual(['executed', 'replayed']);
  expect(children[0]!.parentSpanContext?.spanId).toBe(roots[0]!.spanContext().spanId); expect(children[0]!.attributes).toMatchObject({ 'camery.tokens_known': false, 'camery.cost_known': true, 'camery.cost_micros': 0, 'camery.reserved_tokens': 10, 'camery.agent_pin_hash': digest({ pin: 'a'.repeat(64) }) });
  const payload = JSON.stringify(spans.map(span => ({ name: span.name, attrs: span.attributes, events: span.events, status: span.status })));
  for (const secret of ['private-source', 'private-provider-output', 'private-tenant', 'private-project', 'private-task', 'private-workflow']) expect(payload).not.toContain(secret);
});
it('does not export a source-supplied hex credential disguised as a pin', async () => {
  const f = fixture(); const secret = 'acbd'.repeat(16); const flow: Workflow = { name: 'flow', version: 1, run: async (_input, ctx) => ctx.step('read-source', { kind: 'replayable', input: { agent: { id: 'fake-role', version: '1.0.0', digest: secret } } }, async () => null) };
  await instrumentAgentWorkflow(flow, f.options).run(null, f.context); await f.provider.forceFlush(); expect(JSON.stringify(f.exporter.getFinishedSpans().map(span => span.attributes))).not.toContain(secret);
});
it('traces the actual producer/research/tool/gate path without changing candidate identity', async () => {
  const f = fixture(); const methods = new MethodRegistry(); const method = methods.register(chapterPack); const budget = { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' };
  const flow = createChapterResearchWorkflow({ name: 'chapter', version: 1, methods, method, bindingFor: async task => ({ ...task, projectId: 'private-project', objectIds: ['source'], stage: 'understanding', writers: [], taskBudget: budget, projectAllocation: budget, allocationId: 'share' }) });
  const output = await instrumentAgentWorkflow(flow, f.options).run({ sourceId: 'source', text: '第一章 出发\n原文。' }, f.context); expect(output).toMatchObject({ state: 'reviewed_candidate' }); await f.provider.forceFlush(); const spans = f.exporter.getFinishedSpans();
  expect(spans.some(span => span.name === 'camery.tool')).toBe(true); expect(spans.some(span => span.name === 'camery.gate')).toBe(true); expect(spans.find(span => span.name === 'camery.workflow')?.attributes).toMatchObject({ 'camery.charged_tokens': 0, 'camery.usage_unknown': false, 'camery.behavior_steps': 3 });
  expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
});
it('distinguishes known errors and suspended/unknown interruptions without recording exception text', async () => {
  for (const error of [new Error('private-password'), new DurableError('INVALID_INPUT', 'private-password'), new DurableError('AGENT_EXTERNAL_UNKNOWN', 'private-password')]) {
    const f = fixture(); const flow: Workflow = { name: 'flow', version: 1, run: async (_input, ctx) => ctx.waitForSignal('private-question', { prompt: 'private-prompt' }) }; f.context.waitForSignal = async () => { throw error; };
    await expect(instrumentAgentWorkflow(flow, f.options).run(null, f.context)).rejects.toBe(error); await f.provider.forceFlush(); const spans = f.exporter.getFinishedSpans(); expect(spans).toHaveLength(2); expect(spans[1]!.attributes['camery.state']).toBe(error instanceof DurableError && error.code === 'INVALID_INPUT' ? 'failed' : 'interrupted'); expect(JSON.stringify(spans.map(span => ({ a: span.attributes, s: span.status, e: span.events })))).not.toContain('private-password');
  }
});
it('preserves the journal rejection for an invalid timer without replacing it with a synchronous date error', async () => {
  const f = fixture(); const expected = new DurableError('INVALID_INPUT', 'invalid timer'); const sleep = vi.fn(async () => { throw expected; }); f.context.sleepUntil = sleep;
  const flow: Workflow = { name: 'timer', version: 1, run: async (_input, ctx) => ctx.sleepUntil('deadline', new Date(NaN)) };
  await expect(instrumentAgentWorkflow(flow, f.options).run(null, f.context)).rejects.toBe(expected); expect(sleep).toHaveBeenCalledOnce();
});
it('keeps the durable runtime protection against a handler that forgets to await a rejected step', async () => {
  const f = fixture(); const task = { ...f.context.task, workflow: 'unawaited', version: 1, input: null, status: 'running', attempts: 1, fence: 1, owner: 'worker', leaseUntil: new Date('2099-01-01'), availableAt: null, output: null, error: null, maxAttempts: 1 };
  const store = { claim: async () => ({ task, lease: { ...f.context.task, owner: 'worker', fence: 1 } }), get: async () => task, heartbeat: async () => {}, openStep: async () => { throw new DurableError('LEASE_LOST', 'private failure'); }, failStep: async () => {}, fail: async () => {}, finish: vi.fn() };
  const worker = new DurableWorker(store as unknown as DurableStore); worker.register(instrumentAgentWorkflow({ name: 'unawaited', version: 1, async run(_input, ctx) { void ctx.step('ignored', { kind: 'replayable', input: null }, async () => null); return null; } }, f.options));
  await worker.runOne(task.tenantId, 'worker'); await new Promise(resolve => setTimeout(resolve, 10)); expect(store.finish).not.toHaveBeenCalled();
});
it('captures scope and methods before awaits and rejects an explicit tenant mismatch', async () => {
  const f = fixture(); const original = vi.fn(async () => null); const flow: Workflow = { name: 'flow', version: 1, run: original }; const options = { ...f.options }; const wrapped = instrumentAgentWorkflow(flow, options); options.projectId = 'changed'; flow.run = async () => { throw new Error('replaced'); }; await wrapped.run(null, f.context); expect(original).toHaveBeenCalledOnce();
  const wrong = { ...f.context, task: { ...f.context.task, tenantId: 'other' } }; await expect(wrapped.run(null, wrong)).rejects.toMatchObject({ code: 'TRACE_SCOPE' }); expect(original).toHaveBeenCalledOnce(); await f.provider.forceFlush(); expect(f.exporter.getFinishedSpans()[0]!.attributes['camery.project_hash']).toBe(traceScopeHashes(f.options).projectHash);
});
it('isolates concurrent runs from an unrelated ambient parent and supports an explicitly supplied parent', async () => {
  const f = fixture(); const attrs = traceScopeHashes(f.options); const parent = f.tracer.startSpan('camery.workflow', { attributes: { 'camery.tenant_hash': attrs.tenantHash, 'camery.project_hash': attrs.projectHash } }, ROOT_CONTEXT);
  const flow: Workflow = { name: 'flow', version: 1, run: async (_input, ctx) => ctx.sleepUntil('timer', new Date('2026-01-01')) }; const wrapped = instrumentAgentWorkflow(flow, { ...f.options, parent: parent.spanContext() }); await Promise.all([wrapped.run(null, f.context), wrapped.run(null, { ...f.context, task: { ...f.context.task, taskId: 'other-task' } })]); parent.end(); await f.provider.forceFlush();
  const roots = f.exporter.getFinishedSpans().filter(span => span.name === 'camery.workflow' && span.parentSpanContext); expect(roots).toHaveLength(2); expect(roots.every(span => span.parentSpanContext?.spanId === parent.spanContext().spanId)).toBe(true); expect(new Set(roots.map(span => span.attributes['camery.task_hash'])).size).toBe(2);
  expect(trace.getSpan(ROOT_CONTEXT)).toBeUndefined();
});
it('keeps exporter/tracer failures from altering business results, including accidentally asynchronous callbacks', async () => {
  const f = fixture(); const flow: Workflow = { name: 'flow', version: 1, run: async (_input, ctx) => ctx.step('local', { kind: 'replayable', input: null }, async () => ({ ok: true })) };
  for (const startSpan of [() => { throw new Error('private-exporter-error'); }, () => Promise.reject(new Error('late private-exporter-error'))]) {
    expect(await instrumentAgentWorkflow(flow, { ...f.options, tracer: { startSpan } as unknown as Tracer }).run(null, f.context)).toEqual({ ok: true });
  }
  await new Promise(resolve => setTimeout(resolve, 0));
});
it('validates scope, workflow and parent configuration before executing', () => {
  const f = fixture(); const flow: Workflow = { name: 'flow', version: 1, run: async () => null };
  for (const value of [{ ...f.options, projectId: '' }, { ...f.options, tracer: false }, { ...f.options, parent: { traceId: 'bad', spanId: 'bad', traceFlags: 1 } }]) expect(() => instrumentAgentWorkflow(flow, value as never)).toThrow();
  expect(() => instrumentAgentWorkflow({ ...flow, version: 0 }, f.options)).toThrow();
  expect(SpanStatusCode.ERROR).toBe(2); expect(digest(null)).toMatch(/^[a-f0-9]{64}$/);
});
it('does not evaluate accessors in invalid telemetry metadata before the journal rejects that input', async () => {
  const f = fixture(); let accessed = 0; const input = Object.defineProperty({}, 'policy', { enumerable: true, get: () => { accessed++; return {}; } }) as Json;
  const failure = new DurableError('INVALID_INPUT', 'invalid JSON'); f.context.step = async () => { throw failure; };
  const flow: Workflow = { name: 'flow', version: 1, run: async (_input, ctx) => ctx.step('local', { kind: 'replayable', input }, async () => null) };
  await expect(instrumentAgentWorkflow(flow, f.options).run(null, f.context)).rejects.toBe(failure); expect(accessed).toBe(0);
});

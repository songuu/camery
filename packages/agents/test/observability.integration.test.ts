import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { MethodRegistry, MethodRunner } from '@camery/methods';
import { loadMethodPack } from '@camery/methods/node';
import { createChapterResearchWorkflow } from '../src/producer.js';
import { instrumentAgentWorkflow } from '../src/observability.js';
import { createLocalWorkflowTracing } from '../src/node/local-tracing.js';
const url = process.env['CAMERY_TEST_DATABASE_URL']; if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for tracing tests');
const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000 }); const store = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); }); afterAll(async () => { await pool.end(); });
it('correlates actual producer/research/tool spans across a fresh worker and provider without repeating completed calls', async () => {
  const tenantId = randomUUID(); const projectId = randomUUID(); const taskId = randomUUID(); const scope = { tenantId, projectId }; const first = createLocalWorkflowTracing(scope); const second = createLocalWorkflowTracing(scope);
  const methods = new MethodRegistry(); const method = methods.register(await loadMethodPack(fileURLToPath(new URL('../../../method-packs/chapter-segmentation/', import.meta.url))));
  const budget = { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' }; const flow = () => createChapterResearchWorkflow({ name: 'traced-chapter', version: 1, methods, method, bindingFor: async task => ({ ...task, projectId, objectIds: ['source'], stage: 'understanding', writers: [], taskBudget: budget, projectAllocation: budget, allocationId: 'private-share' }) });
  const key = { tenantId, taskId }; const source = '第一章 起点\nprivate-source-token。\n第二章 回信\n她保留原文。'; const spy = vi.spyOn(MethodRunner.prototype, 'run');
  try {
    await store.enqueue({ ...key, workflow: 'traced-chapter', version: 1, input: { sourceId: 'source', text: source }, maxAttempts: 1, availableAt: new Date('2026-01-01') });
    const initial = new DurableWorker(store); initial.register(instrumentAgentWorkflow(flow(), { ...scope, tracer: first.tracer })); expect((await initial.runTask(key, 'first-traced-worker'))?.status).toBe('waiting'); await first.forceFlush(); expect(spy).toHaveBeenCalledOnce();
    const snapshot = first.snapshot(); const root = snapshot.spans.find(span => span.name === 'camery.workflow')!; expect(root.attributes['camery.state']).toBe('interrupted'); expect(snapshot.spans.find(span => span.name === 'camery.tool')?.attributes['camery.execution']).toBe('executed');
    const gate = (await store.steps(key)).at(-1)!; const candidateDigest = (gate.input as Record<string, unknown>)['candidateDigest']; await store.signal({ ...key, gateKey: gate.key, signalId: 'review', actorId: 'private-human-actor', value: { decision: 'accept', candidateDigest: String(candidateDigest) } });
    const restored = new DurableWorker(store); restored.register(instrumentAgentWorkflow(flow(), { ...scope, tracer: second.tracer, parent: { traceId: root.traceId, spanId: root.spanId, traceFlags: 1 } }));
    expect((await restored.runTask(key, 'restored-traced-worker'))?.status).toBe('succeeded'); await second.forceFlush(); expect(spy).toHaveBeenCalledOnce(); const resumed = second.snapshot(); const resumedRoot = resumed.spans.find(span => span.name === 'camery.workflow')!;
    expect(resumedRoot.traceId).toBe(root.traceId); expect(resumedRoot.parentSpanId).toBe(root.spanId); expect(resumedRoot.attributes['camery.task_hash']).toBe(root.attributes['camery.task_hash']); expect(resumedRoot.attributes).toMatchObject({ 'camery.state': 'candidate', 'camery.charged_tokens': 0, 'camery.charged_cost_micros': 0, 'camery.usage_unknown': false });
    expect(resumed.spans.filter(span => ['camery.decision', 'camery.tool'].includes(span.name)).every(span => span.attributes['camery.execution'] === 'replayed')).toBe(true); expect(resumed.spans.find(span => span.name === 'camery.gate')?.attributes['camery.execution']).toBe('journal');
    const exported = JSON.stringify([snapshot, resumed]); for (const privateValue of [tenantId, projectId, taskId, source, 'private-source-token', 'private-human-actor', 'private-share']) expect(exported).not.toContain(privateValue);
    expect((await store.events(key)).filter(event => event.action === 'gate_signalled')).toHaveLength(1); expect((await store.steps(key)).filter(step => step.key === 'agent.1.tool')).toHaveLength(1);
  } finally { spy.mockRestore(); await first.shutdown(); await second.shutdown(); }
});

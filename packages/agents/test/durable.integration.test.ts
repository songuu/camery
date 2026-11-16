import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { digest, MethodRegistry, MethodRunner } from '@camery/methods';
import { loadMethodPack } from '@camery/methods/node';
import { AgentRegistry, AgentRuntime, createChapterResearchWorkflow, ToolRegistry } from '../src/index.js';
import type { RunBinding, DecisionDriver } from '../src/index.js';
import { protocolProvider, researchRuntime, source } from './model-support.js';
const url = process.env['CAMERY_TEST_DATABASE_URL'];
if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required; agents integration never silently skips PostgreSQL');
const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 5000, max: 4 }); const store = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); }); afterAll(async () => { await pool.end(); });
const budget = { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' };
const task = () => ({ tenantId: randomUUID(), taskId: randomUUID(), workflow: 'agent-test', version: 1, input: { sourceId: 'source-a', text: '第一章 起点\n原文。\n第二章 归来\n后文。' }, maxAttempts: 1, availableAt: new Date('2026-01-01') });
const binding = (key: { tenantId: string; taskId: string }): RunBinding => ({ ...key, projectId: 'project-a', objectIds: ['source-a'], stage: 'understanding', writers: [{ objectType: 'source', agentId: 'research' }], taskBudget: budget, projectAllocation: budget, allocationId: `allocated-${key.taskId}` });
it('runs producer → research → actual disk method pack → candidate → durable review and replays saved calls', async () => {
  const item = task(); const methods = new MethodRegistry(); const method = methods.register(await loadMethodPack(fileURLToPath(new URL('../../../method-packs/chapter-segmentation/', import.meta.url))));
  const workflow = () => createChapterResearchWorkflow({ name: item.workflow, version: 1, methods, method, bindingFor: async key => binding(key) });
  const spy = vi.spyOn(MethodRunner.prototype, 'run'); await store.enqueue(item); const first = new DurableWorker(store); first.register(workflow());
  try {
    expect((await first.runOne(item.tenantId, 'producer-worker'))?.status).toBe('waiting'); expect(spy).toHaveBeenCalledOnce();
    const steps = await store.steps(item); const gate = steps.at(-1)!; expect(gate.key).toBe('producer.review'); expect(gate.status).toBe('waiting');
    const candidateDigest = (gate.input as Record<string, unknown>)['candidateDigest'];
    await expect(store.signal({ tenantId: 'another-tenant', taskId: item.taskId, gateKey: gate.key, signalId: 'wrong', actorId: 'host-human', value: { decision: 'accept', candidateDigest: String(candidateDigest) } })).rejects.toThrow();
    await store.signal({ ...item, gateKey: gate.key, signalId: 'review-1', actorId: 'host-human', value: { decision: 'accept', candidateDigest: String(candidateDigest) } });
    const resumed = new DurableWorker(store); resumed.register(workflow()); const finished = await resumed.runOne(item.tenantId, 'replacement-worker');
    expect(finished).toMatchObject({ status: 'succeeded', output: { state: 'reviewed_candidate', research: { steps: 3, charged: { tokens: 0, costMicros: 0 } } } }); expect(spy).toHaveBeenCalledOnce();
    expect((await store.steps(item)).filter(value => value.key === 'agent.1.tool')).toHaveLength(1); expect(await resumed.runOne(item.tenantId, 'idle')).toBeNull();
    expect((await store.events(item)).some(event => event.action === 'gate_signalled')).toBe(true);
  } finally { spy.mockRestore(); }
});
function paidRuntime(execute: () => Promise<{ output: { text: string }; usage: { tokens: number; costMicros: number } }>) {
  const object = { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'], additionalProperties: false };
  const tools = new ToolRegistry(); const tool = tools.register({ definition: { name: 'test.submit', version: '1.0.0', description: 'Synthetic paid-side-effect contract; no provider or billing.', inputSchema: object, outputSchema: object, effect: 'paid', objectType: 'source', reservation: { tokens: 0, costMicros: 0 }, currency: 'CNY' }, resources: () => ['source-a'], execute });
  const agents = new AgentRegistry(); const pin = agents.register({ id: 'research', version: '1.0.0', instructions: 'Test durable boundary.', tools: [tool], methods: [], modelTier: 'deterministic', writeKinds: ['source'], budget, outputSchema: object });
  const driver: DecisionDriver = { identity: 'synthetic-driver', digest: 'a'.repeat(64), evidence: 'deterministic', currency: 'CNY', reservation: { tokens: 0, costMicros: 0 }, async decide(request) {
    return { action: request.observations.length ? { kind: 'finish', output: { text: 'candidate' } } : { kind: 'tool', tool: tool.id, input: { text: 'test' } }, usage: { tokens: 0, costMicros: 0 } };
  } };
  const approve = vi.fn(async () => true); const runtime = new AgentRuntime(agents, tools, driver, { tokenFor: async () => 'synthetic-host-token', verify: approve });
  return { runtime, pin, approve };
}
it('holds an uncertain paid tool for reconciliation, then resumes without submitting or approving again', async () => {
  const item = task(); const submit = vi.fn(async () => { throw new Error('untrusted synthetic provider failure'); }); const setup = paidRuntime(submit);
  const worker = new DurableWorker(store, { retryDelayMs: 1 }); worker.register({ name: item.workflow, version: 1, run: async (input, ctx) => JSON.parse(JSON.stringify(await setup.runtime.run(setup.pin, input, binding(ctx.task), ctx))) });
  await store.enqueue(item); expect((await worker.runOne(item.tenantId, 'first'))?.status).toBe('reconciling'); expect(submit).toHaveBeenCalledOnce();
  expect(await worker.runOne(item.tenantId, 'automatic-retry')).toBeNull(); expect((await store.steps(item)).at(-1)).toMatchObject({ key: 'agent.1.tool', status: 'unknown' });
  await store.reconcile({ ...item, stepKey: 'agent.1.tool', actorId: 'host-operator', resolution: { kind: 'completed', output: { kind: 'result', output: { text: 'provider-confirmed' }, usage: { tokens: 0, costMicros: 0 }, outcome: 'completed' } } });
  expect((await worker.runOne(item.tenantId, 'after-reconciliation'))?.status).toBe('succeeded'); expect(submit).toHaveBeenCalledOnce(); expect(setup.approve).toHaveBeenCalledOnce();
});
it('kills a real agent worker after its method commit and recovers in another process without repeating it', async () => {
  const item = { ...task(), maxAttempts: 3 }; await store.enqueue(item);
  function child(phase: 'crash' | 'resume') {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/producer-worker.ts', import.meta.url))], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...globalThis.process.env, CAMERY_AGENT_TEST_TENANT: item.tenantId, CAMERY_AGENT_TEST_TASK: item.taskId, CAMERY_AGENT_TEST_PHASE: phase }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const messages: { event: string; status?: string }[] = []; const exit = once(process, 'exit'); let wake: () => void = () => {};
    process.on('message', message => { if (message && typeof message === 'object' && 'event' in message) { messages.push(message as { event: string }); wake(); } });
    async function wait(event: string) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([new Promise<void>(resolve => { wake = () => { if (messages.some(value => value.event === event)) resolve(); }; wake(); }), exit.then(() => { if (!messages.some(value => value.event === event)) throw new Error(`Agent worker exited before ${event}`); }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Agent worker did not reach ${event}`)), 20000); })]); }
      finally { clearTimeout(timer); }
    }
    return { process, exit, wait, messages };
  }
  const first = child('crash');
  try {
    await first.wait('blocked'); expect(first.messages.filter(value => value.event === 'method')).toHaveLength(1);
    expect((await store.steps(item)).at(-1)).toMatchObject({ key: 'agent.1.tool', status: 'completed' });
    first.process.kill('SIGKILL'); await first.exit;
    await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2", [item.tenantId, item.taskId]);
    const resumed = child('resume');
    try { await resumed.wait('done'); await resumed.exit; expect(resumed.messages).toContainEqual({ event: 'done', status: 'waiting' }); expect(resumed.messages.filter(value => value.event === 'method')).toHaveLength(0); }
    finally { resumed.process.kill(); }
    expect((await store.get(item))?.status).toBe('waiting'); expect((await store.events(item)).some(value => value.action === 'lease_expired')).toBe(true);
  } finally { first.process.kill(); const current = await store.get(item); if (current && !['succeeded', 'failed', 'cancelled'].includes(current.status)) await store.cancel(item, 'fault-test-cleanup'); }
});
it('restores model decisions with receipts from PostgreSQL using a fresh model session with zero repeated calls', async () => {
  const item = { ...task(), workflow: 'agent-model', input: source }; const provider = protocolProvider(); const setup = await researchRuntime(provider.transport, item);
  const first = new DurableWorker(store); first.register({ name: item.workflow, version: 1, async run(input, ctx) {
    const report = await setup.runtime.run(setup.pin, input, setup.binding, ctx); await ctx.waitForSignal('model.review', { candidateDigest: digest(report.output) }); return JSON.parse(JSON.stringify(report));
  } });
  await store.enqueue(item); const initial = await first.runOne(item.tenantId, 'first-model-worker'); expect(initial?.error).toBeNull(); expect(initial?.status).toBe('waiting'); expect(provider.calls()).toBe(2);
  const recorded = await store.steps(item); expect(recorded.filter(step => step.key.includes('decision') && step.status === 'completed')).toHaveLength(2);
  const gate = recorded.at(-1)!; await store.signal({ ...item, gateKey: gate.key, signalId: 'model-reviewed', actorId: 'host-human', value: true });
  const replacement = protocolProvider(); const restored = await researchRuntime(replacement.transport, item); const next = new DurableWorker(store);
  next.register({ name: item.workflow, version: 1, async run(input, ctx) {
    const report = await restored.runtime.run(restored.pin, input, restored.binding, ctx); await ctx.waitForSignal('model.review', { candidateDigest: digest(report.output) }); return JSON.parse(JSON.stringify(report));
  } });
  expect((await next.runOne(item.tenantId, 'new-model-worker'))?.status).toBe('succeeded'); expect(replacement.calls()).toBe(0); expect(restored.session.callsUsed).toBe(0); expect(provider.calls()).toBe(2);
});

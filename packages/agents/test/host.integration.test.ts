import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { AgentDispatchHost } from '../src/host.js';
import { AgentRegistry } from '../src/registry.js';
import { PostgresCollaborationStore } from '../src/node/collaboration-store.js';
import { migrateAgents } from '../src/node/migrate.js';
import { inboxSetup } from './fixtures/inbox-support.js';
const url = process.env['CAMERY_TEST_DATABASE_URL']; if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for host tests');
const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 }); const durable = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); await migrateAgents(pool); }); afterAll(async () => { await pool.end(); });
async function fixture(children = 2) {
  const agents = new AgentRegistry(); const definition = { version: '1.0.0', instructions: 'Return a scoped synthetic text candidate only.', tools: [], methods: [], modelTier: 'deterministic' as const, writeKinds: [], budget: { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' }, outputSchema: { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'], additionalProperties: false } };
  const producer = agents.register({ ...definition, id: 'producer' }); const research = agents.register({ ...definition, id: 'research' });
  const scope = { tenantId: randomUUID(), projectId: randomUUID() }; const tree = { ...scope, treeId: randomUUID() }; const collaboration = new PostgresCollaborationStore(pool, agents);
  const root = { taskId: 'plan', parentId: null, agent: producer, input: { text: 'original plan' }, dependencies: [], scope: { ...scope, objectIds: ['source'] }, status: 'queued' as const };
  await collaboration.createTree({ ...tree, tasks: [root, ...Array.from({ length: children }, (_unused, index) => ({ ...root, taskId: `research-${index}`, parentId: root.taskId, agent: research, input: { text: `original branch ${index}` }, dependencies: ['plan'] }))], routes: [{ agent: producer, workflow: 'host-plan', version: 1, maxAttempts: 1, outputKind: 'raw' }, ...(children ? [{ agent: research, workflow: 'host-research', version: 1, maxAttempts: 1, outputKind: 'raw' as const }] : [])] }, 'host-producer');
  const calls = vi.fn(); const worker = () => { const instance = new DurableWorker(durable); for (const name of ['host-plan', 'host-research']) instance.register({ name, version: 1, async run(input, ctx) { return ctx.step('candidate', { kind: 'replayable', input }, async () => { calls(ctx.task); return input; }); } }); return instance; };
  const host = (id = 'host-worker') => new AgentDispatchHost({ tree, workerId: id, collaboration, durable, worker: worker(), pollIntervalMs: 50, maxExecutionsPerTick: 1 }); return { tree, scope, collaboration, host, worker, calls, root, producer };
}
it('runs a producer task and independent research branches through the actual durable journal', async () => {
  const f = await fixture(); const result = await f.host().run(new AbortController().signal); expect(result.reason).toBe('complete'); expect(result.last!.tasks.every(task => task.status === 'succeeded')).toBe(true); expect(f.calls).toHaveBeenCalledTimes(3);
  const tree = await f.collaboration.tree(f.tree); for (const task of tree.tasks) { expect(await durable.get({ tenantId: f.scope.tenantId, taskId: task.durableTaskId! })).toMatchObject({ status: 'succeeded', attempts: 1 }); }
  expect((await f.host('restart').run(new AbortController().signal)).reason).toBe('complete'); expect(f.calls).toHaveBeenCalledTimes(3);
});
it('does not flush another tree outbox or claim an older unrelated task in the same tenant', async () => {
  const f = await fixture(0); const foreignTree = { ...f.tree, treeId: randomUUID() }; await f.collaboration.createTree({ ...foreignTree, tasks: [{ ...f.root, taskId: 'foreign-plan' }], routes: [{ agent: f.producer, workflow: 'foreign-workflow', version: 1, maxAttempts: 1, outputKind: 'raw' }] }, 'host-producer'); await f.collaboration.queueReady(foreignTree);
  const unrelated = { tenantId: f.scope.tenantId, taskId: 'unrelated-older-job', workflow: 'unregistered-workflow', version: 1, input: { secret: 'other source' }, maxAttempts: 1, availableAt: new Date('2025-01-01T00:00:00Z') }; await durable.enqueue(unrelated);
  expect((await f.host().run(new AbortController().signal)).reason).toBe('complete'); expect(await durable.get(unrelated)).toMatchObject({ status: 'queued', attempts: 0, fence: 0 });
  const foreign = await f.collaboration.loadTask({ ...f.scope, taskId: 'foreign-plan' }); expect(await durable.get({ tenantId: f.scope.tenantId, taskId: foreign.durableTaskId! })).toBeNull(); expect((await f.collaboration.pending(f.scope, 100)).map(item => item.payload.taskId)).toEqual([foreign.durableTaskId]);
});
it('allows two host instances to coordinate the same tree without repeating effects', async () => {
  const f = await fixture(3); const results = await Promise.all([f.host('host-one').run(new AbortController().signal), f.host('host-two').run(new AbortController().signal)]); expect(results.every(result => result.reason === 'complete')).toBe(true); expect(f.calls).toHaveBeenCalledTimes(4);
  const stored = await f.collaboration.tree(f.tree); for (const item of stored.tasks) { const events = await durable.events({ tenantId: f.scope.tenantId, taskId: item.durableTaskId! }); expect(events.filter(event => event.action === 'claimed')).toHaveLength(1); }
});
it('keeps a human Question waiting across a stopped host and resumes from the persisted answer with a fresh host', async () => {
  const scope = { tenantId: randomUUID(), projectId: randomUUID() }; const tree = { ...scope, treeId: randomUUID() }; const key = { ...scope, taskId: 'logical-research' }; const calls = vi.fn(); const setup = inboxSetup(pool, { decision: calls });
  await setup.ledger.createProject({ ...scope, currency: 'CNY', limits: { steps: 24, tokens: 0, costMicros: 0 } }, 'host-producer'); await setup.collaboration.createTree({ ...tree, tasks: [{ taskId: key.taskId, parentId: null, agent: setup.agent, input: { text: 'original source' }, dependencies: [], scope: { ...scope, objectIds: ['source'] }, status: 'queued' }], routes: [{ agent: setup.agent, workflow: 'agent-inbox', version: 1, maxAttempts: 3, outputKind: 'agent_report' }] }, 'host-producer');
  const worker = new DurableWorker(durable); worker.register(setup.workflow); const host = new AgentDispatchHost({ tree, workerId: 'waiting-host', collaboration: setup.collaboration, durable, worker, pollIntervalMs: 50 }); const stop = new AbortController(); const running = host.run(stop.signal);
  await vi.waitFor(async () => { const saved = await setup.collaboration.loadTask(key); expect(saved.durableTaskId).not.toBeNull(); expect((await durable.get({ tenantId: scope.tenantId, taskId: saved.durableTaskId! }))?.status).toBe('waiting'); }, { timeout: 10000 });
  stop.abort(); expect((await running).reason).toBe('aborted'); const opened = await setup.collaboration.getQuestion(key, 'question-1'); expect(opened.question.status).toBe('open'); expect(calls).toHaveBeenCalledOnce();
  await setup.collaboration.answerQuestion(key, 'question-1', 'host-human', 'two', opened.question.questionDigest); const replacement = inboxSetup(pool, { decision: calls }); const next = new DurableWorker(durable); next.register(replacement.workflow);
  const resumed = new AgentDispatchHost({ tree, workerId: 'resumed-host', collaboration: replacement.collaboration, durable, worker: next, pollIntervalMs: 50 }); expect((await resumed.run(new AbortController().signal)).reason).toBe('complete'); expect(calls).toHaveBeenCalledTimes(2); expect((await replacement.collaboration.getQuestion(key, 'question-1')).delivery).toBe('delivered');
});

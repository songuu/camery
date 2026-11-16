import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { AgentRegistry } from '../src/registry.js';
import { relayOutbox } from '../src/relay.js';
import { PostgresCollaborationStore } from '../src/node/collaboration-store.js';
import { migrateAgents } from '../src/node/migrate.js';
const url = process.env['CAMERY_TEST_DATABASE_URL']; if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for collaboration tests');
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 }); const durable = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); await migrateAgents(pool); }); afterAll(async () => { await pool.end(); });
const contract = { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'], additionalProperties: false };
async function fixture(kind: 'raw' | 'agent_report' = 'raw', children = true) {
  const agents = new AgentRegistry(); const agent = agents.register({ id: 'research', version: '1.0.0', instructions: 'Return a scoped candidate only.', tools: [], methods: [], modelTier: 'deterministic', writeKinds: [], budget: { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' }, outputSchema: contract });
  const scope = { tenantId: randomUUID(), projectId: randomUUID() }; const treeKey = { ...scope, treeId: randomUUID() };
  const root = { taskId: 'plan', parentId: null, agent, input: { text: 'plan' }, dependencies: [], scope: { ...scope, objectIds: ['source-a'] }, status: 'queued' as const };
  const tasks = children ? [root, { ...root, taskId: 'research', parentId: root.taskId, input: { text: 'research' }, dependencies: [root.taskId] }] : [root];
  const definition = { ...treeKey, tasks, routes: [{ agent, workflow: 'collaboration-test', version: 1, maxAttempts: 1, outputKind: kind }] };
  const store = new PostgresCollaborationStore(pool, agents); await store.createTree(definition, 'host-producer'); return { agents, agent, scope, treeKey, definition, tasks, store, key: { ...scope, taskId: root.taskId } };
}
it('dispatches dependency-ready tasks once and unlocks children only after verified journal success', async () => {
  const f = await fixture(); expect(await f.store.queueReady(f.treeKey)).toHaveLength(1); expect(await f.store.queueReady(f.treeKey)).toHaveLength(0);
  const delivered = await Promise.all([relayOutbox(f.store, durable, f.scope), relayOutbox(f.store, durable, f.scope)]); expect(delivered.every(value => value.pending.length === 0)).toBe(true);
  const worker = new DurableWorker(durable); worker.register({ name: 'collaboration-test', version: 1, run: async input => input });
  expect((await worker.runOne(f.scope.tenantId, 'plan-worker'))?.status).toBe('succeeded'); expect((await f.store.syncTask(f.key)).task.status).toBe('succeeded');
  const ready = await Promise.all([f.store.queueReady(f.treeKey), f.store.queueReady(f.treeKey)]); expect(ready.flat()).toHaveLength(1); await relayOutbox(f.store, durable, f.scope);
  expect((await worker.runOne(f.scope.tenantId, 'research-worker'))?.status).toBe('succeeded'); expect((await f.store.syncTask({ ...f.scope, taskId: 'research' })).task.output).toEqual({ text: 'research' });
  expect(await f.store.queueReady(f.treeKey)).toHaveLength(0); expect((await f.store.tree(f.treeKey)).tasks.every(value => value.task.status === 'succeeded')).toBe(true);
});
it('does not turn a blocked or wrong-contract agent report into dependency success', async () => {
  const f = await fixture('agent_report'); await f.store.queueReady(f.treeKey); await relayOutbox(f.store, durable, f.scope);
  const worker = new DurableWorker(durable); worker.register({ name: 'collaboration-test', version: 1, run: async () => ({ state: 'blocked', agent: f.agent, output: null, reason: 'BUDGET_LIMIT' }) });
  expect((await worker.runOne(f.scope.tenantId, 'blocked'))?.status).toBe('succeeded'); expect((await f.store.syncTask(f.key)).task).toMatchObject({ status: 'failed', errorCode: 'AGENT_BLOCKED' }); expect(await f.store.queueReady(f.treeKey)).toHaveLength(0);
});
it('stores early answers and retries delivery only when the exact gate exists, including an ACK lost after success', async () => {
  const f = await fixture('raw', false); await f.store.queueReady(f.treeKey); await relayOutbox(f.store, durable, f.scope);
  const input = { questionId: 'source-choice', taskId: f.key.taskId, scope: f.scope, objectIds: ['source-a'], prompt: 'Which source?', choices: ['one', 'two'] };
  const opened = await f.store.openQuestion(f.key, input, 'host-agent', 'answer');
  await f.store.answerQuestion(f.key, input.questionId, 'host-human', 'two', opened.question.questionDigest);
  expect(await relayOutbox(f.store, durable, f.scope)).toMatchObject({ pending: [{ code: 'RELAY_NOT_READY' }] }); expect((await f.store.getQuestion(f.key, input.questionId)).delivery).toBe('pending');
  const worker = new DurableWorker(durable); worker.register({ name: 'collaboration-test', version: 1, async run(_input, ctx) { const result = await ctx.waitForSignal('answer', JSON.parse(JSON.stringify(opened.question))) as { answer: string }; return { text: result.answer }; } });
  expect((await worker.runOne(f.scope.tenantId, 'question-worker'))?.status).toBe('waiting');
  const ack = vi.spyOn(f.store, 'acknowledge').mockRejectedValueOnce(new Error('synthetic acknowledgement loss'));
  try { expect((await relayOutbox(f.store, durable, f.scope)).pending).toHaveLength(1); expect((await worker.runOne(f.scope.tenantId, 'resumed'))?.status).toBe('succeeded'); expect((await relayOutbox(f.store, durable, f.scope)).pending).toHaveLength(0); }
  finally { ack.mockRestore(); }
  expect((await f.store.getQuestion(f.key, input.questionId)).delivery).toBe('delivered'); expect((await f.store.syncTask(f.key)).task.output).toEqual({ text: 'two' });
});
it.each(['read', 'answer'] as const)('captures the authenticated question key before waiting for a database connection: %s', async operation => {
  const f = await fixture('raw', false); const other = await fixture('raw', false);
  const body = { questionId: 'q', taskId: f.key.taskId, scope: f.scope, objectIds: ['source-a'], prompt: 'original scope', choices: ['one', 'two'] };
  const opened = await f.store.openQuestion(f.key, body, 'host-agent'); await other.store.openQuestion(other.key, { ...body, scope: other.scope, prompt: 'other scope private data' }, 'host-agent');
  const original = pool.connect.bind(pool); let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const connect = vi.spyOn(pool, 'connect').mockImplementationOnce((async () => { await gate; return original(); }) as never); const key = { ...f.key };
  try {
    const pending = operation === 'read' ? f.store.getQuestion(key, 'q') : f.store.answerQuestion(key, 'q', 'host-human', 'one', opened.question.questionDigest);
    key.tenantId = other.key.tenantId; key.projectId = other.key.projectId; release();
    expect((await pending).question).toMatchObject({ scope: f.scope, prompt: 'original scope', status: operation === 'read' ? 'open' : 'answered' });
  } finally { release(); connect.mockRestore(); }
});
it('captures Issue content before waiting and exposes every stored Issue through explicit pages', async () => {
  const f = await fixture('raw', false); const issue = { issueId: 'issue-000', taskId: f.key.taskId, scope: f.scope, objectId: 'source-a', path: '', severity: 'major' as const, problem: 'original issue', audienceImpact: 'The source is unclear.', suggestion: 'Clarify the source.', ripple: [], evidenceScope: 'text' as const };
  const original = pool.connect.bind(pool); let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); const connect = vi.spyOn(pool, 'connect').mockImplementationOnce((async () => { await gate; return original(); }) as never);
  try { const pending = f.store.putIssue(f.key, issue, 'host-reviewer'); issue.problem = 'mutated during connection'; release(); await pending; }
  finally { release(); connect.mockRestore(); }
  const first = await f.store.listIssues(f.key); expect(first.items[0]?.problem).toBe('original issue');
  for (let index = 1; index <= 100; index++) await f.store.putIssue(f.key, { ...issue, issueId: `issue-${String(index).padStart(3, '0')}`, severity: index === 100 ? 'critical' : 'major' }, 'host-reviewer');
  const ids: string[] = []; let afterId: string | undefined;
  do { const page = await f.store.listIssues(f.key, { limit: 40, ...(afterId ? { afterId } : {}) }); ids.push(...page.items.map(value => value.issueId)); afterId = page.nextCursor ?? undefined; } while (afterId);
  expect(ids).toHaveLength(101); expect(new Set(ids).size).toBe(101); expect(ids.at(-1)).toBe('issue-100');
});
it('does not acknowledge a signal accepted by a same-named gate for another question', async () => {
  const f = await fixture('raw', false); await f.store.queueReady(f.treeKey); await relayOutbox(f.store, durable, f.scope);
  const opened = await f.store.openQuestion(f.key, { questionId: 'q', taskId: f.key.taskId, scope: f.scope, objectIds: ['source-a'], prompt: 'Choose', choices: ['one', 'two'] }, 'host-agent', 'answer'); await f.store.answerQuestion(f.key, 'q', 'host-human', 'one', opened.question.questionDigest);
  const item = (await f.store.pending(f.scope, 100))[0]!; if (item.kind !== 'signal') throw new Error('Expected answer outbox');
  const worker = new DurableWorker(durable); worker.register({ name: 'collaboration-test', version: 1, run: async (_input, ctx) => ctx.waitForSignal('answer', { questionDigest: 'wrong-question' }) });
  await worker.runOne(f.scope.tenantId, 'wrong-gate'); await durable.signal(item.payload);
  await expect(f.store.acknowledge(f.scope, item.outboxId, item.digest)).rejects.toMatchObject({ code: 'DELIVERY_UNCONFIRMED' }); expect((await f.store.getQuestion(f.key, 'q')).delivery).toBe('pending');
});
it('rotates failed outbox batches so a finite failed prefix cannot starve newer jobs', async () => {
  const f = await fixture('raw', false); await f.store.queueReady(f.treeKey); await relayOutbox(f.store, durable, f.scope); const physical = (await f.store.loadTask(f.key)).durableTaskId!;
  for (let index = 0; index < 100; index++) {
    const opened = await f.store.openQuestion(f.key, { questionId: `q-${index}`, taskId: f.key.taskId, scope: f.scope, objectIds: ['source-a'], prompt: 'Choose', choices: ['one', 'two'] }, 'host-agent', `gate-${index}`);
    await f.store.answerQuestion(f.key, `q-${index}`, 'host-human', 'one', opened.question.questionDigest);
  }
  await durable.cancel({ tenantId: f.scope.tenantId, taskId: physical }, 'host-operator');
  const nextKey = { ...f.treeKey, treeId: randomUUID() }; await f.store.createTree({ ...f.definition, ...nextKey, tasks: [{ ...f.tasks[0]!, taskId: 'new-job', input: { text: 'new work' } }] }, 'host-producer'); await f.store.queueReady(nextKey);
  await relayOutbox(f.store, durable, f.scope); await relayOutbox(f.store, durable, f.scope);
  const next = await f.store.loadTask({ ...f.scope, taskId: 'new-job' }); expect(await durable.get({ tenantId: f.scope.tenantId, taskId: next.durableTaskId! })).not.toBeNull();
});

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import type { Json, Workflow } from '@camery/durable';
import { canonical } from '@camery/methods';
import { AgentRegistry } from '../src/registry.js';
import type { AgentIssue, AgentTask } from '../src/collaboration.js';
import { relayOutbox } from '../src/relay.js';
import { PostgresCollaborationStore } from '../src/node/collaboration-store.js';
import { migrateAgents } from '../src/node/migrate.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for collaboration invariant tests');
const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000 }); const durable = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); await migrateAgents(pool); }); afterAll(async () => { await pool.end(); });
const contract = { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'], additionalProperties: false };
async function fixture(options: { outputKind?: 'raw' | 'agent_report'; persist?: boolean } = {}) {
  const agents = new AgentRegistry(); const agent = agents.register({ id: 'research', version: '1.0.0', instructions: 'Propose a scoped candidate only.', tools: [], methods: [], modelTier: 'deterministic', writeKinds: [],
    budget: { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' }, outputSchema: contract });
  const scope = { tenantId: randomUUID(), projectId: randomUUID() }; const treeKey = { ...scope, treeId: randomUUID() }; const key = { ...scope, taskId: 'plan' };
  const root: AgentTask = { taskId: 'plan', parentId: null, agent, input: { text: 'plan' }, dependencies: [], scope: { ...scope, objectIds: ['source-a'] }, status: 'queued' };
  const tasks: AgentTask[] = [root, { ...root, taskId: 'research', parentId: root.taskId, input: { text: 'research' }, dependencies: [root.taskId] }];
  const definition = { ...treeKey, tasks, routes: [{ agent, workflow: 'collaboration-invariants', version: 1, maxAttempts: 1, outputKind: options.outputKind ?? 'raw' }] };
  const store = new PostgresCollaborationStore(pool, agents); if (options.persist !== false) await store.createTree(definition, 'host-producer');
  return { agents, agent, scope, treeKey, key, definition, tasks, store };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function dispatched(f: Fixture) {
  await f.store.queueReady(f.treeKey); const result = await relayOutbox(f.store, durable, f.scope); expect(result.pending).toEqual([]);
  const saved = await f.store.loadTask(f.key); if (!saved.durableTaskId) throw new Error('Expected the actual dispatched task identity'); return { tenantId: f.scope.tenantId, taskId: saved.durableTaskId };
}
function worker(run: Workflow['run']) { const worker = new DurableWorker(durable); worker.register({ name: 'collaboration-invariants', version: 1, run }); return worker; }
function finding(f: Fixture, issueId = 'issue-a'): AgentIssue {
  return { issueId, taskId: f.key.taskId, scope: f.scope, objectId: 'source-a', path: '/text', severity: 'major', problem: 'The source is ambiguous.', audienceImpact: 'The reveal cannot be followed.', suggestion: 'Identify the source.', ripple: ['Recheck the dependent scene.'], evidenceScope: 'text' };
}
const question = (f: Fixture) => ({ questionId: 'choose-source', taskId: f.key.taskId, scope: f.scope, objectIds: ['source-a'], prompt: 'Which source version?', choices: ['one', 'two'] });

it.each(['pre-succeeded', 'duplicate-task', 'extra-unregistered-route'] as const)('rejects forged task-tree declarations before persistence: %s', async kind => {
  const f = await fixture({ persist: false }); const definition = structuredClone(f.definition);
  if (kind === 'pre-succeeded') definition.tasks[0] = { ...definition.tasks[0]!, status: 'succeeded', output: { text: 'forged success' } };
  if (kind === 'duplicate-task') definition.tasks.push(structuredClone(definition.tasks[0]!));
  if (kind === 'extra-unregistered-route') definition.routes.push({ ...definition.routes[0]!, agent: { id: 'unknown-role', version: '1.0.0', digest: 'f'.repeat(64) } });
  await expect(f.store.createTree(definition, 'host-producer')).rejects.toThrow();
  const rows = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM camery_agents.agent_trees WHERE tenant_id=$1 AND project_id=$2', [f.scope.tenantId, f.scope.projectId]); expect(rows.rows[0]!.count).toBe('0');
});
it('keeps an exact tree declaration idempotent but rejects changed routes and task inputs', async () => {
  const f = await fixture(); const original = await f.store.tree(f.treeKey); expect(await f.store.createTree(f.definition, 'second-host')).toEqual(original);
  const route = { ...f.definition.routes[0]!, version: 2 };
  await expect(f.store.createTree({ ...f.definition, routes: [route] }, 'host-producer')).rejects.toMatchObject({ code: 'TASK_TREE_CONFLICT' });
  const tasks = structuredClone(f.tasks); tasks[0]!.input = { text: 'changed' };
  await expect(f.store.createTree({ ...f.definition, tasks }, 'host-producer')).rejects.toMatchObject({ code: 'TASK_TREE_CONFLICT' }); expect(await f.store.tree(f.treeKey)).toEqual(original);
});
it('isolates task/tree reads and physical assignments by tenant and project', async () => {
  const f = await fixture(); const physical = await dispatched(f);
  await expect(f.store.loadTask({ ...f.key, tenantId: randomUUID() })).rejects.toThrow(); await expect(f.store.loadTask({ ...f.key, projectId: randomUUID() })).rejects.toThrow();
  await expect(f.store.tree({ ...f.treeKey, tenantId: randomUUID() })).rejects.toThrow(); await expect(f.store.tree({ ...f.treeKey, projectId: randomUUID() })).rejects.toThrow();
  await expect(f.store.assignment({ ...physical, tenantId: randomUUID() })).rejects.toMatchObject({ code: 'AGENT_TASK_NOT_FOUND' });
  await expect(f.store.assignment({ tenantId: f.scope.tenantId, taskId: f.key.taskId })).rejects.toMatchObject({ code: 'AGENT_TASK_NOT_FOUND' });
  expect(await f.store.assignment(physical)).toEqual(await f.store.loadTask(f.key));
});
it('leaves undispatched and unacknowledged work queued instead of inferring execution', async () => {
  const f = await fixture(); const initial = await f.store.loadTask(f.key); expect(await f.store.syncTask(f.key)).toEqual(initial);
  await f.store.queueReady(f.treeKey); const staged = await f.store.loadTask(f.key); expect(staged.task.status).toBe('queued'); expect(staged.durableTaskId).not.toBeNull();
  expect(await durable.get({ tenantId: f.scope.tenantId, taskId: staged.durableTaskId! })).toBeNull(); expect(await f.store.syncTask(f.key)).toEqual(staged);
  expect(await f.store.queueReady(f.treeKey)).toEqual([]); expect((await f.store.loadTask({ ...f.scope, taskId: 'research' })).durableTaskId).toBeNull();
});
it.each(['workflow', 'version', 'input'] as const)('rejects a conflicting actual journal %s', async field => {
  const f = await fixture(); const physical = await dispatched(f); const initial = await f.store.loadTask(f.key);
  if (field === 'workflow') await pool.query('UPDATE camery_durable.tasks SET workflow=$3 WHERE tenant_id=$1 AND task_id=$2', [physical.tenantId, physical.taskId, 'different-workflow']);
  if (field === 'version') await pool.query('UPDATE camery_durable.tasks SET version=$3 WHERE tenant_id=$1 AND task_id=$2', [physical.tenantId, physical.taskId, 2]);
  if (field === 'input') await pool.query('UPDATE camery_durable.tasks SET input=$3::jsonb WHERE tenant_id=$1 AND task_id=$2', [physical.tenantId, physical.taskId, canonical({ text: 'different-input' })]);
  await expect(f.store.syncTask(f.key)).rejects.toMatchObject({ code: 'DURABLE_JOB_CONFLICT' }); expect(await f.store.loadTask(f.key)).toEqual(initial);
  expect((await f.store.loadTask({ ...f.scope, taskId: 'research' })).durableTaskId).toBeNull();
});
it.each(['workflow', 'version', 'input'] as const)('rejects a stored job %s that no longer matches the pinned route and task', async field => {
  const f = await fixture(); await f.store.queueReady(f.treeKey);
  const result = await pool.query<{ job: Record<string, unknown> }>('SELECT job FROM camery_agents.agent_tasks WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3', [f.key.tenantId, f.key.projectId, f.key.taskId]);
  const job = result.rows[0]!.job; job[field] = field === 'workflow' ? 'different-workflow' : field === 'version' ? 2 : { text: 'different-input' };
  await pool.query('UPDATE camery_agents.agent_tasks SET job=$4::jsonb WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3', [f.key.tenantId, f.key.projectId, f.key.taskId, canonical(job)]);
  await expect(f.store.loadTask(f.key)).rejects.toMatchObject({ code: 'COLLABORATION_DATA_CORRUPT' }); await expect(f.store.queueReady(f.treeKey)).rejects.toThrow();
});
it.each(['raw-shape', 'report-shape', 'report-pin', 'report-output'] as const)('does not unlock a dependent task from malformed candidate output: %s', async kind => {
  const f = await fixture({ outputKind: kind === 'raw-shape' ? 'raw' : 'agent_report' }); await dispatched(f);
  const output: Json = kind === 'raw-shape' ? { wrong: true } : kind === 'report-shape' ? { output: { text: 'looks valid' } }
    : { state: 'candidate', agent: kind === 'report-pin' ? { ...f.agent, digest: 'f'.repeat(64) } : f.agent, output: kind === 'report-output' ? { wrong: true } : { text: 'looks valid' } };
  const run = worker(async () => output); expect((await run.runOne(f.scope.tenantId, 'invalid-output-worker'))?.status).toBe('succeeded');
  const synced = await f.store.syncTask(f.key); expect(synced.task).toMatchObject({ status: 'failed', errorCode: 'AGENT_OUTPUT_INVALID' }); expect(await f.store.queueReady(f.treeKey)).toEqual([]);
  expect((await f.store.loadTask({ ...f.scope, taskId: 'research' })).task.status).toBe('queued');
});
it.each(['failed', 'cancelled'] as const)('keeps logical %s terminal and repeated syncs idempotent even after a contradictory late journal snapshot', async status => {
  const f = await fixture(); const physical = await dispatched(f);
  if (status === 'failed') await worker(async () => { throw new Error('synthetic failure'); }).runOne(f.scope.tenantId, 'failing-worker'); else await durable.cancel(physical, 'host-operator');
  const snapshots = await Promise.all([f.store.syncTask(f.key), f.store.syncTask(f.key)]); expect(snapshots[0]).toEqual(snapshots[1]); expect(snapshots[0]!.task.status).toBe(status);
  await pool.query("UPDATE camery_durable.tasks SET status='succeeded',output=$3::jsonb WHERE tenant_id=$1 AND task_id=$2", [physical.tenantId, physical.taskId, canonical({ text: 'late contradictory output' })]);
  expect(await f.store.syncTask(f.key)).toEqual(snapshots[0]); expect(await f.store.queueReady(f.treeKey)).toEqual([]);
  const events = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM camery_agents.agent_events WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND action='task_synchronized'", [f.key.tenantId, f.key.projectId, f.key.taskId]); expect(events.rows[0]!.count).toBe('1');
});
it('maps an uncertain external step to waiting and unlocks no dependents before explicit reconciliation', async () => {
  const f = await fixture(); const physical = await dispatched(f);
  const run = worker(async (_input, ctx) => ctx.step('uncertain', { kind: 'external', input: null }, async () => { throw new Error('synthetic unknown result'); }));
  expect((await run.runOne(f.scope.tenantId, 'uncertain-worker'))?.status).toBe('reconciling'); const waiting = await f.store.syncTask(f.key); expect(waiting.task.status).toBe('waiting');
  expect(await f.store.syncTask(f.key)).toEqual(waiting); expect(await f.store.queueReady(f.treeKey)).toEqual([]);
  await durable.reconcile({ ...physical, stepKey: 'uncertain', actorId: 'host-operator', resolution: { kind: 'completed', output: { text: 'verified remote result' } } });
  expect((await run.runOne(f.scope.tenantId, 'reconciled-worker'))?.status).toBe('succeeded'); expect((await f.store.syncTask(f.key)).task.output).toEqual({ text: 'verified remote result' }); expect(await f.store.queueReady(f.treeKey)).toHaveLength(1);
});
it('rejects Issue scope/object expansion, preserves immutable identities and validates page boundaries', async () => {
  const f = await fixture(); const issue = finding(f);
  for (const wrong of [{ ...issue, taskId: 'research' }, { ...issue, scope: { ...f.scope, tenantId: randomUUID() } }, { ...issue, scope: { ...f.scope, projectId: randomUUID() } }, { ...issue, objectId: 'outside-scope' }]) await expect(f.store.putIssue(f.key, wrong, 'host-reviewer')).rejects.toMatchObject({ code: 'ISSUE_SCOPE' });
  for (const id of ['a', 'b', 'c']) await f.store.putIssue(f.key, { ...issue, issueId: id }, 'host-reviewer'); await f.store.putIssue(f.key, { ...issue, issueId: 'a' }, 'second-host');
  await expect(f.store.putIssue(f.key, { ...issue, issueId: 'a', problem: 'Changed finding under the same identity.' }, 'host-reviewer')).rejects.toMatchObject({ code: 'ISSUE_CONFLICT' });
  const first = await f.store.listIssues(f.key, { limit: 2 }); expect(first.items.map(value => value.issueId)).toEqual(['a', 'b']); expect(first.nextCursor).toBe('b');
  const second = await f.store.listIssues(f.key, { limit: 2, afterId: first.nextCursor! }); expect(second.items.map(value => value.issueId)).toEqual(['c']); expect(second.nextCursor).toBeNull();
  expect(await f.store.listIssues(f.key, { afterId: 'z' })).toEqual({ items: [], nextCursor: null });
  for (const options of [{ limit: 0 }, { limit: 101 }, { afterId: '' }]) await expect(f.store.listIssues(f.key, options)).rejects.toThrow();
});
it('answers a no-gate Question exactly once without creating a durable signal or manufacturing approval', async () => {
  const f = await fixture(); const input = question(f); const opened = await f.store.openQuestion(f.key, input, 'host-agent');
  expect(await f.store.openQuestion(f.key, input, 'second-host')).toEqual(opened);
  await expect(f.store.openQuestion(f.key, { ...input, prompt: 'Changed question under the same identity.' }, 'host-agent')).rejects.toMatchObject({ code: 'QUESTION_CONFLICT' });
  await expect(f.store.openQuestion(f.key, { ...input, questionId: 'outside', objectIds: ['outside-scope'] }, 'host-agent')).rejects.toMatchObject({ code: 'QUESTION_SCOPE' });
  await expect(f.store.answerQuestion(f.key, input.questionId, 'host-human', 'one', 'f'.repeat(64))).rejects.toMatchObject({ code: 'STALE_QUESTION' });
  await expect(f.store.answerQuestion({ ...f.key, projectId: randomUUID() }, input.questionId, 'host-human', 'one', opened.question.questionDigest)).rejects.toThrow();
  const answered = await f.store.answerQuestion(f.key, input.questionId, 'host-human', 'one', opened.question.questionDigest); expect(answered.delivery).toBe('none'); expect(answered.question).toMatchObject({ status: 'answered', answer: { actorId: 'host-human', value: 'one' } });
  expect(await f.store.answerQuestion(f.key, input.questionId, 'host-human', 'one', opened.question.questionDigest)).toEqual(answered);
  for (const [actor, answer] of [['other-human', 'one'], ['host-human', 'two']]) await expect(f.store.answerQuestion(f.key, input.questionId, actor!, answer!, opened.question.questionDigest)).rejects.toMatchObject({ code: 'QUESTION_CONFLICT' });
  expect(await f.store.pending(f.scope, 100)).toEqual([]); expect((await f.store.loadTask(f.key)).task.status).toBe('queued');
});
it('refuses to ACK enqueue or signal outbox records without the matching durable side effect', async () => {
  const f = await fixture(); await f.store.queueReady(f.treeKey); const item = (await f.store.pending(f.scope, 100))[0]!;
  await expect(f.store.acknowledge(f.scope, item.outboxId, item.digest)).rejects.toMatchObject({ code: 'DELIVERY_UNCONFIRMED' });
  await expect(f.store.acknowledge(f.scope, item.outboxId, 'f'.repeat(64))).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' });
  await relayOutbox(f.store, durable, f.scope); await f.store.acknowledge(f.scope, item.outboxId, item.digest);
  const opened = await f.store.openQuestion(f.key, question(f), 'host-agent', 'answer'); await f.store.answerQuestion(f.key, opened.question.questionId, 'host-human', 'one', opened.question.questionDigest);
  const answer = (await f.store.pending(f.scope, 100))[0]!; expect(answer.kind).toBe('signal'); await expect(f.store.acknowledge(f.scope, answer.outboxId, answer.digest)).rejects.toMatchObject({ code: 'DELIVERY_UNCONFIRMED' });
  expect((await f.store.getQuestion(f.key, opened.question.questionId)).delivery).toBe('pending');
});
async function faultEvent(f: Fixture, action: string, run: () => Promise<void>) {
  const name = `collaboration_fault_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE FUNCTION camery_agents.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.scope.tenantId}' AND NEW.action='${action}' THEN RAISE EXCEPTION 'untrusted test diagnostic'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON camery_agents.agent_events FOR EACH ROW EXECUTE FUNCTION camery_agents.${name}()`);
  try { await run(); } finally { await pool.query(`DROP TRIGGER ${name} ON camery_agents.agent_events`); await pool.query(`DROP FUNCTION camery_agents.${name}()`); }
}
it('rolls a new project/tree/tasks back when the final creation audit write fails', async () => {
  const f = await fixture({ persist: false });
  await faultEvent(f, 'tree_created', async () => {
    await expect(f.store.createTree(f.definition, 'host-producer')).rejects.toMatchObject({ code: 'AGENT_STORAGE_FAILED' });
    for (const table of ['agent_projects', 'agent_trees', 'agent_tasks'] as const) { const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM camery_agents.${table} WHERE tenant_id=$1 AND project_id=$2`, [f.scope.tenantId, f.scope.projectId]); expect(result.rows[0]!.count).toBe('0'); }
  });
  expect((await f.store.createTree(f.definition, 'host-producer')).tasks).toHaveLength(2);
});
it('rolls queued mapping and outbox back when the queue audit write fails', async () => {
  const f = await fixture(); const before = await f.store.loadTask(f.key);
  await faultEvent(f, 'task_queued', async () => { await expect(f.store.queueReady(f.treeKey)).rejects.toMatchObject({ code: 'AGENT_STORAGE_FAILED' }); expect(await f.store.loadTask(f.key)).toEqual(before); expect(await f.store.pending(f.scope, 100)).toEqual([]); });
  expect(await f.store.queueReady(f.treeKey)).toHaveLength(1);
});
it('rolls the answer and signal outbox back when the final answer audit write fails', async () => {
  const f = await fixture(); await dispatched(f); const opened = await f.store.openQuestion(f.key, question(f), 'host-agent', 'answer');
  await faultEvent(f, 'question_answered', async () => {
    await expect(f.store.answerQuestion(f.key, opened.question.questionId, 'host-human', 'one', opened.question.questionDigest)).rejects.toMatchObject({ code: 'AGENT_STORAGE_FAILED' });
    expect(await f.store.getQuestion(f.key, opened.question.questionId)).toEqual(opened); expect(await f.store.pending(f.scope, 100)).toEqual([]);
  });
  expect((await f.store.answerQuestion(f.key, opened.question.questionId, 'host-human', 'one', opened.question.questionDigest)).delivery).toBe('pending');
});

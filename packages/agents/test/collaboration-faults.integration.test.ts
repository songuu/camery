import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { canonical, digest } from '@camery/methods';
import { AgentRegistry } from '../src/registry.js';
import { PostgresCollaborationStore } from '../src/node/collaboration-store.js';
import { migrateAgents } from '../src/node/migrate.js';
import { relayOutbox } from '../src/relay.js';

const url = process.env['CAMERY_TEST_DATABASE_URL'];
if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for collaboration fault tests');
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 }); const durable = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); await migrateAgents(pool); }); afterAll(async () => { await pool.end(); });
async function fixture(persist = true) {
  const agents = new AgentRegistry(); const agent = agents.register({ id: 'research', version: '1.0.0', instructions: 'Return scoped text.', tools: [], methods: [], modelTier: 'deterministic', writeKinds: [], budget: { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' }, outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const scope = { tenantId: randomUUID(), projectId: randomUUID() }; const treeKey = { ...scope, treeId: randomUUID() }; const key = { ...scope, taskId: 'root' };
  const task = { taskId: key.taskId, parentId: null, agent, input: { text: 'source' }, dependencies: [], scope: { ...scope, objectIds: ['source'] }, status: 'queued' as const };
  const definition = { ...treeKey, tasks: [task], routes: [{ agent, workflow: 'collaboration-faults', version: 1, maxAttempts: 1, outputKind: 'raw' as const }] };
  const store = new PostgresCollaborationStore(pool, agents); if (persist) await store.createTree(definition, 'host');
  const issue = { issueId: 'finding', taskId: key.taskId, scope, objectId: 'source', path: '/text', severity: 'major' as const, problem: 'Ambiguous source.', audienceImpact: 'Unclear reveal.', suggestion: 'Identify source.', ripple: [], evidenceScope: 'text' as const };
  const question = { questionId: 'choice', taskId: key.taskId, scope, objectIds: ['source'], prompt: 'Which version?', choices: ['one', 'two'] };
  return { store, scope, treeKey, key, task, definition, issue, question };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const tables = ['agent_projects', 'agent_trees', 'agent_tasks', 'agent_outbox', 'agent_issues', 'agent_questions', 'agent_events'] as const;
async function snapshot(f: Fixture) {
  return Promise.all(tables.map(async table => (await pool.query<{ value: unknown }>(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM camery_agents.${table} t WHERE tenant_id=$1 AND project_id=$2`, [f.scope.tenantId, f.scope.projectId])).rows[0]!.value));
}
async function suppress(f: Fixture, table: typeof tables[number], operation: 'INSERT' | 'UPDATE', run: () => Promise<unknown>) {
  const name = `collaboration_zero_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE FUNCTION camery_agents.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.scope.tenantId}' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE ${operation} ON camery_agents.${table} FOR EACH ROW EXECUTE FUNCTION camery_agents.${name}()`);
  const before = await snapshot(f);
  try { await expect(run()).rejects.toThrow(); expect(await snapshot(f)).toEqual(before); }
  finally { await pool.query(`DROP TRIGGER ${name} ON camery_agents.${table}`); await pool.query(`DROP FUNCTION camery_agents.${name}()`); }
}
it.each(['agent_trees', 'agent_tasks', 'agent_events'] as const)('does not report tree creation after a zero-row %s insert', async table => {
  const f = await fixture(false); await suppress(f, table, 'INSERT', () => f.store.createTree(f.definition, 'host')); expect((await f.store.createTree(f.definition, 'host')).tasks).toHaveLength(1);
});
it.each(['agent_outbox', 'agent_tasks', 'agent_events'] as const)('rolls queue mapping and outbox back on a zero-row %s write', async table => {
  const f = await fixture(); await suppress(f, table, table === 'agent_tasks' ? 'UPDATE' : 'INSERT', () => f.store.queueReady(f.treeKey)); expect(await f.store.queueReady(f.treeKey)).toHaveLength(1);
});
it('does not save an Issue or Question after a zero-row insert', async () => {
  const f = await fixture(); await suppress(f, 'agent_issues', 'INSERT', () => f.store.putIssue(f.key, f.issue, 'host-reviewer')); await suppress(f, 'agent_questions', 'INSERT', () => f.store.openQuestion(f.key, f.question, 'host-agent'));
  expect((await f.store.listIssues(f.key)).items).toEqual([]); await expect(f.store.getQuestion(f.key, 'choice')).rejects.toMatchObject({ code: 'QUESTION_NOT_FOUND' });
});
it('rolls an answered record and signal back when its Question CAS affects zero rows', async () => {
  const f = await fixture(); await f.store.queueReady(f.treeKey); const opened = await f.store.openQuestion(f.key, f.question, 'host-agent', 'answer');
  await suppress(f, 'agent_questions', 'UPDATE', () => f.store.answerQuestion(f.key, 'choice', 'human', 'one', opened.question.questionDigest)); expect(await f.store.getQuestion(f.key, 'choice')).toEqual(opened);
});
it('rejects a failed rotation update and a failed acknowledgement update without losing queued work', async () => {
  const f = await fixture(); await f.store.queueReady(f.treeKey); await suppress(f, 'agent_outbox', 'UPDATE', () => f.store.pending(f.scope, 100));
  const item = (await f.store.pending(f.scope, 100))[0]!; if (item.kind !== 'enqueue') throw new Error('Expected enqueue'); await durable.enqueue({ ...item.payload, availableAt: new Date(item.payload.availableAt) });
  await suppress(f, 'agent_outbox', 'UPDATE', () => f.store.acknowledge(f.scope, item.outboxId, item.digest)); await f.store.acknowledge(f.scope, item.outboxId, item.digest); expect(await f.store.pending(f.scope, 100)).toEqual([]);
});
it('rolls synchronized status back when the logical task CAS affects zero rows', async () => {
  const f = await fixture(); await f.store.queueReady(f.treeKey); await relayOutbox(f.store, durable, f.scope); const worker = new DurableWorker(durable); worker.register({ name: 'collaboration-faults', version: 1, run: async input => input }); await worker.runOne(f.scope.tenantId, 'worker');
  await suppress(f, 'agent_tasks', 'UPDATE', () => f.store.syncTask(f.key)); expect((await f.store.syncTask(f.key)).task.status).toBe('succeeded');
});
it.each(['header-digest', 'missing-task', 'changed-task', 'job-id'] as const)('rejects damaged tree state before it can dispatch: %s', async kind => {
  const f = await fixture();
  if (kind === 'header-digest') await pool.query("UPDATE camery_agents.agent_trees SET definition_digest=$3 WHERE tenant_id=$1 AND project_id=$2", [f.scope.tenantId, f.scope.projectId, 'f'.repeat(64)]);
  if (kind === 'missing-task') await pool.query('DELETE FROM camery_agents.agent_tasks WHERE tenant_id=$1 AND project_id=$2', [f.scope.tenantId, f.scope.projectId]);
  if (kind === 'changed-task') await pool.query('UPDATE camery_agents.agent_tasks SET record=$3::jsonb WHERE tenant_id=$1 AND project_id=$2', [f.scope.tenantId, f.scope.projectId, canonical({ ...f.task, input: { text: 'tampered' } })]);
  if (kind === 'job-id') { await f.store.queueReady(f.treeKey); await pool.query("UPDATE camery_agents.agent_tasks SET durable_task_id='wrong' WHERE tenant_id=$1 AND project_id=$2", [f.scope.tenantId, f.scope.projectId]); }
  await expect(f.store.queueReady(f.treeKey)).rejects.toMatchObject({ code: 'COLLABORATION_DATA_CORRUPT' });
});
it('enforces a complete physical-task/job pair at the database boundary', async () => {
  const f = await fixture(); await expect(pool.query("UPDATE camery_agents.agent_tasks SET durable_task_id='orphan' WHERE tenant_id=$1 AND project_id=$2", [f.scope.tenantId, f.scope.projectId])).rejects.toMatchObject({ code: '23514' });
  expect((await f.store.loadTask(f.key)).durableTaskId).toBeNull(); expect(await f.store.queueReady(f.treeKey)).toHaveLength(1);
});
it.each(['issue-id', 'issue-digest', 'question-body', 'outbox-id', 'outbox-digest'] as const)('refuses a corrupted inbox/outbox record: %s', async kind => {
  const f = await fixture();
  if (kind.startsWith('issue')) { await f.store.putIssue(f.key, f.issue, 'reviewer'); if (kind === 'issue-id') await pool.query("UPDATE camery_agents.agent_issues SET issue_id='changed' WHERE tenant_id=$1 AND project_id=$2", [f.scope.tenantId, f.scope.projectId]); else await pool.query('UPDATE camery_agents.agent_issues SET record_digest=$3 WHERE tenant_id=$1 AND project_id=$2', [f.scope.tenantId, f.scope.projectId, 'f'.repeat(64)]); await expect(f.store.listIssues(f.key)).rejects.toMatchObject({ code: 'COLLABORATION_DATA_CORRUPT' }); }
  else if (kind === 'question-body') { await f.store.openQuestion(f.key, f.question, 'agent'); await pool.query("UPDATE camery_agents.agent_questions SET record=jsonb_set(record,'{prompt}',to_jsonb('changed'::text)) WHERE tenant_id=$1 AND project_id=$2", [f.scope.tenantId, f.scope.projectId]); await expect(f.store.getQuestion(f.key, 'choice')).rejects.toMatchObject({ code: 'COLLABORATION_DATA_CORRUPT' }); }
  else { await f.store.queueReady(f.treeKey); if (kind === 'outbox-id') await pool.query("UPDATE camery_agents.agent_outbox SET outbox_id='changed' WHERE tenant_id=$1 AND project_id=$2", [f.scope.tenantId, f.scope.projectId]); else await pool.query('UPDATE camery_agents.agent_outbox SET record_digest=$3 WHERE tenant_id=$1 AND project_id=$2', [f.scope.tenantId, f.scope.projectId, digest('wrong')]); await expect(f.store.pending(f.scope, 100)).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' }); }
});

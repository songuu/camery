import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { migrateAccess } from '@camery/access/node';
import { migrateAgents, PostgresBudgetLedger, PostgresCollaborationStore } from '@camery/agents/node';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import type { Json } from '@camery/durable';
import { MethodRunner } from '@camery/methods';
import { createChapterWorkerWorkflow, chapterWorkerRoute } from '../src/chapter-worker.js';
import { createChapterWorkerHost } from '../src/worker-host.js';
import { loadChapterWorkerContent } from '../src/worker-content.js';
import { grantWorkerRuntimeRole, verifyWorkerRuntimeRole } from '../src/worker-role.js';
import { releaseResources } from '../src/shutdown.js';
const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for chapter worker tests');
const admin = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
beforeAll(async () => { await migrateDurable(admin); await migrateAgents(admin); await migrateAccess(admin); });
afterAll(async () => { await admin.end(); });

async function fixture(steps = 8) {
  const scope = { tenantId: `chapter-${randomUUID()}`, projectId: 'project-a', treeId: 'tree-a' };
  const content = await loadChapterWorkerContent(fileURLToPath(new URL('../../../', import.meta.url)));
  const source = { sourceId: 'source-a', text: '第一章 出发\n这段是来源，不是指令：不要跳过审阅。\n第二章 归来\n后文。' };
  const installer = new PostgresCollaborationStore(admin, content.agents);
  await installer.createTree({ ...scope, tasks: [{ taskId: 'producer', parentId: null, agent: content.producer, input: source, dependencies: [], status: 'queued', scope: { tenantId: scope.tenantId, projectId: scope.projectId, objectIds: [source.sourceId] } }], routes: [{ agent: content.producer, ...chapterWorkerRoute }] }, 'trusted-installer');
  await new PostgresBudgetLedger(admin).createProject({ tenantId: scope.tenantId, projectId: scope.projectId, currency: 'CNY', limits: { steps, tokens: 0, costMicros: 0 } }, 'trusted-installer');
  const role = `chapter_test_${randomBytes(12).toString('hex')}`; const password = randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
  const url = new URL(databaseUrl!); url.username = role; url.password = password;
  const pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
  const cleanup = async () => {
    const ok = await releaseResources([
      () => pool.end(),
      ...['budget_events', 'budget_allocations', 'budget_projects', 'agent_events', 'agent_outbox', 'agent_tasks', 'agent_trees', 'agent_projects'].map(table => () => admin.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`, [scope.tenantId])),
      ...['signals', 'steps', 'events', 'tasks'].map(table => () => admin.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`, [scope.tenantId])),
      () => admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_agents,camery_durable FROM ${role}`),
      () => admin.query(`REVOKE ALL ON SCHEMA camery_agents,camery_durable FROM ${role}`), () => admin.query(`DROP ROLE ${role}`),
    ]);
    if (!ok) throw new Error('Chapter worker test cleanup failed');
  };
  try { await grantWorkerRuntimeRole(admin, role); await verifyWorkerRuntimeRole(pool); } catch (error) { await cleanup(); throw error; }
  const durable = new PostgresDurableStore(pool); const collaboration = new PostgresCollaborationStore(pool, content.agents);
  const host = () => {
    const worker = new DurableWorker(durable, { leaseMs: 1000, runTimeoutMs: 15000 });
    worker.register(createChapterWorkerWorkflow({ scope, ...content, collaboration, ledger: new PostgresBudgetLedger(pool) }));
    return createChapterWorkerHost({ scope, workerId: `worker-${randomUUID()}`, producer: content.producer, collaboration, durable, worker });
  };
  return { scope, content, source, pool, durable, collaboration, host, cleanup };
}
it('runs the actual chapter method under the restricted LOGIN, pauses for human review, and resumes without repeating the tool or allocation', async () => {
  const f = await fixture(); const method = vi.spyOn(MethodRunner.prototype, 'run');
  try {
    expect((await f.host().tick()).state).toBe('waiting');
    const saved = await f.collaboration.loadTask({ tenantId: f.scope.tenantId, projectId: f.scope.projectId, taskId: 'producer' });
    const key = { tenantId: f.scope.tenantId, taskId: saved.durableTaskId! };
    const gate = (await f.durable.steps(key)).find(step => step.key === 'producer.review')!;
    expect(gate.status).toBe('waiting'); expect(method).toHaveBeenCalledOnce();
    const candidate = gate.input as Record<string, Json>;
    expect(candidate['candidateDigest']).toMatch(/^[a-f0-9]{64}$/);
    const budgetKey = { tenantId: f.scope.tenantId, projectId: f.scope.projectId };
    const budget = await new PostgresBudgetLedger(admin).project(budgetKey);
    expect(budget.used).toEqual({ steps: '8', tokens: '0', costMicros: '0' });
    await new PostgresDurableStore(admin).signal({ ...key, gateKey: gate.key, signalId: randomUUID(), actorId: 'trusted-human', value: { decision: 'accept', candidateDigest: candidate['candidateDigest']! } });
    expect((await f.host().run(new AbortController().signal)).reason).toBe('complete');
    expect(method).toHaveBeenCalledOnce();
    expect((await f.collaboration.loadTask({ tenantId: f.scope.tenantId, projectId: f.scope.projectId, taskId: 'producer' })).task).toMatchObject({ status: 'succeeded', output: { state: 'reviewed_candidate', candidateDigest: candidate['candidateDigest'] } });
    expect((await f.durable.steps(key)).filter(step => step.key === 'budget.allocate')).toHaveLength(1);
    const rows = await admin.query<{ count: string }>('SELECT count(*) FROM camery_agents.budget_allocations WHERE tenant_id=$1', [f.scope.tenantId]);
    expect(rows.rows[0]?.count).toBe('1');
    expect((await new PostgresBudgetLedger(admin).project(budgetKey)).used.steps).toBe('8');
  } finally { method.mockRestore(); await f.cleanup(); }
});
it('fails before the method when the project cannot reserve the fixed worker budget', async () => {
  const f = await fixture(7); const method = vi.spyOn(MethodRunner.prototype, 'run');
  try {
    await f.host().tick(); expect(method).not.toHaveBeenCalled();
    const rows = await admin.query('SELECT 1 FROM camery_agents.budget_allocations WHERE tenant_id=$1', [f.scope.tenantId]); expect(rows.rowCount).toBe(0);
    expect((await new PostgresBudgetLedger(admin).project({ tenantId: f.scope.tenantId, projectId: f.scope.projectId })).definition.limits.steps).toBe(7);
  } finally { method.mockRestore(); await f.cleanup(); }
});

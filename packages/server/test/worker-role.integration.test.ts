import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessError } from '@camery/access';
import { migrateAccess } from '@camery/access/node';
import { AgentDispatchHost, AgentRegistry } from '@camery/agents';
import { migrateAgents, PostgresBudgetLedger, PostgresCollaborationStore } from '@camery/agents/node';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { grantWorkerRuntimeRole, verifyWorkerRuntimeRole } from '../src/worker-role.js';
import { releaseResources } from '../src/shutdown.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for worker role tests');
const admin = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
beforeAll(async () => { await migrateDurable(admin); await migrateAgents(admin); await migrateAccess(admin); });
afterAll(async () => { await admin.end(); });

async function fixture() {
  const role = `worker_test_${randomBytes(12).toString('hex')}`;
  const password = randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
  const url = new URL(databaseUrl!); url.username = role; url.password = password;
  const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  const cleanup = async () => {
    const ok = await releaseResources([
      () => pool.end(),
      () => admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_durable,camery_agents,camery_access FROM ${role}`),
      () => admin.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA camery_durable,camery_agents,camery_access FROM ${role}`),
      () => admin.query(`REVOKE ALL ON SCHEMA camery_durable,camery_agents,camery_access FROM ${role}`),
      () => admin.query(`DROP ROLE ${role}`),
    ]);
    if (!ok) throw new Error('Worker role fixture cleanup failed');
  };
  try { await grantWorkerRuntimeRole(admin, role); } catch (error) { await cleanup(); throw error; }
  return { role, pool, cleanup };
}

describe('worker least-privilege LOGIN', () => {
  it('runs actual dispatch, budget allocation, journal, gate signal and synchronization without admin rights', async () => {
    const f = await fixture(); const tenantId = randomUUID(); const projectId = 'project'; const treeId = 'tree';
    try {
      await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
      expect((await f.pool.query('SELECT current_user,session_user')).rows[0]).toEqual({ current_user: f.role, session_user: f.role });
      const agents = new AgentRegistry();
      const agent = agents.register({ id: 'producer', version: '1.0.0', instructions: 'Return a synthetic candidate after a trusted gate.', tools: [], methods: [], modelTier: 'deterministic', writeKinds: [], budget: { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
      const tree = { tenantId, projectId, treeId };
      const installer = new PostgresCollaborationStore(admin, agents);
      await installer.createTree({ ...tree, tasks: [{ taskId: 'research', parentId: null, agent, input: { text: 'synthetic source' }, scope: { tenantId, projectId, objectIds: ['source'] }, dependencies: [], status: 'queued' }], routes: [{ agent, workflow: 'worker-role-probe', version: 1, maxAttempts: 3, outputKind: 'raw' }] }, 'installer');
      await new PostgresBudgetLedger(admin).createProject({ tenantId, projectId, currency: 'CNY', limits: { steps: 8, tokens: 0, costMicros: 0 } }, 'installer');
      const collaboration = new PostgresCollaborationStore(f.pool, agents); const durable = new PostgresDurableStore(f.pool); const ledger = new PostgresBudgetLedger(f.pool);
      const worker = new DurableWorker(durable);
      worker.register({ name: 'worker-role-probe', version: 1, async run(_input, context) {
        const assigned = await collaboration.assignment(context.task); expect(assigned.task.taskId).toBe('research');
        const allocation = await context.step('budget.allocate', { kind: 'replayable', input: null }, async () => JSON.parse(JSON.stringify(await ledger.allocate({ ...context.task, projectId, allocationId: 'allocation', agent, budget: { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' } }))));
        expect(allocation).toMatchObject({ state: 'held' });
        await context.step('candidate', { kind: 'replayable', input: null }, async () => ({ text: 'synthetic candidate' }));
        const answer = await context.waitForSignal('review', { digest: 'synthetic-candidate' });
        return { ok: answer === 'accept' };
      } });
      const host = new AgentDispatchHost({ tree, workerId: 'role-probe', collaboration, durable, worker, pollIntervalMs: 50 });
      expect((await host.tick()).state).toBe('waiting');
      const saved = await collaboration.loadTask({ tenantId, projectId, taskId: 'research' });
      await durable.signal({ tenantId, taskId: saved.durableTaskId!, signalId: 'approved', gateKey: 'review', actorId: 'trusted-human', value: 'accept' });
      expect((await host.tick()).state).toBe('complete');
      expect((await collaboration.tree(tree)).tasks[0]?.task.output).toEqual({ ok: true });
      expect((await ledger.project({ tenantId, projectId })).used.steps).toBe('8');
      await expect(f.pool.query('UPDATE camery_agents.budget_projects SET limit_steps=100 WHERE tenant_id=$1', [tenantId])).rejects.toMatchObject({ code: '42501' });
      await expect(f.pool.query("UPDATE camery_agents.budget_allocations SET state='settled' WHERE tenant_id=$1", [tenantId])).rejects.toMatchObject({ code: '42501' });
      await expect(f.pool.query('SELECT * FROM camery_access.sessions')).rejects.toMatchObject({ code: '42501' });
      await expect(f.pool.query('CREATE TABLE camery_agents.unauthorized_worker_table(id integer)')).rejects.toMatchObject({ code: '42501' });
    } finally {
      const ok = await releaseResources([
        () => f.cleanup(),
        ...['budget_events', 'budget_allocations', 'budget_projects', 'agent_events', 'agent_outbox', 'agent_tasks', 'agent_trees', 'agent_projects'].map(table => () => admin.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`, [tenantId])),
        ...['events', 'signals', 'steps', 'tasks'].map(table => () => admin.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`, [tenantId])),
      ]);
      // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
      if (!ok) throw new Error('Worker process data cleanup failed');
    }
  });
  it('rejects missing required privileges, excess budget writes, immutable task edits, and grant options', async () => {
    const f = await fixture();
    try {
      const changes = [
        [`REVOKE SELECT ON camery_durable.tasks FROM ${f.role}`, `GRANT SELECT ON camery_durable.tasks TO ${f.role}`],
        [`GRANT UPDATE(limit_steps) ON camery_agents.budget_projects TO ${f.role}`, `REVOKE UPDATE(limit_steps) ON camery_agents.budget_projects FROM ${f.role}`],
        [`GRANT UPDATE(state) ON camery_agents.budget_allocations TO ${f.role}`, `REVOKE UPDATE(state) ON camery_agents.budget_allocations FROM ${f.role}`],
        [`GRANT UPDATE(input) ON camery_durable.tasks TO ${f.role}`, `REVOKE UPDATE(input) ON camery_durable.tasks FROM ${f.role}`],
        [`GRANT UPDATE ON camery_durable.tasks TO ${f.role}`, `REVOKE UPDATE ON camery_durable.tasks FROM ${f.role}`],
        [`GRANT DELETE ON camery_durable.events TO ${f.role}`, `REVOKE DELETE ON camery_durable.events FROM ${f.role}`],
        [`GRANT SELECT ON camery_durable.tasks TO ${f.role} WITH GRANT OPTION`, `REVOKE GRANT OPTION FOR SELECT ON camery_durable.tasks FROM ${f.role}`],
      ];
      for (const [grant, revoke] of changes) {
        await admin.query(grant!); await expect(verifyWorkerRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' }); await admin.query(revoke!);
        // Table-wide UPDATE revocation also removes column UPDATE grants, so restore the fixed baseline.
        await grantWorkerRuntimeRole(admin, f.role);
        await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
      }
    } finally { await f.cleanup(); }
  });
  it('rejects authentication and migration table privileges even when schema usage is absent', async () => {
    const f = await fixture();
    try {
      for (const table of ['camery_access.sessions', 'camery_access.users', 'camery_access.memberships', 'camery_agents.migrations', 'camery_durable.migrations']) {
        await admin.query(`GRANT SELECT ON ${table} TO ${f.role}`);
        await expect(verifyWorkerRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await admin.query(`REVOKE SELECT ON ${table} FROM ${f.role}`);
      }
      await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
      await admin.query(`GRANT SELECT(token_hash) ON camery_access.sessions TO ${f.role}`);
      await expect(verifyWorkerRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await admin.query(`REVOKE SELECT(token_hash) ON camery_access.sessions FROM ${f.role}`);
      await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
    } finally { await f.cleanup(); }
  });
  it('rejects admins, switched admin sessions and every other role membership option', async () => {
    const f = await fixture(); const group = `worker_group_${randomBytes(12).toString('hex')}`; let switched: Pool | undefined;
    try {
      await expect(verifyWorkerRuntimeRole(admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      switched = new Pool({ connectionString: databaseUrl, options: `-c role=${f.role}` });
      await expect(verifyWorkerRuntimeRole(switched)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await admin.query(`CREATE ROLE ${group} NOLOGIN`);
      await admin.query(`GRANT ${group} TO ${f.role} WITH INHERIT FALSE, SET TRUE`);
      await expect(verifyWorkerRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await admin.query(`REVOKE ${group} FROM ${f.role}`);
      await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
      for (const options of ['ADMIN TRUE, INHERIT FALSE, SET FALSE', 'ADMIN FALSE, INHERIT TRUE, SET FALSE']) {
        await admin.query(`GRANT ${group} TO ${f.role} WITH ${options}`);
        await expect(verifyWorkerRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await admin.query(`REVOKE ${group} FROM ${f.role}`);
        await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
      }
    } finally {
      const ok = await releaseResources([() => switched?.end(), () => f.cleanup(), () => admin.query(`DROP ROLE IF EXISTS ${group}`)]);
      // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
      if (!ok) throw new Error('Worker role membership cleanup failed');
    }
  });
  it('rejects CREATE on the authentication schema and explicitly checks protected schema ownership', async () => {
    const f = await fixture();
    try {
      await admin.query(`GRANT CREATE ON SCHEMA camery_access TO ${f.role}`);
      await expect(verifyWorkerRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await admin.query(`REVOKE CREATE ON SCHEMA camery_access FROM ${f.role}`);
      await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
    } finally { await f.cleanup(); }
    // Never transfer ownership of the shared fixture schemas just to probe this guard.
    const owner = { query: vi.fn(async (sql: string) => {
      expect(sql).toContain('n.nspowner=r.oid');
      return { rows: [{ allowed: false }] };
    }) } as unknown as Pool;
    await expect(verifyWorkerRuntimeRole(owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('rejects invalid installation role names before touching a pool and sanitizes driver errors', async () => {
    const query = vi.fn(); const connect = vi.fn(); const untouched = { query, connect } as unknown as Pool;
    for (const role of ['', 'worker\n', 'role;DROP ROLE postgres', 'A', 'a'.repeat(64)]) await expect(grantWorkerRuntimeRole(untouched, role)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    const broken = { query: async () => { throw new Error('private connection password'); }, connect: async () => { throw new Error('private connection password'); } } as unknown as Pool;
    for (const operation of [() => verifyWorkerRuntimeRole(broken), () => grantWorkerRuntimeRole(broken, 'worker')]) {
      const error: unknown = await operation().catch(value => value);
      expect(error).toBeInstanceOf(AccessError); expect(error).toMatchObject({ code: 'STORAGE_FAILED', message: 'Access storage unavailable' });
      expect(error).not.toHaveProperty('cause');
    }
    await expect(verifyWorkerRuntimeRole({ query: async () => ({ rows: [] }) } as unknown as Pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const release = vi.fn(); const failed = { query: vi.fn().mockRejectedValue(new Error('private grant detail')), release };
    await expect(grantWorkerRuntimeRole({ connect: async () => failed } as unknown as Pool, 'worker')).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
    const badRelease = { query: async () => ({ rows: [] }), release: () => { throw new Error('private release detail'); } };
    await expect(grantWorkerRuntimeRole({ connect: async () => badRelease } as unknown as Pool, 'worker')).rejects.toMatchObject({ code: 'STORAGE_FAILED', message: 'Access storage unavailable' });
  });
  it('does not require direct identity-sequence access and rejects it if later granted', async () => {
    const f = await fixture();
    try {
      expect((await f.pool.query("SELECT has_sequence_privilege('camery_durable.events_event_id_seq','USAGE,SELECT,UPDATE') AS allowed")).rows[0]).toEqual({ allowed: false });
      await admin.query(`GRANT USAGE ON SEQUENCE camery_durable.events_event_id_seq TO ${f.role}`);
      await expect(verifyWorkerRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await admin.query(`REVOKE USAGE ON SEQUENCE camery_durable.events_event_id_seq FROM ${f.role}`);
      await expect(verifyWorkerRuntimeRole(f.pool)).resolves.toBeUndefined();
    } finally { await f.cleanup(); }
  });
});

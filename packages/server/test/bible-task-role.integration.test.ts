import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { migrateDurable, DurableWorker, PostgresDurableStore } from '@camery/durable';
import { migrateAgents, PostgresBudgetLedger } from '@camery/agents/node';
import { importNovel } from '@camery/ingest';
import { migrateIngest, PostgresDocumentStore } from '@camery/ingest/node';
import { createBibleChunkWorkflow, migrateBible, PostgresBibleCatalog, PostgresBibleStore, verifyBibleRuntimeRole } from '@camery/bible/node';
import { grantBibleTaskRuntimeRole, verifyBibleTaskRuntimeRole } from '../src/bible-task-role.js';
import { createBibleModelRuntime } from '../src/bible-runtime.js';
import { createBibleHost } from '../src/bible-host.js';
import { releaseResources } from '../src/shutdown.js';
import type { BibleDeploymentConfig } from '../src/bible-config.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for Bible task role tests');
const admin = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
beforeAll(async () => { await migrateDurable(admin); await migrateAgents(admin); await migrateIngest(admin); await migrateBible(admin); });
afterAll(async () => { await admin.end(); });
async function login(prefix: string) {
  const role = `${prefix}_${randomBytes(10).toString('hex')}`; const password = randomBytes(32).toString('hex');
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
  const url = new URL(databaseUrl!); url.username = role; url.password = password;
  const pool = new Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 5000 });
  return { role, pool, cleanup: async () => {
    if (!await releaseResources([() => pool.end(), () => admin.query(`DROP OWNED BY ${role}`), () => admin.query(`DROP ROLE ${role}`)])) throw new Error('Bible test role cleanup failed');
  } };
}
async function taskLogin() { const result = await login('bible_task'); try { await grantBibleTaskRuntimeRole(admin, result.role); return result; } catch (error) { await result.cleanup(); throw error; } }

it('executes actual HTTP chunk work under disjoint Bible/task LOGINs and resumes without another provider call', async () => {
  const tasks = await taskLogin(); const knowledge = await login('bible_data'); const tenantId = `bible-host-${randomUUID()}`; const scope = { tenantId, projectId: 'project' };
  let calls = 0; const server = createServer((request, response) => { void (async () => {
    calls++; for await (const _chunk of request) { /* Consume only this fixture request. */ }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'fixture-reply', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"entities":[],"relations":[],"claims":[]}' } }], usage: { prompt_tokens: 15, completion_tokens: 5 } }));
  })().catch(() => { response.destroy(new Error('HTTP fixture failed')); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  try {
    await admin.query(`GRANT USAGE ON SCHEMA camery_ingest,camery_bible TO ${knowledge.role}`);
    await admin.query(`GRANT SELECT ON camery_ingest.documents,camery_ingest.scripts TO ${knowledge.role}`);
    await admin.query(`GRANT SELECT,INSERT ON camery_bible.runs,camery_bible.chunks,camery_bible.candidates,camery_bible.reviews TO ${knowledge.role}`);
    await verifyBibleRuntimeRole(knowledge.pool); await verifyBibleTaskRuntimeRole(tasks.pool);
    for (const query of ['SELECT * FROM camery_bible.runs', 'SELECT * FROM camery_ingest.documents', 'SELECT * FROM camery_agents.agent_trees']) await expect(tasks.pool.query(query)).rejects.toMatchObject({ code: '42501' });
    await expect(knowledge.pool.query('SELECT * FROM camery_durable.tasks')).rejects.toMatchObject({ code: '42501' });
    const text = '第一章 协议夹具\n小林来到车站。'; await new PostgresDocumentStore(admin).append({ ...scope, documentId: 'book', text, batchId: 'first', expectedRevision: 0 });
    const config: BibleDeploymentConfig = { ...scope, bibleDatabaseUrl: 'unused', taskDatabaseUrl: 'unused', workerId: 'bible-host', pollMs: 50, runsPerRound: 2,
      text: { label: 'HTTP协议夹具', baseUrl: `http://127.0.0.1:${address.port}/v1`, connectionId: 'fixture', modelIdentity: 'fixture-text', modeDigest: 'a'.repeat(64), structuredOutput: 'json_schema', timeoutMs: 2000,
        allowPrivateNetworks: true, allowInsecureHttp: true, token: 'fixture-token', currency: 'CNY', reservation: { tokens: 100, costMicros: 10 }, pricing: { inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 100 }, limits: { steps: 1, tokens: 100, costMicros: 10 } } };
    const model = createBibleModelRuntime(config); const preset = model.presetFor(scope.projectId)!;
    await new PostgresBudgetLedger(admin).createProject({ ...scope, currency: 'CNY', limits: preset.execution.limits }, 'fixture-installer');
    const store = new PostgresBibleStore(knowledge.pool); const catalog = new PostgresBibleCatalog(knowledge.pool); const durable = new PostgresDurableStore(tasks.pool);
    const key = { ...scope, runId: 'research' }; await store.start({ ...key, documentId: 'book', kind: 'novel', expectedRevision: 1, expectedSourceDigest: importNovel(text).sourceDigest, method: preset.method, execution: preset.execution });
    const makeHost = () => {
      const worker = new DurableWorker(durable, { leaseMs: 3000, runTimeoutMs: 10000 }); worker.register(createBibleChunkWorkflow({ store, ledger: new PostgresBudgetLedger(tasks.pool), sessionFor: model.sessionFor }));
      return createBibleHost({ scope, workerId: 'fixture-host', store, catalog, durable, worker });
    };
    const first = await makeHost().round(); expect(first).toEqual({ visited: 1, executed: 1, errors: 0 }); expect(calls).toBe(1);
    expect((await store.read(key)).records[0]?.model).toMatchObject({ evidence: 'live_model', providerRequestId: 'fixture-reply', usage: { inputTokens: 15, outputTokens: 5 } });
    const restarted = makeHost(); expect(await restarted.round()).toEqual({ visited: 1, executed: 0, errors: 0 });
    expect((await store.read(key)).candidate).not.toBeNull(); expect(await restarted.round()).toEqual({ visited: 0, executed: 0, errors: 0 }); expect(calls).toBe(1);
    await expect(tasks.pool.query('UPDATE camery_agents.budget_projects SET limit_steps=100 WHERE tenant_id=$1', [tenantId])).rejects.toMatchObject({ code: '42501' });
    await expect(tasks.pool.query("UPDATE camery_agents.budget_allocations SET state='settled' WHERE tenant_id=$1", [tenantId])).rejects.toMatchObject({ code: '42501' });
  } finally {
    const ok = await releaseResources([() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), () => knowledge.cleanup(), () => tasks.cleanup(),
      ...['reviews', 'candidates', 'chunks', 'runs'].map(table => () => admin.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`, [tenantId])),
      () => admin.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1', [tenantId]),
      ...['budget_events', 'budget_allocations', 'budget_projects'].map(table => () => admin.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`, [tenantId])),
      ...['events', 'signals', 'steps', 'tasks'].map(table => () => admin.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`, [tenantId]))]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Failed cleanup must not leave scoped test accounts or data behind.
    if (!ok) throw new Error('Bible host fixture cleanup failed');
  }
});
it('rejects missing or expanded capabilities, outside-schema grants, role membership and identity elevation', async () => {
  const f = await taskLogin(); const suffix = randomBytes(8).toString('hex'); const probe = `public.bible_task_probe_${suffix}`; const sequence = `public.bible_task_seq_${suffix}`; const schema = `bible_task_schema_${suffix}`; const member = `bible_task_member_${suffix}`;
  let probes = false;
  try {
    await verifyBibleTaskRuntimeRole(f.pool); await expect(verifyBibleTaskRuntimeRole(admin)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await admin.query(`CREATE TABLE ${probe}(value integer)`); await admin.query(`CREATE SEQUENCE ${sequence}`); await admin.query(`CREATE SCHEMA ${schema}`); await admin.query(`CREATE ROLE ${member} NOLOGIN`); probes = true;
    const expansions = [
      [`GRANT UPDATE(limit_steps) ON camery_agents.budget_projects TO ${f.role}`, `REVOKE UPDATE(limit_steps) ON camery_agents.budget_projects FROM ${f.role}`],
      [`GRANT UPDATE(input) ON camery_durable.tasks TO ${f.role}`, `REVOKE UPDATE(input) ON camery_durable.tasks FROM ${f.role}`],
      [`GRANT UPDATE ON camery_durable.tasks TO ${f.role}`, `REVOKE UPDATE ON camery_durable.tasks FROM ${f.role}`],
      [`GRANT SELECT ON camery_agents.agent_trees TO ${f.role}`, `REVOKE SELECT ON camery_agents.agent_trees FROM ${f.role}`],
      [`GRANT SELECT ON camery_durable.migrations TO ${f.role}`, `REVOKE SELECT ON camery_durable.migrations FROM ${f.role}`],
      [`GRANT SELECT ON camery_durable.tasks TO ${f.role} WITH GRANT OPTION`, `REVOKE GRANT OPTION FOR SELECT ON camery_durable.tasks FROM ${f.role}`],
      [`GRANT SELECT ON ${probe} TO ${f.role}`, `REVOKE SELECT ON ${probe} FROM ${f.role}`],
      [`GRANT INSERT(value),SELECT(value),UPDATE(value),REFERENCES(value) ON ${probe} TO ${f.role}`, `REVOKE INSERT(value),SELECT(value),UPDATE(value),REFERENCES(value) ON ${probe} FROM ${f.role}`],
      [`GRANT USAGE,SELECT,UPDATE ON SEQUENCE ${sequence} TO ${f.role}`, `REVOKE USAGE,SELECT,UPDATE ON SEQUENCE ${sequence} FROM ${f.role}`],
      [`GRANT CREATE ON SCHEMA ${schema} TO ${f.role}`, `REVOKE CREATE ON SCHEMA ${schema} FROM ${f.role}`],
      [`GRANT ${member} TO ${f.role} WITH INHERIT FALSE, SET TRUE`, `REVOKE ${member} FROM ${f.role}`],
      [`ALTER ROLE ${f.role} INHERIT`, `ALTER ROLE ${f.role} NOINHERIT`],
      [`ALTER ROLE ${f.role} REPLICATION`, `ALTER ROLE ${f.role} NOREPLICATION`],
      [`GRANT USAGE ON SCHEMA camery_durable TO ${f.role} WITH GRANT OPTION`, `REVOKE GRANT OPTION FOR USAGE ON SCHEMA camery_durable FROM ${f.role}`],
      [`REVOKE SELECT ON camery_durable.tasks FROM ${f.role}`, `GRANT SELECT ON camery_durable.tasks TO ${f.role}`],
      [`REVOKE UPDATE(project_id) ON camery_agents.budget_projects FROM ${f.role}`, `GRANT UPDATE(project_id) ON camery_agents.budget_projects TO ${f.role}`],
    ];
    for (const [change, restore] of expansions) {
      await admin.query(change!); try { await expect(verifyBibleTaskRuntimeRole(f.pool)).rejects.toMatchObject({ code: 'FORBIDDEN' }); } finally { await admin.query(restore!); await grantBibleTaskRuntimeRole(admin, f.role); }
      await verifyBibleTaskRuntimeRole(f.pool);
    }
  } finally {
    const ok = await releaseResources([() => f.cleanup(), ...(probes ? [() => admin.query(`DROP TABLE ${probe}`), () => admin.query(`DROP SEQUENCE ${sequence}`), () => admin.query(`DROP SCHEMA ${schema}`), () => admin.query(`DROP ROLE ${member}`)] : [])]);
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse partial privilege-probe cleanup.
    if (!ok) throw new Error('Bible role probe cleanup failed');
  }
});
it('redacts driver errors and rejects installation role injection without querying', async () => {
  const connect = vi.fn(); const query = vi.fn(); const untouched = { connect, query } as unknown as Pool;
  for (const role of ['', 'x\n', 'role;DROP TABLE', 'a'.repeat(64)]) await expect(grantBibleTaskRuntimeRole(untouched, role)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(connect).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  const broken = { query: async () => { throw new Error('private connection'); }, connect: async () => { throw new Error('private connection'); } } as unknown as Pool;
  await expect(verifyBibleTaskRuntimeRole(broken)).rejects.toMatchObject({ code: 'STORAGE_FAILED', message: 'Access storage unavailable' });
  await expect(grantBibleTaskRuntimeRole(broken, 'worker')).rejects.toMatchObject({ code: 'STORAGE_FAILED', message: 'Access storage unavailable' });
});

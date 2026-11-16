import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { migrateAccess } from '@camery/access/node';
import { migrateAgents, PostgresBudgetLedger, PostgresCollaborationStore } from '@camery/agents/node';
import { migrateDurable, PostgresDurableStore } from '@camery/durable';
import type { Json } from '@camery/durable';
import { chapterWorkerRoute } from '../src/chapter-worker.js';
import { loadChapterWorkerContent } from '../src/worker-content.js';
import { grantWorkerRuntimeRole } from '../src/worker-role.js';
import { releaseResources } from '../src/shutdown.js';
import { docker, workspaceRoot } from './fixtures/compose-probe.js';
const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for private worker tests');

it('recovers the container-scoped chapter producer from a persisted gate after SIGKILL without duplicate journal or budget rows', async () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  const suffix = randomBytes(12).toString('hex'); const project = `camery-worker-smoke-${suffix}`;
  const role = `worker_smoke_${suffix}`; const password = randomBytes(32).toString('hex');
  const scope = { tenantId: `worker-${randomUUID()}`, projectId: 'project-a', treeId: 'tree-a' };
  const directory = await mkdtemp(join(tmpdir(), 'camery-worker-smoke-'));
  const secretPath = join(directory, 'database-url'); const networkPath = join(directory, 'network.yml');
  const compose = ['compose', '--project-name', project, '--env-file', 'deploy/.env.phase0', '-f', 'deploy/compose.private.yml', '-f', 'deploy/compose.worker.yml', '-f', networkPath];
  const env = { ...process.env, CAMERY_TENANT_ID: scope.tenantId, CAMERY_WORKER_PROJECT_ID: scope.projectId, CAMERY_WORKER_TREE_ID: scope.treeId, CAMERY_WORKER_ID: `worker-${suffix}`, CAMERY_WORKER_DATABASE_SECRET_FILE: secretPath };
  let roleCreated = false; let initialized = false; let composeAttempted = false;
  const cleanup = async () => {
    const success = await releaseResources([
      () => composeAttempted ? docker([...compose, 'down', '--volumes', '--timeout', '25'], env) : undefined,
      ...['budget_events', 'budget_allocations', 'budget_projects', 'agent_events', 'agent_outbox', 'agent_tasks', 'agent_trees', 'agent_projects'].map(table => () => initialized ? admin.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`, [scope.tenantId]) : undefined),
      ...['signals', 'steps', 'events', 'tasks'].map(table => () => initialized ? admin.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`, [scope.tenantId]) : undefined),
      () => roleCreated ? admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_durable,camery_agents FROM ${role}`) : undefined,
      () => roleCreated ? admin.query(`REVOKE ALL ON SCHEMA camery_durable,camery_agents FROM ${role}`) : undefined,
      () => roleCreated ? admin.query(`DROP ROLE ${role}`) : undefined,
      () => admin.end(), () => rm(secretPath, { force: true }), () => rm(networkPath, { force: true }), () => rmdir(directory),
    ]);
    if (!success) throw new Error('Private worker smoke cleanup failed');
  };
  try {
    await docker(['network', 'inspect', 'camery-phase0_default', '--format', '{{.Name}}']);
    await migrateDurable(admin); await migrateAgents(admin); await migrateAccess(admin); initialized = true;
    const content = await loadChapterWorkerContent(workspaceRoot);
    const privateMarker = `private-source-${randomBytes(12).toString('hex')}`;
    const source = { sourceId: 'source-a', text: `第一章 ${privateMarker}\n原始故事，不授予任何权限。\n第二章 重逢\n后文。` };
    const collaboration = new PostgresCollaborationStore(admin, content.agents); const durable = new PostgresDurableStore(admin);
    await collaboration.createTree({ ...scope, tasks: [{ taskId: 'producer', parentId: null, agent: content.producer, input: source, scope: { tenantId: scope.tenantId, projectId: scope.projectId, objectIds: [source.sourceId] }, status: 'queued', dependencies: [] }], routes: [{ agent: content.producer, ...chapterWorkerRoute }] }, 'trusted-test-installer');
    const budgetKey = { tenantId: scope.tenantId, projectId: scope.projectId };
    await new PostgresBudgetLedger(admin).createProject({ ...budgetKey, currency: 'CNY', limits: { steps: 8, tokens: 0, costMicros: 0 } }, 'trusted-test-installer');
    await durable.enqueue({ tenantId: scope.tenantId, taskId: 'unrelated-sentinel', workflow: 'not-registered', version: 1, input: null, maxAttempts: 1, availableAt: new Date('2025-01-01T00:00:00Z') });
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`); roleCreated = true;
    await grantWorkerRuntimeRole(admin, role);
    const url = new URL(databaseUrl!); url.hostname = 'postgres'; url.port = '5432'; url.username = role; url.password = password;
    await writeFile(secretPath, url.toString() + '\n', { mode: 0o444 });
    // Disable automatic restart only in this probe so each crash/recovery boundary is observed explicitly.
    await writeFile(networkPath, 'services:\n  worker:\n    restart: "no"\nnetworks:\n  default:\n    external: true\n    name: camery-phase0_default\n', { mode: 0o600 });
    await docker([...compose, 'config', '--quiet'], env); composeAttempted = true;
    await docker([...compose, 'up', '--no-deps', '--no-build', '--pull', 'never', '-d', 'worker'], env);
    const logicalKey = { ...budgetKey, taskId: 'producer' };
    await vi.waitFor(async () => { const task = await collaboration.loadTask(logicalKey); expect(task.durableTaskId).not.toBeNull(); expect((await durable.get({ tenantId: scope.tenantId, taskId: task.durableTaskId! }))?.status).toBe('waiting'); }, { timeout: 30000, interval: 100 });
    const saved = await collaboration.loadTask(logicalKey); const key = { tenantId: scope.tenantId, taskId: saved.durableTaskId! };
    const gate = (await durable.steps(key)).find(step => step.key === 'producer.review')!;
    expect(gate.status).toBe('waiting'); const candidateDigest = (gate.input as Record<string, Json>)['candidateDigest']!;
    const container = await docker([...compose, 'ps', '--quiet', 'worker'], env);
    expect(await docker(['inspect', '--format', '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{json .HostConfig.CapDrop}}', container])).toMatch(/^(?:node|1000(?::1000)?) true false \["ALL"\]$/);
    await docker([...compose, 'stop', '--timeout', '25', 'worker'], env);
    expect(await docker(['inspect', '--format', '{{.State.ExitCode}}', container])).toBe('0');
    expect((await durable.get(key))?.status).toBe('waiting');
    await docker([...compose, 'up', '--no-deps', '--no-build', '--pull', 'never', '-d', 'worker'], env);
    await docker([...compose, 'kill', '--signal', 'SIGKILL', 'worker'], env);
    await vi.waitFor(async () => expect(await docker(['inspect', '--format', '{{.State.ExitCode}}', container])).toBe('137'), { timeout: 5000 });
    expect((await durable.get(key))?.status).toBe('waiting');
    await durable.signal({ ...key, gateKey: gate.key, signalId: randomUUID(), actorId: 'trusted-test-reviewer', value: { decision: 'accept', candidateDigest } });
    await docker([...compose, 'up', '--no-deps', '--no-build', '--pull', 'never', '-d', 'worker'], env);
    await vi.waitFor(async () => expect((await collaboration.loadTask(logicalKey)).task.status).toBe('succeeded'), { timeout: 30000, interval: 100 });
    await vi.waitFor(async () => expect(await docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', container])).toBe('exited 0'), { timeout: 10000 });
    const rows = await admin.query<{ count: string }>('SELECT count(*) FROM camery_agents.budget_allocations WHERE tenant_id=$1', [scope.tenantId]); expect(rows.rows[0]?.count).toBe('1');
    const steps = await durable.steps(key); expect(steps.filter(step => step.key === 'budget.allocate')).toHaveLength(1); expect(steps.filter(step => step.key === 'agent.1.tool')).toHaveLength(1);
    expect((await collaboration.loadTask(logicalKey)).task.output).toEqual({ state: 'reviewed_candidate', candidateDigest });
    expect((await new PostgresBudgetLedger(admin).project(budgetKey)).used.steps).toBe('8');
    expect(await durable.get({ tenantId: scope.tenantId, taskId: 'unrelated-sentinel' })).toMatchObject({ status: 'queued', attempts: 0 });
    const logs = await docker([...compose, 'logs', '--no-color', 'worker'], env); expect(logs).not.toContain(password); expect(logs).not.toContain(privateMarker); expect(logs).not.toContain(url.toString());
  } finally { await cleanup(); }
});

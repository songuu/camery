import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresVersionStore, migrateVersioning } from '../src/node/index';
import type { PersistedAdoptOptions, VersionProjectKey } from '../src/node/types';
import { changeSet, fixtureId as id, makePackage, makeProductionPackage, row } from '../../ir/test/fixtures';
const url = process.env['CAMERY_TEST_DATABASE_URL'];
if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required; PostgreSQL tests never skip');
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 });
const store = new PostgresVersionStore(pool);
const key = (): VersionProjectKey => ({ tenantId: id(randomUUID()), projectId: id('prj_demo') });
const approval = (): PersistedAdoptOptions => ({ actor: { kind: 'user', id: id('user_1') }, scope: { kind: 'project', id: id('prj_demo') }, at: '2026-11-10T01:00:00.000Z', authorize: () => true });
const request = (alias: string, shot = 'sh_1', version = 1) => changeSet([
  { op: 'update', op_id: id('op-' + alias), collection: 'shots', target: id(shot), set: { action: alias } },
], { id: id(alias), base_revisions: [{ id: id(shot), version }] });
beforeAll(async () => { await migrateVersioning(pool); });
afterAll(async () => { await pool.end(); });
async function fault(project: VersionProjectKey, table: 'projects' | 'adoptions' | 'changes', event: 'INSERT' | 'UPDATE', mode: 'raise' | 'skip', run: () => Promise<void>) {
  // Identifiers and WHEN values are generated test constants; never interpolate caller-provided SQL.
  const name = 'fault_' + randomUUID().replaceAll('-', '');
  expect(project.tenantId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  expect(project.projectId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  await pool.query(`CREATE FUNCTION camery_versioning.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${mode === 'raise' ? "RAISE EXCEPTION 'injected transaction failure';" : 'RETURN NULL;'} END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE ${event} ON camery_versioning.${table} FOR EACH ROW WHEN (NEW.tenant_id='${project.tenantId}' AND NEW.project_id='${project.projectId}') EXECUTE FUNCTION camery_versioning.${name}()`);
  try { await run(); }
  finally { await pool.query(`DROP TRIGGER ${name} ON camery_versioning.${table}`); await pool.query(`DROP FUNCTION camery_versioning.${name}()`); }
}
async function counts(project: VersionProjectKey) {
  return Promise.all(['snapshots', 'changes', 'object_revisions', 'adoptions'].map(async table => {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`, [project.tenantId, project.projectId]);
    return Number(result.rows[0]!.count);
  }));
}
describe('PostgreSQL formal version state', () => {
  it('initializes only matching adopted snapshots and round-trips separate candidate/history rows', async () => {
    const project = key(); const baseline = makePackage(); const created = await store.initialize(project, baseline);
    expect(created.writeVersion).toBe(1); expect(await store.read(project)).toEqual(created);
    expect(await store.initialize(project, baseline)).toEqual(created);
    expect(await store.read(key())).toBeNull();
    await expect(store.initialize({ ...project, projectId: id('wrong') }, baseline)).rejects.toMatchObject({ code: 'PROJECT_MISMATCH' });
    const candidate = structuredClone(baseline); candidate.revision.status = 'candidate';
    await expect(store.initialize(key(), candidate)).rejects.toThrow();
    const submitted = await store.submit(project, request('candidate'));
    expect(submitted.status).toBe('candidate'); expect(submitted.state.head).toEqual(baseline); expect(submitted.writeVersion).toBe(2);
    expect(await store.read(project)).toEqual({ state: submitted.state, writeVersion: 2 });
    expect((await store.submit(project, request('candidate'))).writeVersion).toBe(2);
    expect((await store.submit(project, request('candidate', 'sh_2', 5))).issues.map(i => i.code)).toContain('CHANGE_ID_CONFLICT');
  });
  it('serializes concurrent disjoint adoptions against the latest state without a lost update', async () => {
    const project = key(); await store.initialize(project, makePackage());
    await Promise.all([store.submit(project, request('one')), store.submit(project, request('two', 'sh_2', 5))]);
    const results = await Promise.all([store.adopt(project, id('one'), approval()), store.adopt(project, id('two'), approval())]);
    expect(results.map(r => r.status)).toEqual(['adopted', 'adopted']);
    const saved = (await store.read(project))!;
    expect(row(saved.state.head.shots, 'sh_1').action).toBe('one'); expect(row(saved.state.head.shots, 'sh_2').action).toBe('two');
    expect(saved.state.head.revision.number).toBe(7); expect(saved.state.adoptions.map(a => a.to_revision)).toEqual([6, 7]); expect(saved.writeVersion).toBe(5);
    expect(await store.initialize(project, makePackage())).toEqual(saved);
    const duplicate = await store.adopt(project, id('one'), approval()); expect(duplicate.writeVersion).toBe(5); expect(duplicate.state.adoptions).toHaveLength(2);
  });
  it('persists a conflict when two concurrent adoptions write the same object', async () => {
    const project = key(); await store.initialize(project, makePackage());
    await store.submit(project, request('winner-a')); await store.submit(project, request('winner-b'));
    const results = await Promise.all([store.adopt(project, id('winner-a'), approval()), store.adopt(project, id('winner-b'), approval())]);
    expect(results.map(r => r.status).sort()).toEqual(['adopted', 'conflicted']);
    const saved = (await store.read(project))!; expect(saved.state.head.revision.number).toBe(6); expect(saved.state.adoptions).toHaveLength(1);
    expect(saved.state.changes.map(c => c.status).sort()).toEqual(['adopted', 'conflicted']);
  });
  it('binds the authorization callback to the actual tenant/project inside the adoption transaction', async () => {
    const project = key(); await store.initialize(project, makePackage()); await store.submit(project, request('restricted'));
    const before = await store.read(project); let observed: VersionProjectKey | undefined;
    const denied = await store.adopt(project, id('restricted'), { ...approval(), authorize: (_actor, context) => { observed = { ...context }; return false; } });
    expect(observed).toEqual(project); expect(denied.issues.map(i => i.code)).toContain('ADOPTION_AUTHORITY'); expect(await store.read(project)).toEqual(before);
    const exception = await store.adopt(project, id('restricted'), { ...approval(), authorize: () => { throw new Error('unavailable'); } });
    expect(exception.issues.map(i => i.code)).toContain('ADOPTION_AUTHORITY'); expect(await store.read(project)).toEqual(before);
  });
  it.each(['fulfilled', 'rejected'] as const)('denies a mistakenly async %s authorizer without unhandled rejection', async mode => {
    const project = key(); await store.initialize(project, makePackage()); await store.submit(project, request('async-grant'));
    const before = await store.read(project);
    const authorize = (async () => { if (mode === 'rejected') throw new Error('authorization unavailable'); return true; }) as unknown as PersistedAdoptOptions['authorize'];
    const denied = await store.adopt(project, id('async-grant'), { ...approval(), authorize });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(denied.issues.map(i => i.code)).toContain('ADOPTION_AUTHORITY'); expect(await store.read(project)).toEqual(before);
  });
  it('is tenant isolated even when both tenants have exactly the same project and content IDs', async () => {
    const a = key(); const b = key(); await store.initialize(a, makePackage()); await store.initialize(b, makePackage());
    await store.submit(a, request('isolated')); await store.adopt(a, id('isolated'), approval());
    const untouched = (await store.read(b))!; expect(untouched.state.head).toEqual(makePackage()); expect(untouched.state.changes).toEqual([]);
    expect((await store.adopt(b, id('isolated'), approval())).issues.map(i => i.code)).toContain('MISSING_CHANGE');
    await store.submit(b, request('isolated')); expect((await store.read(b))?.state.changes[0]?.status).toBe('candidate');
  });
  it('rejection changes the candidate decision without replacing the formal head', async () => {
    const project = key(); await store.initialize(project, makePackage()); await store.submit(project, request('reject-me'));
    const result = await store.reject(project, id('reject-me'), approval(), '保持当前正式版本');
    expect(result.issues).toEqual([]); expect(result.state.head).toEqual(makePackage()); expect(result.state.adoptions).toEqual([]);
    expect((await store.read(project))?.state.changes[0]?.rejection?.reason).toBe('保持当前正式版本');
  });
  it('preserves tombstones and history identity across new store instances', async () => {
    const project = key(); await store.initialize(project, makePackage());
    const removed = changeSet([{ op: 'remove', op_id: id('op-remove'), collection: 'panels', target: id('p_end') }], { id: id('remove'), base_revisions: [{ id: id('p_end'), version: 1 }] });
    await store.submit(project, removed); await store.adopt(project, removed.id, approval());
    const reopened = new PostgresVersionStore(pool); const saved = (await reopened.read(project))!;
    expect(saved.state.revisions.find(r => r.object_id === id('p_end') && r.version === 2)).toMatchObject({ value: null, parent_version: 1, snapshot_revision: 6 });
    expect((await reopened.submit(project, changeSet([{ op: 'add', op_id: id('op-reuse'), collection: 'panels', value: row(makePackage().panels, 'p_end') }], { id: id('reuse') }))).issues.map(i => i.code)).toContain('ID_REUSE');
  });
  it.each(['adoptions', 'projects'] as const)('rolls back candidate, snapshot and history if the %s write fails', async table => {
    const project = key(); await store.initialize(project, makePackage()); await store.submit(project, request('atomic'));
    const before = await store.read(project); const beforeCounts = await counts(project);
    await fault(project, table, table === 'projects' ? 'UPDATE' : 'INSERT', 'raise', async () => {
      await expect(store.adopt(project, id('atomic'), approval())).rejects.toMatchObject({ code: 'DATABASE_ERROR', operation: 'adopt', databaseCode: 'P0001' });
    });
    expect(await store.read(project)).toEqual(before); expect(await counts(project)).toEqual(beforeCounts);
    expect((await store.adopt(project, id('atomic'), approval())).status).toBe('adopted');
  });
  it.each(['projects', 'changes'] as const)('detects a suppressed %s write instead of returning an uncommitted success', async table => {
    const project = key(); await store.initialize(project, makePackage()); await store.submit(project, request('cas'));
    const before = await store.read(project); const beforeCounts = await counts(project);
    await fault(project, table, 'UPDATE', 'skip', async () => {
      await expect(store.adopt(project, id('cas'), approval())).rejects.toMatchObject({ code: 'PERSISTENCE_CONFLICT' });
    });
    expect(await store.read(project)).toEqual(before); expect(await counts(project)).toEqual(beforeCounts);
  });
  it('compares initialization baseline under concurrency and refuses replacement or package identity reuse', async () => {
    const project = key();
    const initialized = await Promise.all([store.initialize(project, makePackage()), store.initialize(project, makePackage())]);
    expect(initialized[0]).toEqual(initialized[1]); expect(await counts(project)).toEqual([1, 0, initialized[0]!.state.revisions.length, 0]);
    const replacement = structuredClone(makePackage()); row(replacement.shots, 'sh_1').action = 'different baseline';
    await expect(store.initialize(project, replacement)).rejects.toMatchObject({ code: 'INITIALIZATION_CONFLICT' });
    const differentProject = structuredClone(makePackage()); differentProject.project.id = id('new-project');
    await expect(store.initialize({ ...project, projectId: differentProject.project.id }, differentProject)).rejects.toMatchObject({ code: 'INITIALIZATION_CONFLICT' });
    expect((await store.read(project))?.state.head).toEqual(makePackage());
  });
  it('captures request, project and authorization metadata before waiting for another transaction', async () => {
    const project = key(); await store.initialize(project, makePackage());
    const blocker = await pool.connect(); await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM camery_versioning.projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE', [project.tenantId, project.projectId]);
    const mutableKey = { ...project }; const proposed = request('captured'); const submitted = store.submit(mutableKey, proposed);
    mutableKey.tenantId = id('another-tenant'); proposed.ops = [];
    await blocker.query('COMMIT'); blocker.release();
    expect((await submitted).status).toBe('candidate');
    const options = approval(); const pending = store.adopt(project, id('captured'), options);
    options.actor.kind = 'agent_run'; options.scope.id = id('another-project'); options.authorize = () => false;
    expect((await pending).status).toBe('adopted'); expect(row((await store.read(project))!.state.head.shots, 'sh_1').action).toBe('captured');
  });
  it('persists split-dependent references and generated identities as one adopted snapshot', async () => {
    const project = key(); const pkg = makeProductionPackage(); await store.initialize(project, pkg);
    const { version: _version, ...shot } = row(pkg.shots, 'sh_2');
    const bases = Object.values(pkg).filter(Array.isArray).flatMap(rows => rows.filter((r): r is { id: string; version: number } => r && typeof r === 'object' && 'id' in r && 'version' in r).map(r => ({ id: r.id, version: r.version })));
    const change = changeSet([{ op: 'split', op_id: id('op-db-split'), target: shot.id, into: [
      { ...structuredClone(shot), id: id('db-first'), duration: { planned: 2, measured: null } },
      { ...structuredClone(shot), id: id('db-second'), duration: { planned: 4, measured: null } },
    ] }], { id: id('db-split'), base_revisions: bases });
    let allocated = 0; const submitted = await store.submit(project, change, { newId: () => id('db-generated-' + allocated++) });
    expect(submitted.status).toBe('candidate'); expect(submitted.state.changes[0]?.generated_ids).toHaveLength(2);
    const savedIds = submitted.state.changes[0]!.generated_ids;
    await store.submit(project, change, { newId: () => { throw new Error('must reuse saved preview IDs'); } });
    expect((await store.adopt(project, change.id, approval())).status).toBe('adopted');
    const saved = (await new PostgresVersionStore(pool).read(project))!;
    expect(saved.state.changes[0]?.generated_ids).toEqual(savedIds); expect(saved.state.head.shot_takes.filter(t => savedIds.includes(t.id))).toHaveLength(2);
    expect(row(saved.state.head.panels, 'p_key').version).toBe(2); expect(row(saved.state.head.audio_cues, 'cue_say').version).toBe(2);
  });
  it('rejects malformed commands, missing projects and unsafe storage-counter overflow', async () => {
    const project = key();
    await expect(store.read({ ...project, tenantId: 'untrusted' })).rejects.toMatchObject({ code: 'INVALID_KEY' });
    await expect(store.submit(project, request('missing'))).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(store.adopt(project, 'invalid', approval())).rejects.toMatchObject({ code: 'INVALID_CHANGE_ID' });
    await expect(store.reject(project, 'invalid', approval(), 'reason')).rejects.toMatchObject({ code: 'INVALID_CHANGE_ID' });
    await expect(store.reject(project, id('valid'), approval(), undefined as unknown as string)).rejects.toMatchObject({ code: 'INVALID_CHANGE_ID' });
    await expect(store.submit(project, { not: Infinity })).rejects.toMatchObject({ code: 'NON_JSON' });
    await store.initialize(project, makePackage());
    const invalidSchema = await store.submit(project, {}); expect(invalidSchema.issues.map(i => i.code)).toContain('SCHEMA'); expect(invalidSchema.writeVersion).toBe(1);
    await pool.query('UPDATE camery_versioning.projects SET write_version=9007199254740991 WHERE tenant_id=$1 AND project_id=$2', [project.tenantId, project.projectId]);
    await expect(store.submit(project, request('overflow'))).rejects.toMatchObject({ code: 'VERSION_OVERFLOW' }); expect((await store.read(project))?.state.changes).toEqual([]);
  });
  it.each(['structure', 'package-identity'] as const)('fails explicitly on corrupted adopted snapshot %s', async mode => {
    const project = key(); await store.initialize(project, makePackage());
    const corrupted = mode === 'structure' ? { project: { id: project.projectId }, revision: { number: 5, status: 'adopted' } } : { ...makePackage(), package_id: id('wrong-package') };
    await pool.query('UPDATE camery_versioning.snapshots SET package=$3::jsonb WHERE tenant_id=$1 AND project_id=$2', [project.tenantId, project.projectId, JSON.stringify(corrupted)]);
    await expect(store.read(project)).rejects.toMatchObject({ code: 'CORRUPT_STATE' });
  });
  it('sanitizes driver failures without exposing connection details or SQL values', async () => {
    const closed = new Pool({ connectionString: url }); await closed.end();
    const failed = new PostgresVersionStore(closed); const project = key();
    await expect(failed.read(project)).rejects.toMatchObject({ code: 'DATABASE_ERROR', operation: 'read', projectId: project.projectId });
    try { await failed.read(project); } catch (error) { expect(String(error)).not.toContain('postgresql://'); expect(String(error)).not.toContain('SELECT'); }
  });
  it('verifies migration history and serializes repeated migration calls', async () => {
    await Promise.all([migrateVersioning(pool), migrateVersioning(pool)]);
    const rows = await pool.query('SELECT version,checksum FROM camery_versioning.migrations'); expect(rows.rows).toHaveLength(1); expect(rows.rows[0].version).toBe(1);
    for (const version of [1, 2]) {
      const client = { query: vi.fn(async (query: string) => ({ rows: query.startsWith('SELECT version') ? [{ version, checksum: 'changed' }] : [] })), release: vi.fn() };
      await expect(migrateVersioning({ connect: async () => client } as unknown as Pool)).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' });
      expect(client.query).toHaveBeenCalledWith('ROLLBACK'); expect(client.release).toHaveBeenCalledOnce();
    }
  });
  it('writes fresh migration DDL and its history entry in one transaction', async () => {
    const client = { query: vi.fn(async (_query: string, _parameters?: unknown[]) => ({ rows: [] })), release: vi.fn() };
    await migrateVersioning({ connect: async () => client } as unknown as Pool);
    expect(client.query.mock.calls.some(call => call[0].includes('CREATE TABLE camery_versioning.projects'))).toBe(true);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT'); expect(client.release).toHaveBeenCalledOnce();
  });
});

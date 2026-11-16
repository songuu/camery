import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessError } from '../src/index.js';
import { migrateAccess, PostgresSessionStore, verifyRuntimeRole } from '../src/node/index.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for access integration tests');
describe('PostgreSQL access boundary', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresSessionStore(pool);
  const tenants: string[] = [];
  let tenant: string;
  let hash: string;
  const userId = 'user-1';
  const sessionId = 'session-1';
  beforeAll(async () => { await Promise.all([migrateAccess(pool), migrateAccess(pool)]); });
  beforeEach(async () => {
    tenant = `access-${randomUUID()}`; tenants.push(tenant);
    hash = createHash('sha256').update(randomUUID()).digest('hex');
    await store.provisionMember({ tenantId: tenant, userId, projectId: 'project-1', role: 'viewer' });
    await store.createSession({ tenantId: tenant, userId, sessionId, tokenHash: hash, ttlSeconds: 3600 });
  });
  afterAll(async () => {
    await pool.query('DELETE FROM camery_access.sessions WHERE tenant_id=ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM camery_access.memberships WHERE tenant_id=ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM camery_access.users WHERE tenant_id=ANY($1::text[])', [tenants]);
    await pool.end();
  });
  it('reloads a persisted identity through a fresh store without retaining the raw token or hash', async () => {
    const freshPool = new Pool({ connectionString: databaseUrl });
    try {
      const identity = await new PostgresSessionStore(freshPool).lookup(tenant, hash);
      expect(identity).toEqual({ tenantId: tenant, userId, sessionId, grants: [{ projectId: 'project-1', role: 'viewer' }] });
      expect(JSON.stringify(identity)).not.toContain(hash);
    } finally { await freshPool.end(); }
  });
  it('does not accept a different tenant or token hash', async () => {
    expect(await store.lookup('other-tenant', hash)).toBeNull();
    expect(await store.lookup(tenant, '0'.repeat(64))).toBeNull();
  });
  it('loads project roles anew for each authentication', async () => {
    await store.provisionMember({ tenantId: tenant, userId, projectId: 'project-1', role: 'reviewer' });
    await store.provisionMember({ tenantId: tenant, userId, projectId: 'project-2', role: 'editor' });
    expect((await store.lookup(tenant, hash))?.grants).toEqual([
      { projectId: 'project-1', role: 'reviewer' }, { projectId: 'project-2', role: 'editor' },
    ]);
    await pool.query('DELETE FROM camery_access.memberships WHERE tenant_id=$1 AND project_id=$2', [tenant, 'project-1']);
    expect((await store.lookup(tenant, hash))?.grants).toEqual([{ projectId: 'project-2', role: 'editor' }]);
  });
  it('revokes only the exact authenticated tenant, session and user', async () => {
    await store.revoke('other-tenant', sessionId, userId);
    await store.revoke(tenant, sessionId, 'other-user');
    await store.revoke(tenant, 'other-session', userId);
    expect(await store.lookup(tenant, hash)).not.toBeNull();
    await store.revoke(tenant, sessionId, userId);
    await store.revoke(tenant, sessionId, userId);
    expect(await store.lookup(tenant, hash)).toBeNull();
  });
  it('uses database time for expiration', async () => {
    await pool.query("UPDATE camery_access.sessions SET created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [tenant]);
    expect(await store.lookup(tenant, hash)).toBeNull();
  });
  it('disables all sessions and does not reenable a user when adding membership', async () => {
    await store.setUserEnabled(tenant, userId, false);
    expect(await store.lookup(tenant, hash)).toBeNull();
    await store.provisionMember({ tenantId: tenant, userId, projectId: 'project-2', role: 'admin' });
    await expect(store.createSession({ tenantId: tenant, userId, sessionId: 'new', tokenHash: 'f'.repeat(64), ttlSeconds: 60 })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await store.lookup(tenant, hash)).toBeNull();
    await store.setUserEnabled(tenant, userId, true);
    expect(await store.lookup(tenant, hash)).not.toBeNull();
  });
  it('does not issue sessions for unknown users or collide across tenant/session identities', async () => {
    await expect(store.createSession({ tenantId: 'unknown', userId, sessionId, tokenHash: 'a'.repeat(64), ttlSeconds: 60 })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(store.createSession({ tenantId: tenant, userId, sessionId, tokenHash: 'b'.repeat(64), ttlSeconds: 60 })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const otherTenant = `access-${randomUUID()}`; tenants.push(otherTenant);
    await store.provisionMember({ tenantId: otherTenant, userId, projectId: 'project-1', role: 'admin' });
    await expect(store.createSession({ tenantId: otherTenant, userId, sessionId, tokenHash: hash, ttlSeconds: 60 })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect((await store.lookup(tenant, hash))?.grants[0]?.role).toBe('viewer');
  });
  it.each([59, 86401, 1.5, NaN])('rejects invalid lifetime %s before issuing credentials', async ttlSeconds => {
    await expect(store.createSession({ tenantId: tenant, userId, sessionId: 'new', tokenHash: 'c'.repeat(64), ttlSeconds })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('rejects malformed keys, hashes and roles without SQL injection', async () => {
    await expect(store.lookup("tenant';DROP SCHEMA camery_access CASCADE--", hash)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.lookup(tenant, 'secret')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.revoke(tenant, '', userId)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.setUserEnabled(tenant, '', true)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.provisionMember({ tenantId: tenant, userId, projectId: '', role: 'admin' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.provisionMember({ tenantId: tenant, userId, projectId: 'project-1', role: 'owner' as 'admin' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await store.lookup(tenant, hash)).not.toBeNull();
  });
  it('rejects nondata provisioning fields and invalid scalar types', async () => {
    const getter = vi.fn(() => tenant);
    const request = { userId, projectId: 'project-1', role: 'viewer' as const };
    Object.defineProperty(request, 'tenantId', { get: getter });
    await expect(store.provisionMember(request as typeof request & { tenantId: string })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(getter).not.toHaveBeenCalled();
    await expect(store.provisionMember(null as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.createSession(undefined as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.lookup(undefined as never, hash)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.lookup(tenant, undefined as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.lookup(tenant + '\n', hash)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.lookup(tenant, hash + '\n')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.setUserEnabled(tenant, userId, 1 as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.provisionMember({ tenantId: tenant, userId, projectId: 'project-1', role: null as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.createSession({ tenantId: tenant, userId, sessionId: 'new', tokenHash: 'c'.repeat(64), ttlSeconds: '60' as never })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('refuses a changed or unknown migration history, then recovers after restoration', async () => {
    const original = await pool.query<{ checksum: string }>('SELECT checksum FROM camery_access.migrations WHERE version=1');
    try {
      await pool.query("UPDATE camery_access.migrations SET checksum='tampered' WHERE version=1");
      await expect(migrateAccess(pool)).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' });
    } finally { await pool.query('UPDATE camery_access.migrations SET checksum=$1 WHERE version=1', [original.rows[0]?.checksum]); }
    try {
      await pool.query("INSERT INTO camery_access.migrations(version,checksum) VALUES(2,'future')");
      await expect(migrateAccess(pool)).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' });
    } finally { await pool.query('DELETE FROM camery_access.migrations WHERE version=2'); }
    await migrateAccess(pool);
    expect(await store.lookup(tenant, hash)).not.toBeNull();
  });
  it('converts driver errors into fixed safe errors without retaining secret SQL parameters', async () => {
    const secret = 'postgres://sensitive-password@private-db';
    const brokenPool = { query: vi.fn().mockRejectedValue(new Error(secret)), connect: vi.fn().mockRejectedValue(new Error(secret)) } as unknown as Pool;
    const broken = new PostgresSessionStore(brokenPool);
    const operations = [
      () => broken.lookup(tenant, hash), () => broken.revoke(tenant, sessionId, userId),
      () => broken.setUserEnabled(tenant, userId, false),
      () => broken.createSession({ tenantId: tenant, userId, sessionId: 'new', tokenHash: hash, ttlSeconds: 60 }),
      () => broken.provisionMember({ tenantId: tenant, userId, projectId: 'project-1', role: 'viewer' }),
      () => migrateAccess(brokenPool), () => verifyRuntimeRole(brokenPool),
    ];
    for (const operation of operations) {
      const error: unknown = await operation().catch(value => value);
      expect(error).toMatchObject({ code: 'STORAGE_FAILED', message: 'Access storage unavailable' });
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(error).not.toHaveProperty('cause');
    }
  });
  it('releases failed provisioning and migration connections even if rollback also fails', async () => {
    const release = vi.fn();
    const failedClient = { query: vi.fn().mockRejectedValue(new Error('private driver error')), release };
    const brokenPool = { connect: vi.fn().mockResolvedValue(failedClient) } as unknown as Pool;
    await expect(new PostgresSessionStore(brokenPool).provisionMember({ tenantId: tenant, userId, projectId: 'project-1', role: 'viewer' })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(migrateAccess(brokenPool)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(release).toHaveBeenCalledTimes(2);
  });
  it('supports the bounded minimum and maximum lifetime', async () => {
    for (const ttlSeconds of [60, 86400]) {
      const tokenHash = createHash('sha256').update(String(ttlSeconds) + tenant).digest('hex');
      await store.createSession({ tenantId: tenant, userId, sessionId: String(ttlSeconds), tokenHash, ttlSeconds });
      expect(await store.lookup(tenant, tokenHash)).not.toBeNull();
    }
  });
  it('authenticates and revokes under an unprivileged runtime role that cannot grant or issue', async () => {
    const role = `access_test_${randomUUID().replaceAll('-', '')}`;
    const alternateRole = `access_test_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(32).toString('hex');
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await pool.query(`CREATE ROLE ${alternateRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    let runtimePool: Pool | undefined;
    try {
      await pool.query(`GRANT USAGE ON SCHEMA camery_access TO ${role}`);
      await pool.query(`GRANT SELECT ON camery_access.users, camery_access.memberships, camery_access.sessions TO ${role}`);
      await pool.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${role}`);
      const runtimeUrl = new URL(databaseUrl!); runtimeUrl.username = role; runtimeUrl.password = password;
      runtimeUrl.searchParams.delete('options');
      runtimePool = new Pool({ connectionString: runtimeUrl.toString() });
      const current = await runtimePool.query<{ current_user: string; session_user: string; rolsuper: boolean }>('SELECT current_user, session_user, rolsuper FROM pg_roles WHERE rolname=current_user');
      expect(current.rows[0]).toEqual({ current_user: role, session_user: role, rolsuper: false });
      await expect(verifyRuntimeRole(runtimePool)).resolves.toBeUndefined();
      await expect(verifyRuntimeRole(pool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const switchedAdminPool = new Pool({ connectionString: databaseUrl, options: `-c role=${role}` });
      try { await expect(verifyRuntimeRole(switchedAdminPool)).rejects.toMatchObject({ code: 'FORBIDDEN' }); }
      finally { await switchedAdminPool.end(); }
      await pool.query(`GRANT UPDATE ON camery_access.users TO ${alternateRole}`);
      await pool.query(`GRANT ${alternateRole} TO ${role} WITH INHERIT FALSE, SET TRUE`);
      await expect(runtimePool.query('UPDATE camery_access.users SET enabled=false WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(verifyRuntimeRole(runtimePool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await pool.query(`REVOKE ${alternateRole} FROM ${role}`);
      await expect(verifyRuntimeRole(runtimePool)).resolves.toBeUndefined();
      await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_access FROM ${alternateRole}`);
      for (const options of ['ADMIN TRUE, INHERIT FALSE, SET FALSE', 'ADMIN FALSE, INHERIT TRUE, SET FALSE']) {
        await pool.query(`GRANT ${alternateRole} TO ${role} WITH ${options}`);
        const membership = await runtimePool.query<{ member: boolean; can_set: boolean }>("SELECT pg_has_role(current_user,$1,'MEMBER') AS member,pg_has_role(current_user,$1,'SET') AS can_set", [alternateRole]);
        expect(membership.rows[0]).toEqual({ member: true, can_set: false });
        await expect(verifyRuntimeRole(runtimePool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await pool.query(`REVOKE ${alternateRole} FROM ${role}`);
      }
      for (const schema of ['camery_access', 'camery_agents', 'camery_durable']) {
        const present = await pool.query<{ oid: number | null }>('SELECT to_regnamespace($1)::oid AS oid', [schema]);
        if (present.rows[0]?.oid == null) continue;
        await pool.query(`GRANT CREATE ON SCHEMA ${schema} TO ${role}`);
        await expect(verifyRuntimeRole(runtimePool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await pool.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`);
      }
      await pool.query(`GRANT UPDATE ON camery_access.sessions TO ${role}`);
      await expect(verifyRuntimeRole(runtimePool)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await pool.query(`REVOKE UPDATE ON camery_access.sessions FROM ${role}`);
      await pool.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${role}`);
      await expect(verifyRuntimeRole(runtimePool)).resolves.toBeUndefined();
      const runtime = new PostgresSessionStore(runtimePool);
      expect(await runtime.lookup(tenant, hash)).not.toBeNull();
      await expect(runtime.provisionMember({ tenantId: tenant, userId, projectId: 'project-1', role: 'admin' })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
      await expect(runtime.createSession({ tenantId: tenant, userId, sessionId: 'new', tokenHash: 'd'.repeat(64), ttlSeconds: 60 })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
      await expect(runtime.setUserEnabled(tenant, userId, false)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
      await expect(runtimePool.query('CREATE TABLE camery_access.unauthorized_table(id integer)')).rejects.toMatchObject({ code: '42501' });
      await expect(migrateAccess(runtimePool)).rejects.toBeInstanceOf(AccessError);
      await runtime.revoke(tenant, sessionId, userId);
      expect(await runtime.lookup(tenant, hash)).toBeNull();
    } finally {
      await runtimePool?.end();
      await pool.query(`REVOKE ${alternateRole} FROM ${role}`);
      await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_access FROM ${alternateRole}`);
      await pool.query(`DROP ROLE ${alternateRole}`);
      await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_access FROM ${role}`);
      for (const schema of ['camery_access', 'camery_agents', 'camery_durable']) {
        const present = await pool.query<{ oid: number | null }>('SELECT to_regnamespace($1)::oid AS oid', [schema]);
        if (present.rows[0]?.oid != null) await pool.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${role}`);
      }
      await pool.query(`DROP ROLE ${role}`);
    }
  });
});

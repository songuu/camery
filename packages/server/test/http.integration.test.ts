import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { issueSession } from '@camery/access';
import { migrateAccess, PostgresSessionStore, verifyRuntimeRole } from '@camery/access/node';
import { createApplication } from '../src/app.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for server integration tests');
describe('actual PostgreSQL + Nest/Fastify access', () => {
  it('authenticates under a separate restricted login, reloads roles and rejects revoked credentials', async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const tenantId = `http-${randomUUID()}`; const role = `http_test_${randomBytes(12).toString('hex')}`;
    const password = randomBytes(32).toString('hex');
    let runtime: Pool | undefined; let app: Awaited<ReturnType<typeof createApplication>> | undefined; let roleCreated = false;
    try {
      await migrateAccess(admin);
      const installer = new PostgresSessionStore(admin);
      await installer.provisionMember({ tenantId, userId: 'user-a', projectId: 'project-a', role: 'editor' });
      const credentials = await issueSession({ tenantId, userId: 'user-a', ttlSeconds: 3600 }, installer);
      // Both values are generated lowercase hex; never use user input in role DDL.
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`); roleCreated = true;
      await admin.query(`GRANT USAGE ON SCHEMA camery_access TO ${role}`);
      await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${role}`);
      await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${role}`);
      const url = new URL(databaseUrl!); url.username = role; url.password = password;
      runtime = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
      await verifyRuntimeRole(runtime);
      const users = await runtime.query<{ current_user: string; session_user: string }>('SELECT current_user,session_user');
      expect(users.rows[0]).toEqual({ current_user: role, session_user: role });
      app = await createApplication({ tenantId, store: new PostgresSessionStore(runtime) });
      const headers = { authorization: `Bearer ${credentials.token}` };
      const request = (path: string) => app!.inject({ method: 'GET', url: path, headers });
      expect((await request('/api/v1/me')).json()).toEqual({ tenantId, userId: 'user-a', grants: [{ projectId: 'project-a', role: 'editor' }] });
      expect((await request('/api/v1/projects/project-b/access')).statusCode).toBe(403);
      await installer.provisionMember({ tenantId, userId: 'user-a', projectId: 'project-a', role: 'viewer' });
      expect((await request('/api/v1/projects/project-a/access')).json()).toEqual({ projectId: 'project-a', permissions: ['project:read'] });
      await installer.setUserEnabled(tenantId, 'user-a', false);
      expect((await request('/api/v1/me')).statusCode).toBe(401);
      await installer.setUserEnabled(tenantId, 'user-a', true);
      expect((await app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers })).statusCode).toBe(204);
      expect((await request('/api/v1/me')).statusCode).toBe(401);
      const raw = await admin.query<{ token_hash: string }>('SELECT token_hash FROM camery_access.sessions WHERE tenant_id=$1', [tenantId]);
      expect(raw.rows[0]?.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(raw.rows)).not.toContain(credentials.token);
    } finally {
      await app?.close(); await runtime?.end();
      await admin.query('DELETE FROM camery_access.sessions WHERE tenant_id=$1', [tenantId]);
      await admin.query('DELETE FROM camery_access.memberships WHERE tenant_id=$1', [tenantId]);
      await admin.query('DELETE FROM camery_access.users WHERE tenant_id=$1', [tenantId]);
      if (roleCreated) {
        await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_access FROM ${role}`);
        await admin.query(`REVOKE USAGE ON SCHEMA camery_access FROM ${role}`);
        await admin.query(`DROP ROLE ${role}`);
      }
      await admin.end();
    }
  });
});

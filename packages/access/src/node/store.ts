import type { Pool } from 'pg';
import { AccessError, type Role, type SessionIdentity } from '../index.js';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/;
const hashPattern = /^[a-f0-9]{64}$(?![\s\S])/;
const roles: readonly string[] = ['viewer', 'editor', 'reviewer', 'admin'];
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new AccessError('INVALID_INPUT');
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !hashPattern.test(value)) throw new AccessError('INVALID_INPUT');
}
function role(value: unknown): asserts value is Role {
  if (typeof value !== 'string' || !roles.includes(value)) throw new AccessError('INVALID_INPUT');
}
function fields(input: unknown, names: readonly string[]): Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object') throw new AccessError('INVALID_INPUT');
    return Object.fromEntries(names.map(name => {
      const descriptor = Object.getOwnPropertyDescriptor(input, name);
      if (!descriptor || !('value' in descriptor)) throw new AccessError('INVALID_INPUT');
      return [name, descriptor.value];
    }));
  } catch { throw new AccessError('INVALID_INPUT'); }
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { if (error instanceof AccessError) throw error; throw new AccessError('STORAGE_FAILED'); }
}
type Membership = { tenantId: string; userId: string; projectId: string; role: Role };
type Session = { tenantId: string; userId: string; sessionId: string; tokenHash: string; ttlSeconds: number };

/** Server-only repository. Provisioning methods require a separate privileged pool, never the runtime role. */
export class PostgresSessionStore {
  constructor(private readonly pool: Pool) {}

  async lookup(tenantId: string, tokenHash: string): Promise<SessionIdentity | null> {
    id(tenantId); hash(tokenHash);
    return safe(async () => {
      // One statement keeps enabled, expiry and current membership in the same database snapshot.
      const result = await this.pool.query<{ tenant_id: string; user_id: string; session_id: string; grants: { projectId: string; role: Role }[] }>(`
        SELECT s.tenant_id,s.user_id,s.session_id,
          COALESCE(jsonb_agg(jsonb_build_object('projectId',m.project_id,'role',m.role) ORDER BY m.project_id)
            FILTER (WHERE m.project_id IS NOT NULL),'[]'::jsonb) AS grants
        FROM camery_access.sessions s
        JOIN camery_access.users u ON u.tenant_id=s.tenant_id AND u.user_id=s.user_id
        LEFT JOIN camery_access.memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.user_id
        WHERE s.tenant_id=$1 AND s.token_hash=$2 AND s.revoked_at IS NULL
          AND s.expires_at>clock_timestamp() AND u.enabled
        GROUP BY s.tenant_id,s.user_id,s.session_id`, [tenantId, tokenHash]);
      const row = result.rows[0];
      return row ? { tenantId: row.tenant_id, userId: row.user_id, sessionId: row.session_id, grants: row.grants } : null;
    });
  }

  async revoke(tenantId: string, sessionId: string, userId: string): Promise<void> {
    id(tenantId); id(sessionId); id(userId);
    await safe(async () => {
      await this.pool.query(`UPDATE camery_access.sessions SET revoked_at=clock_timestamp()
        WHERE tenant_id=$1 AND session_id=$2 AND user_id=$3 AND revoked_at IS NULL`, [tenantId, sessionId, userId]);
    });
  }

  async provisionMember(input: Membership): Promise<void> {
    const value = fields(input, ['tenantId', 'userId', 'projectId', 'role']);
    const { tenantId, userId, projectId } = value;
    id(tenantId); id(userId); id(projectId); role(value['role']);
    const grantedRole = value['role'];
    await safe(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // Adding a grant must not silently reactivate a previously disabled account.
        await client.query('INSERT INTO camery_access.users(tenant_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [tenantId, userId]);
        await client.query(`INSERT INTO camery_access.memberships(tenant_id,user_id,project_id,role) VALUES($1,$2,$3,$4)
          ON CONFLICT(tenant_id,user_id,project_id) DO UPDATE SET role=EXCLUDED.role`, [tenantId, userId, projectId, grantedRole]);
        await client.query('COMMIT');
      } catch { try { await client.query('ROLLBACK'); } catch { /* Connection release still runs. */ } throw new AccessError('STORAGE_FAILED'); }
      finally { client.release(); }
    });
  }

  async setUserEnabled(tenantId: string, userId: string, enabled: boolean): Promise<void> {
    id(tenantId); id(userId);
    if (typeof enabled !== 'boolean') throw new AccessError('INVALID_INPUT');
    await safe(async () => { await this.pool.query('UPDATE camery_access.users SET enabled=$3 WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId, enabled]); });
  }

  async createSession(input: Session): Promise<void> {
    const value = fields(input, ['tenantId', 'userId', 'sessionId', 'tokenHash', 'ttlSeconds']);
    const { tenantId, userId, sessionId, tokenHash, ttlSeconds } = value;
    id(tenantId); id(userId); id(sessionId); hash(tokenHash);
    if (typeof ttlSeconds !== 'number' || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) throw new AccessError('INVALID_INPUT');
    await safe(async () => {
      const result = await this.pool.query(`INSERT INTO camery_access.sessions(tenant_id,user_id,session_id,token_hash,created_at,expires_at)
        SELECT tenant_id,user_id,$3,$4,t.at,t.at+($5::integer*interval '1 second')
        FROM camery_access.users CROSS JOIN (SELECT clock_timestamp() AS at) t
        WHERE tenant_id=$1 AND user_id=$2 AND enabled`, [tenantId, userId, sessionId, tokenHash, ttlSeconds]);
      if (result.rowCount !== 1) throw new AccessError('UNAUTHENTICATED');
    });
  }
}

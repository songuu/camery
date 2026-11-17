import type { Pool } from 'pg';
import { AccessError } from '@camery/access';

interface Permission { readonly table: string; readonly read: boolean; readonly insert: boolean; readonly updates: readonly string[] }
// Shared text-stage execution only: no collaboration trees, source rows, authentication, installation or settlement.
const permissions: readonly Permission[] = [
  { table: 'camery_durable.tasks', read: true, insert: true, updates: ['status', 'attempts', 'fence', 'owner', 'lease_until', 'available_at', 'failure_count', 'error', 'updated_at', 'output'] },
  { table: 'camery_durable.steps', read: true, insert: true, updates: ['status', 'error', 'output', 'updated_at'] },
  { table: 'camery_durable.signals', read: true, insert: true, updates: [] },
  { table: 'camery_durable.events', read: true, insert: true, updates: [] },
  { table: 'camery_agents.budget_projects', read: true, insert: false, updates: ['project_id'] },
  // FOR UPDATE requires an UPDATE privilege; identifiers are lock capabilities, never limits or receipt fields.
  { table: 'camery_agents.budget_allocations', read: true, insert: true, updates: ['allocation_id'] },
  { table: 'camery_agents.budget_events', read: false, insert: true, updates: [] },
];
const userSchema = "n.nspname !~ '^pg_' AND n.nspname<>'information_schema'";
interface Relation {
  table_name: string; readable: boolean; insertable: boolean; updatable: boolean;
  forbidden: boolean; grantable: boolean; owned: boolean;
}
interface Column {
  table_name: string; column_name: string; readable: boolean; insertable: boolean;
  updatable: boolean; referencable: boolean; grantable: boolean;
}

/** Explicit installation helper. Startup only verifies; it never creates or grants identities. */
export async function grantBibleTaskRuntimeRole(pool: Pool, role: string): Promise<void> {
  if (typeof role !== 'string' || !/^[a-z][a-z0-9_]{0,62}$(?![\s\S])/.test(role)) throw new AccessError('INVALID_INPUT');
  let client; let destroy = false;
  try {
    client = await pool.connect(); await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA camery_durable,camery_agents TO "${role}"`);
    for (const permission of permissions) {
      const table = permission.table;
      const tableGrants = [permission.read ? 'SELECT' : '', permission.insert ? 'INSERT' : ''].filter(Boolean);
      await client.query(`GRANT ${tableGrants.join(',')} ON ${table} TO "${role}"`);
      if (permission.updates.length) await client.query(`GRANT UPDATE(${permission.updates.join(',')}) ON ${table} TO "${role}"`);
    }
    await client.query('COMMIT');
  } catch {
    try { await client?.query('ROLLBACK'); } catch { destroy = true; }
    throw new AccessError('STORAGE_FAILED');
  // oxlint-disable-next-line eslint/no-unsafe-finally -- Release failures must remain redacted as STORAGE_FAILED.
  } finally { try { client?.release(destroy); } catch { throw new AccessError('STORAGE_FAILED'); } }
}

/** Reject expanded capabilities as well as missing ones; this is a trusted service identity, not RLS. */
export async function verifyBibleTaskRuntimeRole(pool: Pool): Promise<void> {
  try {
    const identity = await pool.query<{ allowed: boolean }>(`
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit AND NOT r.rolreplication
        AND session_user=current_user
        AND NOT EXISTS (SELECT 1 FROM pg_roles other_role WHERE other_role.oid<>r.oid AND pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND NOT has_database_privilege(current_database(),'CREATE')
        AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE ${userSchema}
          AND (has_schema_privilege(n.oid,'CREATE') OR has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION') OR n.nspowner=r.oid))
        AND has_schema_privilege('camery_durable','USAGE') AND has_schema_privilege('camery_agents','USAGE') AS allowed
      FROM pg_roles r WHERE r.rolname=current_user`);
    if (identity.rows[0]?.allowed !== true) throw new AccessError('FORBIDDEN');
    const relations = await pool.query<Relation>(`
      SELECT n.nspname||'.'||c.relname AS table_name,
        CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'SELECT') ELSE false END AS readable, CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'INSERT') ELSE false END AS insertable,
        CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'UPDATE') ELSE false END AS updatable,
        CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END AS forbidden,
        CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,DELETE WITH GRANT OPTION,TRUNCATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION,TRIGGER WITH GRANT OPTION') ELSE false END AS grantable,
        c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`);
    const seen = new Set<string>();
    for (const relation of relations.rows) {
      const permission = permissions.find(item => item.table === relation.table_name);
      if (relation.readable !== (permission?.read ?? false) || relation.insertable !== (permission?.insert ?? false)
          || relation.updatable !== false || relation.forbidden !== false || relation.grantable !== false || relation.owned !== false) throw new AccessError('FORBIDDEN');
      seen.add(relation.table_name);
    }
    if (permissions.some(permission => !seen.has(permission.table))) throw new AccessError('FORBIDDEN');
    const columns = await pool.query<Column>(`
      SELECT n.nspname||'.'||c.relname AS table_name,a.attname AS column_name,
        CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'SELECT') ELSE false END AS readable, CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'INSERT') ELSE false END AS insertable,
        CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'UPDATE') ELSE false END AS updatable, CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'REFERENCES') ELSE false END AS referencable,
        CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION,UPDATE WITH GRANT OPTION,REFERENCES WITH GRANT OPTION') ELSE false END AS grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped`);
    const requiredUpdates = new Set(permissions.flatMap(permission => permission.updates.map(column => `${permission.table}.${column}`)));
    for (const column of columns.rows) {
      const permission = permissions.find(item => item.table === column.table_name);
      const update = permission?.updates.includes(column.column_name) ?? false;
      if (column.readable !== (permission?.read ?? false) || column.insertable !== (permission?.insert ?? false)
          || column.updatable !== update || column.referencable !== false || column.grantable !== false) throw new AccessError('FORBIDDEN');
      requiredUpdates.delete(`${column.table_name}.${column.column_name}`);
    }
    if (requiredUpdates.size) throw new AccessError('FORBIDDEN');
    // Identity columns issue their own values; worker code never calls sequence functions directly.
    const sequences = await pool.query<{ forbidden: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE ${userSchema} AND c.relkind='S' AND
          CASE WHEN c.relkind='S' THEN (has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') OR c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) ELSE false END) AS forbidden`);
    if (sequences.rows[0]?.forbidden !== false) throw new AccessError('FORBIDDEN');
  } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError('STORAGE_FAILED'); }
}

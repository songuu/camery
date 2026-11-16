import type { Pool } from 'pg';
import { AccessError } from '../index.js';

/** Fail startup when a runtime connection could administer identities or mint credentials. */
export async function verifyRuntimeRole(pool: Pool): Promise<void> {
  try {
    const result = await pool.query<{ allowed: boolean }>(`
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb
        AND session_user=current_user
        AND NOT EXISTS (SELECT 1 FROM pg_roles other_role WHERE other_role.oid<>r.oid AND pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND NOT has_database_privilege(current_database(),'CREATE')
        AND NOT EXISTS (
          SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','camery_access','camery_durable','camery_agents')
          AND (n.nspowner=r.oid OR has_schema_privilege(n.oid,'CREATE'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','camery_access','camery_durable','camery_agents') AND c.relowner=r.oid
        )
        AND has_schema_privilege('camery_access','USAGE')
        AND has_table_privilege('camery_access.users','SELECT')
        AND has_table_privilege('camery_access.memberships','SELECT')
        AND has_table_privilege('camery_access.sessions','SELECT')
        AND has_column_privilege('camery_access.sessions','revoked_at','UPDATE')
        AND NOT has_table_privilege('camery_access.users','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT has_table_privilege('camery_access.memberships','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT has_table_privilege('camery_access.sessions','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns c
          WHERE c.table_schema='camery_access'
            AND c.table_name IN ('users','memberships','sessions')
            AND NOT (c.table_name='sessions' AND c.column_name='revoked_at')
            AND has_column_privilege(format('%I.%I',c.table_schema,c.table_name),c.column_name,'INSERT,UPDATE,REFERENCES')
        ) AS allowed
      FROM pg_roles r WHERE r.rolname=current_user`);
    if (result.rows[0]?.allowed !== true) throw new AccessError('FORBIDDEN');
  } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError('STORAGE_FAILED'); }
}

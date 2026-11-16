import type { Pool } from 'pg';
import { BibleError } from '../contracts.js';

/** Dedicated knowledge-store LOGIN: source reads and append-only Bible rows; authentication uses another pool. */
export async function verifyBibleRuntimeRole(pool:Pool):Promise<void> {
  try {
    // PostgreSQL may reorder WHERE predicates; CASE prevents relation-specific ACL functions receiving another object kind.
    const result=await pool.query<{allowed:boolean}>(`
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolinherit
        AND session_user=current_user
        AND NOT EXISTS(SELECT 1 FROM pg_roles other_role WHERE other_role.oid<>r.oid AND pg_has_role(current_user,other_role.oid,'MEMBER'))
        AND NOT has_database_privilege(current_database(),'CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND (n.nspowner=r.oid OR has_schema_privilege(n.oid,'CREATE')))
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relowner=r.oid)
        AND has_schema_privilege('camery_ingest','USAGE') AND has_schema_privilege('camery_bible','USAGE')
        AND has_table_privilege('camery_ingest.documents','SELECT') AND has_table_privilege('camery_ingest.scripts','SELECT')
        AND has_table_privilege('camery_bible.runs','SELECT') AND has_table_privilege('camery_bible.runs','INSERT')
        AND has_table_privilege('camery_bible.chunks','SELECT') AND has_table_privilege('camery_bible.chunks','INSERT')
        AND has_table_privilege('camery_bible.candidates','SELECT') AND has_table_privilege('camery_bible.candidates','INSERT')
        AND has_table_privilege('camery_bible.reviews','SELECT') AND has_table_privilege('camery_bible.reviews','INSERT')
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(c.oid,CASE
            WHEN n.nspname='camery_ingest' AND c.relname IN ('documents','scripts') THEN 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            WHEN n.nspname='camery_bible' AND c.relname IN ('runs','chunks','candidates','reviews') THEN 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
            ELSE 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped THEN has_column_privilege(c.oid,a.attnum,CASE
            WHEN n.nspname='camery_ingest' AND c.relname IN ('documents','scripts') THEN 'INSERT,UPDATE,REFERENCES'
            WHEN n.nspname='camery_bible' AND c.relname IN ('runs','chunks','candidates','reviews') THEN 'UPDATE,REFERENCES'
            ELSE 'SELECT,INSERT,UPDATE,REFERENCES' END) ELSE false END)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
          AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE') ELSE false END) AS allowed
      FROM pg_roles r WHERE r.rolname=current_user`);
    if(result.rows[0]?.allowed!==true)throw new BibleError('STORAGE_FAILED','restricted Bible role');
  } catch(error) {if(error instanceof BibleError)throw error;throw new BibleError('STORAGE_FAILED','restricted Bible role');}
}

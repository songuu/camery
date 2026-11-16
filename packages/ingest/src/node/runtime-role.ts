import type { Pool } from 'pg';
import { ImportError } from '../types.js';

/** Startup check for the additional source privileges; authentication privileges are verified separately. */
export async function verifyIngestRuntimeRole(pool: Pool): Promise<void> {
  try {
    const result = await pool.query<{ allowed: boolean }>(`
      SELECT has_schema_privilege('camery_ingest','USAGE')
        AND NOT has_schema_privilege('camery_ingest','CREATE')
        AND NOT EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname='camery_ingest' AND r.rolname=current_user)
        AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='camery_ingest' AND r.rolname=current_user)
        AND has_table_privilege('camery_ingest.documents','SELECT')
        AND has_table_privilege('camery_ingest.documents','INSERT')
        AND has_table_privilege('camery_ingest.documents','UPDATE')
        AND has_table_privilege('camery_ingest.reading_checkpoints','SELECT')
        AND has_table_privilege('camery_ingest.reading_checkpoints','INSERT')
        AND has_table_privilege('camery_ingest.reading_checkpoints','UPDATE')
        AND has_table_privilege('camery_ingest.scripts','SELECT')
        AND has_table_privilege('camery_ingest.scripts','INSERT')
        AND NOT has_table_privilege('camery_ingest.scripts','UPDATE')
        AND NOT has_table_privilege('camery_ingest.documents','DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT has_table_privilege('camery_ingest.reading_checkpoints','DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT has_table_privilege('camery_ingest.scripts','DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT has_table_privilege('camery_ingest.migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='camery_ingest'
          AND (has_column_privilege(format('%I.%I',c.table_schema,c.table_name),c.column_name,'REFERENCES')
            OR c.table_name IN ('migrations','scripts') AND has_column_privilege(format('%I.%I',c.table_schema,c.table_name),c.column_name,'UPDATE')
            OR c.table_name='migrations' AND has_column_privilege(format('%I.%I',c.table_schema,c.table_name),c.column_name,'SELECT,INSERT,REFERENCES')))
        AS allowed`);
    if (result.rows[0]?.allowed !== true) throw new ImportError('STORAGE_FAILED', 'restricted import role');
  } catch (error) { if (error instanceof ImportError) throw error; throw new ImportError('STORAGE_FAILED', 'restricted import role'); }
}

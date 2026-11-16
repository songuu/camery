import type { Pool, PoolClient } from 'pg';
import { ImportError } from '../types.js';
import type { DocumentScope } from '../session.js';
export function documentKeys(scope: DocumentScope) { return [scope.tenantId, scope.projectId, scope.documentId]; }
export async function documentTransaction<T>(pool: Pool, scope: DocumentScope, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect().catch(() => { throw new ImportError('STORAGE_FAILED', 'connection'); });
  try {
    await client.query('BEGIN');
    // A row lock cannot cover first insertion. Every importer for this scoped identity uses the same transaction lock.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['camery_ingest', ...documentKeys(scope)])]);
    const result = await action(client); await client.query('COMMIT'); return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { throw new ImportError('STORAGE_FAILED', 'rollback'); }
    if (error instanceof ImportError) throw error;
    throw new ImportError('STORAGE_FAILED', 'transaction');
  } finally { client.release(); }
}

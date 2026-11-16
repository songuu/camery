import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { textDigest } from '../data.js';
import { ImportError } from '../types.js';

/** Installation-only: importing source text never creates schemas or expands runtime privileges. */
export async function migrateIngest(pool: Pool): Promise<void> {
  const client = await pool.connect().catch(() => { throw new ImportError('STORAGE_FAILED', 'migration connection'); });
  try {
    const sql = await readFile(new URL('./migrations/0001-imports.sql', import.meta.url), 'utf8');
    const checksum = textDigest(sql);
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_ingest:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_ingest');
    await client.query('CREATE TABLE IF NOT EXISTS camery_ingest.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const applied = await client.query<{ version: number; checksum: string }>('SELECT version,checksum FROM camery_ingest.migrations ORDER BY version');
    if (applied.rows.length > 1 || applied.rows.some(row => row.version !== 1 || row.checksum !== checksum)) throw new ImportError('CONFLICT', 'migration checksum');
    if (!applied.rows.length) { await client.query(sql); await client.query('INSERT INTO camery_ingest.migrations(version,checksum) VALUES(1,$1)', [checksum]); }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { throw new ImportError('STORAGE_FAILED', 'migration rollback'); }
    if (error instanceof ImportError) throw error;
    throw new ImportError('STORAGE_FAILED', 'migration');
  } finally { client.release(); }
}

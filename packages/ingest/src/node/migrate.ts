import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { textDigest } from '../data.js';
import { ImportError } from '../types.js';

/** Installation-only: importing source text never creates schemas or expands runtime privileges. */
export async function migrateIngest(pool: Pool): Promise<void> {
  const client = await pool.connect().catch(() => { throw new ImportError('STORAGE_FAILED', 'migration connection'); });
  try {
    const migrations = await Promise.all(['0001-imports.sql','0002-scripts.sql'].map(async file => readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8')));
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_ingest:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_ingest');
    await client.query('CREATE TABLE IF NOT EXISTS camery_ingest.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const applied = await client.query<{ version: number; checksum: string }>('SELECT version,checksum FROM camery_ingest.migrations ORDER BY version');
    if (applied.rows.length > migrations.length || applied.rows.some((row, index) => row.version !== index + 1 || row.checksum !== textDigest(migrations[index]!))) throw new ImportError('CONFLICT', 'migration checksum');
    for (let index = applied.rows.length; index < migrations.length; index++) {
      await client.query(migrations[index]!);
      await client.query('INSERT INTO camery_ingest.migrations(version,checksum) VALUES($1,$2)', [index + 1, textDigest(migrations[index]!)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { throw new ImportError('STORAGE_FAILED', 'migration rollback'); }
    if (error instanceof ImportError) throw error;
    throw new ImportError('STORAGE_FAILED', 'migration');
  } finally { client.release(); }
}

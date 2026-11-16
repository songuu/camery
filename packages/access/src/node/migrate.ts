import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { AccessError } from '../index.js';

/** Explicit installation operation; the application runtime must not own schema/role creation privileges. */
export async function migrateAccess(pool: Pool): Promise<void> {
  try {
    const sql = await readFile(new URL('./migrations/0001-sessions.sql', import.meta.url), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_access:migrations',0))");
      await client.query('CREATE SCHEMA IF NOT EXISTS camery_access');
      await client.query('CREATE TABLE IF NOT EXISTS camery_access.migrations(version integer PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
      const result = await client.query<{ version: number; checksum: string }>('SELECT version,checksum FROM camery_access.migrations ORDER BY version');
      if (result.rows.length > 1 || result.rows.some(row => row.version !== 1 || row.checksum !== checksum)) throw new AccessError('MIGRATION_CONFLICT');
      if (result.rows.length === 0) {
        await client.query(sql);
        await client.query('INSERT INTO camery_access.migrations(version,checksum) VALUES(1,$1)', [checksum]);
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { throw new AccessError('STORAGE_FAILED'); }
      throw error;
    } finally { client.release(); }
  } catch (error) { if (error instanceof AccessError) throw error; throw new AccessError('STORAGE_FAILED'); }
}

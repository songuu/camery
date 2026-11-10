import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { DurableError } from './types.js';

/** DDL is explicit and serialized; a changed applied migration is never silently accepted. */
export async function migrateDurable(pool: Pool): Promise<void> {
  const migration = await readFile(new URL('./migrations/0001-durable.sql', import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(migration).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_durable:migrations', 0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_durable');
    await client.query('CREATE TABLE IF NOT EXISTS camery_durable.migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const applied = await client.query<{ version: number; checksum: string }>('SELECT version, checksum FROM camery_durable.migrations ORDER BY version');
    if (applied.rows.some(row => row.version !== 1 || row.checksum !== checksum)) {
      throw new DurableError('MIGRATION_CONFLICT', 'Durable migration history does not match this build');
    }
    if (!applied.rows.length) {
      await client.query(migration);
      await client.query('INSERT INTO camery_durable.migrations(version, checksum) VALUES (1, $1)', [checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

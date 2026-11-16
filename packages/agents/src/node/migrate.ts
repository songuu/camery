import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { AgentPersistenceError } from '../task-service.js';
/** One ordered history for all Agent persistence; existing version-1 budget SQL remains immutable. */
export async function migrateAgents(pool: Pool): Promise<void> {
  const migrations = await Promise.all(['0001-budgets.sql', '0002-collaboration.sql', '0003-outbox-fairness.sql'].map(async (file, index) => { const sql = await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8'); return { version: index + 1, sql, checksum: createHash('sha256').update(sql).digest('hex') }; }));
  let client; try { client = await pool.connect(); } catch { throw new AgentPersistenceError('AGENT_STORAGE_FAILED'); }
  try {
    await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_agents:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_agents');
    await client.query('CREATE TABLE IF NOT EXISTS camery_agents.migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())');
    const applied = await client.query<{ version: number; checksum: string }>('SELECT version,checksum FROM camery_agents.migrations ORDER BY version');
    if (applied.rows.some((row, index) => row.version !== index + 1 || migrations[index]?.checksum !== row.checksum)) throw new AgentPersistenceError('MIGRATION_CONFLICT');
    for (const migration of migrations.slice(applied.rows.length)) { await client.query(migration.sql); await client.query('INSERT INTO camery_agents.migrations(version,checksum) VALUES ($1,$2)', [migration.version, migration.checksum]); }
    await client.query('COMMIT');
  } catch (error) { try { await client.query('ROLLBACK'); } catch { throw new AgentPersistenceError('AGENT_STORAGE_FAILED'); } if (error instanceof AgentPersistenceError) throw error; throw new AgentPersistenceError('AGENT_STORAGE_FAILED'); } finally { client.release(); }
}

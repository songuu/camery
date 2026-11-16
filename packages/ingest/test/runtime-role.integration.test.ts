import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrateIngest } from '../src/node/migrate.js';
import { verifyIngestRuntimeRole } from '../src/node/runtime-role.js';
const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for source role tests');
describe('least privilege source runtime', () => {
  it('requires every necessary privilege and rejects schema/table administration', async () => {
    const admin = new Pool({ connectionString: databaseUrl }); const role = `source_${randomBytes(8).toString('hex')}`; const password = randomBytes(24).toString('hex');
    let runtime: Pool | undefined; let created = false;
    try {
      await migrateIngest(admin);
      await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT`); created = true;
      await admin.query(`GRANT USAGE ON SCHEMA camery_ingest TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON camery_ingest.documents,camery_ingest.reading_checkpoints TO ${role}`);
      await admin.query(`GRANT SELECT,INSERT ON camery_ingest.scripts TO ${role}`);
      const url = new URL(databaseUrl!); url.username = role; url.password = password;
      runtime = new Pool({ connectionString: url.toString() }); await verifyIngestRuntimeRole(runtime);
      for (const [table, privilege] of [['documents','SELECT'],['documents','INSERT'],['documents','UPDATE'],['reading_checkpoints','SELECT'],['reading_checkpoints','INSERT'],['reading_checkpoints','UPDATE'],['scripts','SELECT'],['scripts','INSERT']]) {
        await admin.query(`REVOKE ${privilege} ON camery_ingest.${table} FROM ${role}`);
        await expect(verifyIngestRuntimeRole(runtime)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
        await admin.query(`GRANT ${privilege} ON camery_ingest.${table} TO ${role}`);
      }
      for (const [table, privilege] of [['documents','DELETE'],['reading_checkpoints','TRUNCATE'],['scripts','UPDATE'],['migrations','SELECT'],['scripts','UPDATE(title)'],['documents','REFERENCES(snapshot)']]) {
        await admin.query(`GRANT ${privilege} ON camery_ingest.${table} TO ${role}`);
        await expect(verifyIngestRuntimeRole(runtime)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
        await admin.query(`REVOKE ${privilege} ON camery_ingest.${table} FROM ${role}`);
      }
      await admin.query(`GRANT CREATE ON SCHEMA camery_ingest TO ${role}`);
      await expect(verifyIngestRuntimeRole(runtime)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
      await admin.query(`REVOKE CREATE ON SCHEMA camery_ingest FROM ${role}`);
      await verifyIngestRuntimeRole(runtime);
    } finally {
      await runtime?.end();
      if (created) { await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA camery_ingest FROM ${role}`); await admin.query(`REVOKE ALL ON SCHEMA camery_ingest FROM ${role}`); await admin.query(`DROP ROLE ${role}`); }
      await admin.end();
    }
  });
});

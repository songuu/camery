import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresScriptStore } from '../src/node/scripts.js';
import { PostgresDocumentStore } from '../src/node/store.js';
import { migrateIngest } from '../src/node/migrate.js';
const url = process.env['CAMERY_TEST_DATABASE_URL'];
if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for script storage tests');
describe('durable script sources and catalog', () => {
  const pool = new Pool({ connectionString: url }); const store = new PostgresScriptStore(pool); const tenants: string[] = [];
  let scope: { tenantId: string; projectId: string; documentId: string };
  const command = () => ({ ...scope, title: '原始剧本.fountain', format: 'fountain', bytes: Buffer.from('.办公室\n\n@小林\n你好。\n') });
  beforeAll(async () => { await migrateIngest(pool); });
  beforeEach(() => { scope = { tenantId: `script-${randomUUID()}`, projectId: 'project', documentId: 'source' }; tenants.push(scope.tenantId); });
  afterAll(async () => {
    await pool.query('DELETE FROM camery_ingest.scripts WHERE tenant_id=ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM camery_ingest.documents WHERE tenant_id=ANY($1::text[])', [tenants]); await pool.end();
  });
  it('stores original bytes and structured text exactly once under concurrent retries', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => store.import(command())));
    expect(results.filter(result => !result.duplicate)).toHaveLength(1);
    const row = await pool.query('SELECT original FROM camery_ingest.scripts WHERE tenant_id=$1', [scope.tenantId]);
    expect(row.rows[0].original).toEqual(command().bytes);
    const freshPool = new Pool({ connectionString: url });
    try { expect((await new PostgresScriptStore(freshPool).read(scope)).document).toEqual(results[0]!.document); }
    finally { await freshPool.end(); }
    await expect(store.import({ ...command(), bytes: Buffer.from('changed') })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(store.import({ ...command(), title: 'different' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('isolates all identities and captures bytes before waiting', async () => {
    const input = command(); const pending = store.import(input); input.bytes.fill(0); input.tenantId = 'other';
    const imported = await pending; expect(imported.document.text).toContain('小林');
    for (const key of ['tenantId','projectId','documentId']) await expect(store.read({ ...scope, [key]: 'absent' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const catalog = await store.list({ tenantId: 'other', projectId: scope.projectId }); expect(catalog.items).toEqual([]);
  });
  it('lists novel and script metadata with bounded stable pagination and immutable titles', async () => {
    await store.import(command());
    await new PostgresDocumentStore(pool).append({ ...scope, title: '小说.txt', text: '第一章 原文', batchId: 'first', expectedRevision: 0 });
    for (let i = 0; i < 50; i++) await store.import({ ...command(), documentId: `script-${String(i).padStart(2,'0')}` });
    const first = await store.list({ tenantId: scope.tenantId, projectId: scope.projectId });
    expect(first.items).toHaveLength(50); expect(first.items[0]).toMatchObject({ kind: 'novel', title: '小说.txt' }); expect(first.nextCursor).not.toBeNull();
    const next = await store.list({ tenantId: scope.tenantId, projectId: scope.projectId, cursor: first.nextCursor });
    expect(next.items).toHaveLength(2); expect(next.nextCursor).toBeNull();
    expect(new Set([...first.items,...next.items].map(item => `${item.kind}:${item.documentId}`)).size).toBe(52);
    expect(JSON.stringify(first)).not.toContain('小林');
  });
});

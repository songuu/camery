import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresDocumentStore } from '../src/node/store.js';
import { migrateIngest } from '../src/node/migrate.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for ingest integration tests');

describe('persistent novel import and reading checkpoints', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const store = new PostgresDocumentStore(pool);
  const tenants: string[] = [];
  let scope: { tenantId: string; projectId: string; documentId: string };
  const append = (text = '前言\r\n第一章 黎明\r\n甲😀\n', batchId = 'batch-1', expectedRevision = 0) => store.append({ ...scope, batchId, text, expectedRevision });
  beforeAll(async () => { await Promise.all([migrateIngest(pool), migrateIngest(pool)]); });
  beforeEach(() => { scope = { tenantId: `ingest-${randomUUID()}`, projectId: 'project', documentId: 'novel' }; tenants.push(scope.tenantId); });
  afterAll(async () => {
    await pool.query('DELETE FROM camery_ingest.reading_checkpoints WHERE tenant_id=ANY($1::text[])', [tenants]);
    await pool.query('DELETE FROM camery_ingest.documents WHERE tenant_id=ANY($1::text[])', [tenants]);
    await pool.end();
  });
  it('appends once despite concurrent retries and loads through a new connection', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => append()));
    expect(results.filter(result => !result.duplicate)).toHaveLength(1);
    const freshPool = new Pool({ connectionString: databaseUrl });
    try {
      const read = await new PostgresDocumentStore(freshPool).read({ ...scope, readerId: 'reader' });
      expect(read.snapshot.revision).toBe(1); expect(read.checkpoint).toBeNull();
      expect(read.document.text).toBe(results[0]!.document.text);
    } finally { await freshPool.end(); }
  });
  it('rejects concurrent stale writers without corrupting the winning source', async () => {
    await append();
    const results = await Promise.allSettled([append('第二章 续篇\n乙', 'batch-2', 1), append('第三章 冲突\n丙', 'batch-3', 1)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected');
    expect(failure).toMatchObject({ reason: { code: 'CONFLICT' } });
    const read = await store.read({ ...scope, readerId: 'reader' });
    expect(read.snapshot.batches).toHaveLength(2); expect(read.snapshot.revision).toBe(2);
    await expect(append('changed')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.read({ ...scope, readerId: 'reader' })).document.text).toBe(read.document.text);
  });
  it('keeps tenant, project, document and reader scopes independent', async () => {
    const initial = await append();
    await store.checkpoint({ ...scope, readerId: 'reader', offset: 2, expectedVersion: 0, sourceDigest: initial.document.sourceDigest });
    expect((await store.read({ ...scope, readerId: 'other' })).checkpoint).toBeNull();
    for (const field of ['tenantId', 'projectId', 'documentId'] as const) {
      await expect(store.read({ ...scope, [field]: 'absent', readerId: 'reader' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(store.checkpoint({ ...scope, [field]: 'absent', readerId: 'reader', offset: 0, expectedVersion: 0, sourceDigest: initial.document.sourceDigest })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const other = await store.append({ ...scope, documentId: 'other', text: '不同原文', batchId: 'batch-1', expectedRevision: 0 });
    expect(other.snapshot.revision).toBe(1);
  });
  it('retains a reader prefix after later batches and serializes checkpoint updates', async () => {
    const initial = await append();
    const command = { ...scope, readerId: 'reader', offset: 2, expectedVersion: 0, sourceDigest: initial.document.sourceDigest };
    const marks = await Promise.all([store.checkpoint(command), store.checkpoint(command)]);
    expect(marks[0]).toEqual(marks[1]);
    const updated = await append('第二章 下篇\n乙', 'batch-2', 1);
    expect((await store.read({ ...scope, readerId: 'reader' })).checkpoint?.offset).toBe(2);
    await expect(store.checkpoint({ ...command, offset: 4, expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    const mark = await store.checkpoint({ ...command, offset: 4, expectedVersion: 1, sourceDigest: updated.document.sourceDigest });
    expect(mark.version).toBe(2);
  });
  it('captures command values before the first asynchronous boundary', async () => {
    const command = { ...scope, text: '原始文本', batchId: 'batch-1', expectedRevision: 0 };
    const pending = store.append(command); command.text = '被替换'; command.tenantId = 'other';
    const result = await pending; expect(result.document.text).toBe('原始文本'); expect(result.snapshot.tenantId).toBe(scope.tenantId);
    const progress = { ...scope, readerId: 'reader', sourceDigest: result.document.sourceDigest, offset: 2, expectedVersion: 0 };
    const saving = store.checkpoint(progress); progress.readerId = 'other'; progress.offset = 0;
    expect(await saving).toMatchObject({ readerId: 'reader', offset: 2 });
  });
  it('survives a real child-process SIGKILL after committing a reading checkpoint', async () => {
    const initial = await append();
    const input = { ...scope, readerId: 'child-reader', sourceDigest: initial.document.sourceDigest, offset: 3, expectedVersion: 0 };
    const program = `import {Pool} from 'pg';import {PostgresDocumentStore} from './src/node/store.ts';const pool=new Pool({connectionString:process.env.CAMERY_TEST_DATABASE_URL});await new PostgresDocumentStore(pool).checkpoint(JSON.parse(process.env.CAMERY_IMPORT_TEST_COMMAND));process.kill(process.pid,'SIGKILL');`;
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', program], { cwd: new URL('../', import.meta.url), env: { ...process.env, CAMERY_IMPORT_TEST_COMMAND: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', part => { stderr += String(part); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
    expect(stderr).toBe(''); expect(result.signal === 'SIGKILL' || result.code !== 0).toBe(true);
    const freshPool = new Pool({ connectionString: databaseUrl });
    try { expect((await new PostgresDocumentStore(freshPool).read({ ...scope, readerId: 'child-reader' })).checkpoint).toMatchObject({ offset: 3, version: 1 }); }
    finally { await freshPool.end(); }
  });
  it('rolls back a rejected append and leaves existing source unchanged', async () => {
    const initial = await append();
    await expect(append('replacement', 'batch-1', 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.read({ ...scope, readerId: 'reader' })).snapshot).toEqual(initial.snapshot);
  });
  it('imports an original ten-chapter source across heading, newline and Unicode boundaries', async () => {
    const text = '\uFEFF前言\r\n' + Array.from({ length: 10 }, (_, index) => `第${index + 1}章 测试章节\r\n原创正文${index + 1}😀。\r\n`).join('');
    const characters = Array.from(text);
    let revision = 0;
    for (let start = 0; start < characters.length; start += 7) {
      const chunk = characters.slice(start, start + 7).join('');
      const command = { ...scope, text: chunk, batchId: `batch-${revision}`, expectedRevision: revision };
      const result = await store.append(command); revision++;
      expect((await store.append(command)).snapshot.revision).toBe(revision);
      expect(result.document.text).toBe(characters.slice(0, start + 7).join(''));
    }
    const imported = await store.read({ ...scope, readerId: 'reader' });
    expect(imported.document.units.filter(unit => unit.kind === 'chapter')).toHaveLength(10);
    expect(imported.document.units.map(unit => text.slice(unit.start, unit.end)).join('')).toBe(text);
    await store.checkpoint({ ...scope, readerId: 'reader', offset: text.length, expectedVersion: 0, sourceDigest: imported.document.sourceDigest });
    expect((await new PostgresDocumentStore(pool).read({ ...scope, readerId: 'reader' })).checkpoint?.offset).toBe(text.length);
  });
});

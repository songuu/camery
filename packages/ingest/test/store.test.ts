import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresDocumentStore } from '../src/node/store.js';
import { migrateIngest } from '../src/node/migrate.js';
import { appendNovelBatch, advanceReading } from '../src/session.js';
import { textDigest } from '../src/data.js';
import { readFileSync } from 'node:fs';

const scope = { tenantId: 'tenant', projectId: 'project', documentId: 'novel' };
const command = { ...scope, text: '第一章 开始\n内容😀', batchId: 'first', expectedRevision: 0 };
const initial = appendNovelBatch(undefined, command);
type Options = { snapshot?: unknown; checkpoint?: unknown; revision?: string; migrations?: unknown[]; fail?: string[]; connectFailure?: boolean };
function mockDatabase(options: Options = {}) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => {
    if (options.fail?.some(part => sql.startsWith(part))) throw new Error('sensitive driver details');
    if (sql.startsWith('SELECT snapshot')) return { rows: options.snapshot === undefined ? [] : [{ snapshot: options.snapshot, revision: options.revision ?? '1' }] };
    if (sql.startsWith('SELECT checkpoint')) return { rows: options.checkpoint === undefined ? [] : [{ checkpoint: options.checkpoint }] };
    if (sql.startsWith('SELECT version')) return { rows: options.migrations ?? [] };
    return { rows: [] };
  });
  const client = { query, release };
  const connect = vi.fn(async () => { if (options.connectFailure) throw new Error('credential'); return client; });
  const pool = { connect } as unknown as Pool;
  return { pool, query, release, connect, store: new PostgresDocumentStore(pool) };
}
describe('storage failure boundaries', () => {
  it('captures immutable inputs before connect and makes duplicate append a read-only transaction', async () => {
    const database = mockDatabase({ snapshot: initial.snapshot });
    expect((await database.store.append(command)).duplicate).toBe(true);
    expect(database.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    expect(database.release).toHaveBeenCalledOnce();
  });
  it('rejects malformed commands before opening a database connection', async () => {
    const database = mockDatabase();
    for (const call of [() => database.store.append(null), () => database.store.checkpoint({}), () => database.store.read({ ...scope, readerId: '../unsafe' })])
      await expect(call()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(database.connect).not.toHaveBeenCalled();
  });
  it.each(['BEGIN', 'SELECT pg_advisory', 'SELECT snapshot', 'INSERT', 'COMMIT'])('redacts %s failures, rolls back and releases', async fail => {
    const database = mockDatabase({ fail: [fail] });
    await expect(database.store.append(command)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(database.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(database.release).toHaveBeenCalledOnce();
  });
  it('redacts connection and rollback failures', async () => {
    await expect(mockDatabase({ connectFailure: true }).store.append(command)).rejects.toThrow('Import connection failed (STORAGE_FAILED)');
    const database = mockDatabase({ fail: ['INSERT', 'ROLLBACK'] });
    await expect(database.store.append(command)).rejects.toThrow('Import rollback failed (STORAGE_FAILED)');
    expect(database.release).toHaveBeenCalledOnce();
  });
  it.each([
    { snapshot: {} }, { snapshot: { ...initial.snapshot, text: 'tampered' } },
    { snapshot: { ...initial.snapshot, tenantId: 'other' } }, { snapshot: { ...initial.snapshot, projectId: 'other' } },
    { snapshot: { ...initial.snapshot, documentId: 'other' } }, { snapshot: initial.snapshot, revision: '2' },
  ])('does not return corrupted or scope-mismatched stored state', async options => {
    await expect(mockDatabase(options).store.read({ ...scope, readerId: 'reader' })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
  it('reads exact source with or without a saved checkpoint', async () => {
    const progress = { ...scope, readerId: 'reader', sourceDigest: initial.document.sourceDigest, offset: 3, expectedVersion: 0 };
    const checkpoint = advanceReading(initial.snapshot, undefined, progress);
    const database = mockDatabase({ snapshot: initial.snapshot, checkpoint });
    expect((await database.store.read({ ...scope, readerId: 'reader' })).checkpoint).toEqual(checkpoint);
    expect((await database.store.checkpoint(progress)).version).toBe(1);
    expect((await mockDatabase({ snapshot: initial.snapshot }).store.read({ ...scope, readerId: 'reader' })).checkpoint).toBeNull();
    await expect(mockDatabase({ snapshot: initial.snapshot, checkpoint: { ...checkpoint, readerId: 'other' } }).store.read({ ...scope, readerId: 'reader' })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
  it('distinguishes not-found documents from invalid client state', async () => {
    const database = mockDatabase();
    await expect(database.store.read({ ...scope, readerId: 'reader' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(database.store.checkpoint({ ...scope, readerId: 'reader', offset: 0, expectedVersion: 0, sourceDigest: initial.document.sourceDigest })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('classifies corrupt persisted checkpoints as storage failure, not client input', async () => {
    for (const checkpoint of [{}, { ...scope, readerId: 'reader', version: 1, offset: 2, prefixDigest: '0'.repeat(64) }])
      await expect(mockDatabase({ snapshot: initial.snapshot, checkpoint }).store.read({ ...scope, readerId: 'reader' })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    await expect(mockDatabase({ snapshot: initial.snapshot, checkpoint: {} }).store.checkpoint({ ...scope, readerId: 'reader', offset: 0, expectedVersion: 0, sourceDigest: initial.document.sourceDigest })).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  });
});

describe('explicit installation migration', () => {
  it('applies once and accepts only the identical installed checksum', async () => {
    const fresh = mockDatabase(); await migrateIngest(fresh.pool); expect(fresh.release).toHaveBeenCalledOnce();
    const checksum = textDigest(readFileSync(new URL('../src/node/migrations/0001-imports.sql', import.meta.url)));
    const existing = mockDatabase({ migrations: [{ version: 1, checksum }] }); await migrateIngest(existing.pool);
    expect(existing.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO camery_ingest.migrations'))).toBe(false);
  });
  it.each([[{ version: 1, checksum: 'changed' }], [{ version: 2, checksum: 'changed' }], [{ version: 1 }, { version: 2 }]])('refuses changed migration history', async (...rows) => {
    await expect(migrateIngest(mockDatabase({ migrations: rows }).pool)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it.each(['BEGIN', 'SELECT pg_advisory', 'CREATE SCHEMA', 'SELECT version', 'CREATE TABLE camery_ingest.documents', 'COMMIT'])('redacts migration %s failures', async fail => {
    const database = mockDatabase({ fail: [fail] });
    await expect(migrateIngest(database.pool)).rejects.toMatchObject({ code: 'STORAGE_FAILED' }); expect(database.release).toHaveBeenCalledOnce();
  });
  it('redacts migration connection and rollback errors', async () => {
    await expect(migrateIngest(mockDatabase({ connectFailure: true }).pool)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const database = mockDatabase({ fail: ['BEGIN', 'ROLLBACK'] });
    await expect(migrateIngest(database.pool)).rejects.toThrow('Import migration rollback failed (STORAGE_FAILED)'); expect(database.release).toHaveBeenCalledOnce();
  });
});

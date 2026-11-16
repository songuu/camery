import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresScriptStore } from '../src/node/scripts.js';
import { importFountain } from '../src/screenplay.js';
import { textDigest } from '../src/data.js';
import { docx } from './fixtures/docx.js';

const scope = { tenantId: 'tenant', projectId: 'project', documentId: 'script' };
const source = '.办公室\n\n@小林\n原始正文\n';
const command = () => ({ ...scope, title: '原始剧本', format: 'fountain', bytes: Buffer.from(source) });
function row() {
  const original = Buffer.from(source);
  return { format: 'fountain', title: '原始剧本', original, original_digest: textDigest(original), document: importFountain(source) };
}
interface Options { existing?: unknown; rows?: unknown[]; fail?: string[]; connectFailure?: boolean; catalogFailure?: boolean }
function database(options: Options = {}) {
  const release = vi.fn();
  const query = vi.fn(async (sql: string, _parameters?: readonly unknown[]) => {
    if (options.fail?.some(prefix => sql.startsWith(prefix))) throw new Error('postgresql://private:secret@host/database');
    return { rows: sql.startsWith('SELECT format') && options.existing !== undefined ? [options.existing] : [] };
  });
  const connect = vi.fn(async () => { if (options.connectFailure) throw new Error('credential material'); return { query, release }; });
  const catalogQuery = vi.fn(async (_sql: string, _parameters?: readonly unknown[]) => {
    if (options.catalogFailure) throw new Error('postgresql://private:secret@host/database'); return { rows: options.rows ?? [] };
  });
  const pool = { connect, query: catalogQuery } as unknown as Pool;
  return { store: new PostgresScriptStore(pool), query, connect, release, catalogQuery };
}

describe('script source storage boundary', () => {
  it.each([
    ['fountain', '\uFEFF.办公室\n\n@小林\n你好😀\n'],
    ['csv', '\uFEFF"角色","对白"\r\n"小林","你好😀"\r\n'],
    ['tsv', '\uFEFF角色\t对白\r\n小林\t你好😀\r\n'],
  ])('stores and validates real %s parser output with exact BOM/source bytes', async (format, text) => {
    const db = database(); const bytes = Buffer.from(text);
    const result = await db.store.import({ ...command(), format, bytes });
    expect(result.duplicate).toBe(false);
    expect(result.summary).toEqual({ documentId: scope.documentId, title: '原始剧本', kind: 'script', format, revision: 1 });
    expect(result.document.text).toBe(text); expect(result.document.originalDigest).toBe(textDigest(bytes));
    const inserted = db.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))?.[1];
    expect(inserted?.slice(0, 5)).toEqual([scope.tenantId, scope.projectId, scope.documentId, format, '原始剧本']);
    expect(inserted?.[5]).toEqual(bytes); expect(inserted?.[6]).toBe(textDigest(bytes));
    expect(JSON.parse(String(inserted?.[7]))).toEqual(result.document);
    expect(result).not.toHaveProperty('original'); expect(db.release).toHaveBeenCalledOnce();
  });

  it('extracts a real original DOCX ZIP and retains its separate raw-byte digest', async () => {
    const bytes = docx('<w:p><w:pPr><w:pStyle w:val="SceneHeading"/></w:pPr><w:r><w:t>内景 办公室😀</w:t></w:r></w:p>');
    const db = database(); const result = await db.store.import({ ...command(), format: 'docx', bytes });
    expect(result.document.format).toBe('docx'); expect(result.document.units[0]?.kind).toBe('scene');
    expect(result.document.text).toBe('内景 办公室😀\n'); expect(result.document.originalDigest).toBe(textDigest(bytes));
    expect(result.document.sourceDigest).not.toBe(result.document.originalDigest);
    const inserted = db.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))?.[1]; expect(inserted?.[5]).toEqual(Buffer.from(bytes));
    const persisted = database({ existing: { format: 'docx', title: '原始剧本', original: Buffer.from(bytes), original_digest: textDigest(bytes), document: result.document } });
    expect((await persisted.store.read(scope)).document).toEqual(result.document);
    expect((await persisted.store.import({ ...command(), format: 'docx', bytes })).duplicate).toBe(true);
  });

  it('captures all scalar fields and bytes before the first asynchronous boundary', async () => {
    const input = command(); const db = database(); const pending = db.store.import(input);
    input.bytes.fill(0); input.title = 'changed'; input.tenantId = 'other'; input.format = 'csv';
    const result = await pending; expect(result.document.text).toBe(source); expect(result.summary.format).toBe('fountain'); expect(result.summary.title).toBe('原始剧本');
    expect(db.query.mock.calls.find(([sql]) => sql.startsWith('INSERT'))?.[1]?.slice(0, 3)).toEqual([scope.tenantId, scope.projectId, scope.documentId]);
  });

  it('returns a verified duplicate without re-inserting and keeps nested stored data detached', async () => {
    const existing = row(); const db = database({ existing }); const imported = await db.store.import(command());
    expect(imported.duplicate).toBe(true); expect(imported.document).toEqual(existing.document);
    expect(Object.isFrozen(imported.document.units)).toBe(true); expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
    expect(await db.store.read(scope)).toEqual({ summary: imported.summary, document: imported.document });
  });

  it.each([{ bytes: Buffer.from('different') }, { format: 'csv' }, { title: 'another title' }])('refuses same identity with incompatible content or metadata', async patch => {
    const db = database({ existing: row() });
    await expect(db.store.import({ ...command(), ...patch })).rejects.toMatchObject({ code: 'CONFLICT', operation: 'script identity' });
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false); expect(db.release).toHaveBeenCalledOnce();
  });

  it('rejects invalid UTF-8 rather than replacing undecodable source bytes', async () => {
    const db = database(); await expect(db.store.import({ ...command(), bytes: Uint8Array.of(0xc3, 0x28) })).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT', operation: 'script encoding' });
    expect(db.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true); expect(db.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
  });

  it.each([null, {}, { ...command(), extra: true }, { ...command(), format: 'novel' }, { ...command(), bytes: 'not bytes' }, { ...command(), bytes: new Uint8Array() },
    { ...command(), title: '' }, { ...command(), title: '   ' }, { ...command(), title: 'x'.repeat(201) }, { ...command(), title: 'line\nbreak' },
    { ...command(), title: '\0' }, { ...command(), title: '\ud800' }, { ...command(), documentId: 'id\n' }, { ...command(), tenantId: '../tenant' },
  ])('rejects malformed import commands before connecting', async input => {
    const db = database(); await expect(db.store.import(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(db.connect).not.toHaveBeenCalled();
  });

  it('rejects oversized binary imports before a database connection is opened', async () => {
    const db = database(); await expect(db.store.import({ ...command(), bytes: new Uint8Array(8_000_001) })).rejects.toMatchObject({ code: 'INPUT_LIMIT' }); expect(db.connect).not.toHaveBeenCalled();
  });

  it('treats invalid stored format, title, original bytes or document state as storage failures', async () => {
    const base = row();
    for (const patch of [{ format: 'novel' }, { title: ' ' }, { title: 'x'.repeat(201) }, { original: null }, { original: new Uint8Array() },
      { original: new Uint8Array(8_000_001) }, { original_digest: '0'.repeat(64) }, { document: {} },
      { document: { ...base.document, format: 'csv' } }, { document: { ...base.document, originalDigest: '0'.repeat(64) } },
      { document: { ...base.document, sourceDigest: '0'.repeat(64) } },
    ]) await expect(database({ existing: { ...base, ...patch } }).store.read(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED', operation: 'stored script' });
  });

  it('refuses coherent but changed text projections that no longer match original UTF-8 bytes', async () => {
    const stored = row(); const text = stored.document.text.replace('原始正文', '篡改正文');
    const tampered = { ...stored, document: { ...stored.document, text, sourceDigest: textDigest(text) } };
    await expect(database({ existing: tampered }).store.read(scope)).rejects.toMatchObject({ code: 'STORAGE_FAILED', operation: 'stored script' });
  });

  it('rejects malformed reads and missing scripts without leaking another scope', async () => {
    const db = database(); await expect(db.store.read({ ...scope, readerId: 'unexpected' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(db.connect).not.toHaveBeenCalled(); await expect(db.store.read(scope)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each(['BEGIN', 'SELECT pg_advisory', 'SELECT format', 'INSERT', 'COMMIT'])('redacts %s driver failures and releases the transaction', async fail => {
    const db = database({ fail: [fail] }); const error = await db.store.import(command()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'STORAGE_FAILED' }); expect(String(error)).not.toContain('secret');
    expect(db.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true); expect(db.release).toHaveBeenCalledOnce();
  });

  it('redacts connection/rollback failures and releases a connected client once', async () => {
    await expect(database({ connectFailure: true }).store.import(command())).rejects.toThrow('Import connection failed (STORAGE_FAILED)');
    const db = database({ fail: ['INSERT', 'ROLLBACK'] }); await expect(db.store.import(command())).rejects.toThrow('Import rollback failed (STORAGE_FAILED)'); expect(db.release).toHaveBeenCalledOnce();
  });
});

describe('project source catalog boundary', () => {
  const project = { tenantId: scope.tenantId, projectId: scope.projectId };
  const listingRow = (index = 0) => ({ document_id: `source-${String(index).padStart(3, '0')}`, title: '原始剧本', kind: 'script', format: 'fountain', revision: 1 });
  it('returns an immutable bounded metadata page and retains colon-containing document IDs in cursors', async () => {
    const db = database({ rows: Array.from({ length: 51 }, (_, index) => listingRow(index)) });
    const page = await db.store.list({ ...project, cursor: 'novel:source:part-1' });
    expect(page.items).toHaveLength(50); expect(page.nextCursor).toBe('script:source-049'); expect(Object.isFrozen(page.items)).toBe(true);
    expect(db.catalogQuery.mock.calls[0]?.[1]).toEqual([scope.tenantId, scope.projectId, 'novel', 'source:part-1']);
    expect(page.items[0]).not.toHaveProperty('text'); expect(page.items[0]).not.toHaveProperty('original');
    expect(await database().store.list(project)).toEqual({ items: [], nextCursor: null });
  });
  it('accepts novel summaries at the final supported batch revision without exposing source text', async () => {
    const db = database({ rows: [{ document_id: 'novel:part-1', title: '分批小说', kind: 'novel', format: 'novel', revision: 1024 }] });
    expect(await db.store.list(project)).toEqual({ items: [{ documentId: 'novel:part-1', title: '分批小说', kind: 'novel', format: 'novel', revision: 1024 }], nextCursor: null });
  });

  it.each([null, {}, { ...project, extra: true }, { ...project, tenantId: 'tenant\n' }, { ...project, cursor: '' }, { ...project, cursor: 'novel' },
    { ...project, cursor: 'unknown:id' }, { ...project, cursor: 'novel:' }, { ...project, cursor: 'novelX' }, { ...project, cursor: 'scriptX' }, { ...project, cursor: 'script:../id' }, { ...project, cursor: 'novel:id\n' },
    { ...project, cursor: 'x'.repeat(137) }, { ...project, cursor: 1 },
  ])('rejects invalid cursor/scope input without querying', async input => {
    const db = database(); await expect(db.store.list(input)).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(db.catalogQuery).not.toHaveBeenCalled();
  });

  it('rejects corrupt catalog rows or query failures with a safe storage error', async () => {
    const base = listingRow();
    for (const patch of [{ document_id: 'bad\n' }, { title: null }, { kind: 'unknown' }, { format: 'doc' }, { format: 'novel' }, { revision: 0 }, { revision: 1025 }])
      await expect(database({ rows: [{ ...base, ...patch }] }).store.list(project)).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    const error = await database({ catalogFailure: true }).store.list(project).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'STORAGE_FAILED', operation: 'catalog' }); expect(String(error)).not.toContain('secret');
  });
});

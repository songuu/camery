import { describe, expect, it } from 'vitest';
import { appendNovelBatch, advanceReading, validateNovelSnapshot } from '../src/session.js';
import { textDigest } from '../src/data.js';

const scope = { tenantId: 'tenant', projectId: 'project', documentId: 'novel' };
const batch = (text = '第一章 开端\r\n你好😀', batchId = 'batch-1', expectedRevision = 0) => ({ ...scope, batchId, text, expectedRevision });
describe('novel append and reading state', () => {
  it('appends exact text and binds retry identity without duplicate changes', () => {
    const first = appendNovelBatch(undefined, batch());
    expect(first.snapshot.revision).toBe(1); expect(first.duplicate).toBe(false);
    expect(appendNovelBatch(first.snapshot, batch())).toEqual({ ...first, duplicate: true });
    const second = appendNovelBatch(first.snapshot, batch('\r\n第二章 尾声\n完', 'batch-2', 1));
    expect(second.document.text).toBe(first.document.text + '\r\n第二章 尾声\n完');
    expect(second.document.units.map(unit => second.document.text.slice(unit.start, unit.end)).join('')).toBe(second.document.text);
    expect(appendNovelBatch(second.snapshot, batch()).snapshot).toEqual(second.snapshot);
    expect(Object.isFrozen(second.snapshot.batches)).toBe(true);
  });
  it('reassembles split headings exactly as a whole import', () => {
    let state = appendNovelBatch(undefined, batch('前言\r\n第'));
    state = appendNovelBatch(state.snapshot, batch('一章 名称\r', 'batch-2', 1));
    state = appendNovelBatch(state.snapshot, batch('\n内容\n第二章 后续', 'batch-3', 2));
    expect(state.document.units.map(unit => unit.title)).toEqual(['', '第一章 名称', '第二章 后续']);
  });
  it('rejects reused batch IDs with other content and stale writers', () => {
    const state = appendNovelBatch(undefined, batch()).snapshot;
    expect(() => appendNovelBatch(state, batch('别的内容'))).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => appendNovelBatch(state, batch('续写', 'batch-2'))).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => appendNovelBatch(state, { ...batch(), tenantId: 'other' })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });
  it('persists reading progress with prefix identity, strict monotonicity and idempotent retries', () => {
    const { snapshot, document } = appendNovelBatch(undefined, batch());
    const command = { ...scope, readerId: 'reader', sourceDigest: document.sourceDigest, offset: 3, expectedVersion: 0 };
    const mark = advanceReading(snapshot, undefined, command);
    expect(mark).toMatchObject({ offset: 3, version: 1, prefixDigest: textDigest(document.text.slice(0, 3)) });
    expect(advanceReading(snapshot, mark, command)).toEqual(mark);
    const next = advanceReading(snapshot, mark, { ...command, offset: document.text.length, expectedVersion: 1 });
    expect(next.version).toBe(2);
    expect(() => advanceReading(snapshot, next, { ...command, offset: 2, expectedVersion: 2 })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => advanceReading(snapshot, mark, { ...command, offset: 4 })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });
  it('rejects invalid Unicode boundaries, offsets, source versions and reader identity', () => {
    const { snapshot, document } = appendNovelBatch(undefined, batch());
    const command = { ...scope, readerId: 'reader', sourceDigest: document.sourceDigest, offset: 0, expectedVersion: 0 };
    for (const offset of [-1, 0.1, NaN, Infinity, document.text.length + 1, document.text.length - 1])
      expect(() => advanceReading(snapshot, undefined, { ...command, offset })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => advanceReading(snapshot, undefined, { ...command, sourceDigest: '0'.repeat(64) })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
    const mark = advanceReading(snapshot, undefined, command);
    expect(() => advanceReading(snapshot, mark, { ...command, readerId: 'other' })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
  });
  it('detects corrupted snapshots and malformed batch inputs', () => {
    const state = appendNovelBatch(undefined, batch()).snapshot;
    expect(validateNovelSnapshot(JSON.parse(JSON.stringify(state)))).toEqual(state);
    for (const invalid of [null, {}, { ...state, revision: 2 }, { ...state, text: 'changed' }, { ...state, batches: [] }, { ...state, extra: true }])
      expect(() => validateNovelSnapshot(invalid)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    for (const invalid of [{}, { ...batch(), extra: 1 }, batch(''), batch('\0'), batch('\ud800'), batch('x'.repeat(1_000_001)), { ...batch(), batchId: '../unsafe' }, { ...batch(), expectedRevision: -1 }])
      expect(() => appendNovelBatch(undefined, invalid)).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { appendNovelBatch, documentScope } from '../src/session.js';
const scope = { tenantId: 'tenant', projectId: 'project', documentId: 'novel' };
const batch = { ...scope, batchId: 'batch', text: '第一章 标题\n内容', expectedRevision: 0 };
describe('source identity and title', () => {
  it('keeps an immutable display title across batches and retries', () => {
    const first = appendNovelBatch(undefined, { ...batch, title: '雾港来信.txt' });
    expect(first.snapshot.title).toBe('雾港来信.txt');
    expect(appendNovelBatch(first.snapshot, { ...batch, title: '雾港来信.txt' }).duplicate).toBe(true);
    expect(appendNovelBatch(first.snapshot, { ...batch, batchId: 'next', expectedRevision: 1 }).snapshot.title).toBe('雾港来信.txt');
    expect(() => appendNovelBatch(first.snapshot, { ...batch, title: '改名' })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });
  it('rejects trailing newlines in every source identity', () => {
    for (const key of ['tenantId', 'projectId', 'documentId']) expect(() => documentScope({ ...scope, [key]: 'id\n' })).toThrow();
    expect(() => appendNovelBatch(undefined, { ...batch, batchId: 'batch\n' })).toThrow();
  });
  it.each(['', ' ', '\0', '\ud800', 'title\nline', 'x'.repeat(201)])('rejects malformed source title %j', title => {
    expect(() => appendNovelBatch(undefined, { ...batch, title })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AppendReceipt } from '@camery/ingest/contracts';
import type { UploadFormat } from '../src/view-types.js';
import { appendPreparedNovel, prepareSourceFile, splitNovelText, UploadError } from '../src/uploads.js';
import type { PreparedSource } from '../src/uploads.js';

function file(bytes: Uint8Array, name = '原文.txt', size = bytes.length) {
  return { name, size, arrayBuffer: vi.fn(async () => Uint8Array.from(bytes).buffer) };
}
const encode = (text: string) => new TextEncoder().encode(text);
const prepared = (text = '原文'): PreparedSource => ({ title: '原文.txt', format: 'novel', bytes: encode(text), digest: 'a'.repeat(64), novelText: text });
function receipt(revision: number, batchRevision = revision, duplicate = false, documentId = 'document'): AppendReceipt {
  return { documentId, title: '原文.txt', kind: 'novel', format: 'novel', revision, batchRevision, duplicate, sourceDigest: 'b'.repeat(64) };
}

describe('source file preparation', () => {
  it('retains UTF-8 BOM, CRLF and emoji and hashes original file bytes using WebCrypto', async () => {
    const text = '\uFEFF第一章 开始\r\n你好😀'; const bytes = encode(text); const original = bytes.slice();
    const result = await prepareSourceFile(file(bytes), 'novel');
    expect(result.novelText).toBe(text); expect(result.bytes).toEqual(bytes); expect(bytes).toEqual(original);
    expect(result.digest).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.title).toBe('原文.txt'); expect(Object.isFrozen(result)).toBe(true);
  });
  it('validates UTF-8 text script formats without treating the bytes as a novel', async () => {
    for (const format of ['fountain', 'csv', 'tsv'] as const) {
      const result = await prepareSourceFile(file(encode('中文,abc\r\n')), format);
      expect(result.novelText).toBeNull(); expect(result.format).toBe(format);
    }
  });
  it('keeps binary DOCX bytes unchanged instead of applying text decoding or NUL rejection', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0, 0xff]);
    const result = await prepareSourceFile(file(bytes, '稿.docx'), 'docx');
    expect(result.bytes).toEqual(bytes); expect(result.novelText).toBeNull();
  });
  it.each(['', '   ', 'x'.repeat(201), '\ud800', 'bad\0name', 'bad\nname'])('rejects an invalid title without reading its bytes', async name => {
    const source = file(encode('abc'), name);
    await expect(prepareSourceFile(source, 'novel')).rejects.toMatchObject({ code: 'INVALID_FILE' });
    expect(source.arrayBuffer).not.toHaveBeenCalled();
  });
  it.each([0, -1, 0.2, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid or oversize metadata before reading %s', async size => {
    const source = file(encode('abc'), '原文.txt', size);
    await expect(prepareSourceFile(source, 'novel')).rejects.toBeInstanceOf(UploadError);
    expect(source.arrayBuffer).not.toHaveBeenCalled();
  });
  it('checks novel and script byte limits separately', async () => {
    await expect(prepareSourceFile(file(new Uint8Array(1), 'big', 64_000_001), 'novel')).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    for (const format of ['docx', 'fountain', 'csv', 'tsv'] as const)
      await expect(prepareSourceFile(file(new Uint8Array(1), 'big', 8_000_001), format)).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    const largeText = encode('x'.repeat(16_000_001));
    await expect(prepareSourceFile(file(largeText), 'novel')).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  });
  it.each([new Uint8Array([0xc3, 0x28]), new Uint8Array([0xed, 0xa0, 0x80])])('rejects malformed UTF-8 instead of replacing bytes', async bytes => {
    await expect(prepareSourceFile(file(bytes), 'novel')).rejects.toMatchObject({ code: 'INVALID_ENCODING' });
  });
  it('rejects NUL and does not lose a BOM-only source', async () => {
    await expect(prepareSourceFile(file(encode('a\0b')), 'csv')).rejects.toMatchObject({ code: 'INVALID_TEXT' });
    expect((await prepareSourceFile(file(encode('\uFEFF')), 'novel')).novelText).toBe('\uFEFF');
  });
  it('rejects unsupported formats, byte-count mismatch and invalid buffers', async () => {
    await expect(prepareSourceFile(file(encode('abc')), 'xlsx' as UploadFormat)).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(prepareSourceFile(file(encode('abc'), 'source', 2), 'novel')).rejects.toMatchObject({ code: 'INVALID_FILE' });
    const source = { name: 'source', size: 1, arrayBuffer: async () => new Uint8Array(1) as unknown as ArrayBuffer };
    await expect(prepareSourceFile(source, 'novel')).rejects.toMatchObject({ code: 'READ_FAILED' });
    await expect(prepareSourceFile(file(new Uint8Array(8_000_001), 'source.docx', 1), 'docx')).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    await expect(prepareSourceFile(null as unknown as File, 'novel')).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(prepareSourceFile({ name: 'a', size: 1 } as File, 'novel')).rejects.toMatchObject({ code: 'INVALID_FILE' });
  });
  it('redacts read and hashing failures', async () => {
    const source = { name: 'private-file', size: 1, arrayBuffer: async () => { throw new Error('private path and contents'); } };
    await expect(prepareSourceFile(source, 'novel')).rejects.toThrow('Upload failed (READ_FAILED)');
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('private hashing failure'));
    try { await expect(prepareSourceFile(file(encode('abc')), 'novel')).rejects.toThrow('Upload failed (HASH_FAILED)'); }
    finally { spy.mockRestore(); }
  });
  it('captures title and copies bytes before the hashing await', async () => {
    const bytes = encode('abc'); const buffer = Uint8Array.from(bytes).buffer;
    const source = { name: 'original.txt', size: bytes.length, arrayBuffer: async () => buffer };
    const pending = prepareSourceFile(source, 'novel'); source.name = 'other.txt';
    const result = await pending; new Uint8Array(buffer).fill(0);
    expect(result.title).toBe('original.txt'); expect(result.bytes).toEqual(bytes);
    expect(result.digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Unicode-safe novel batches', () => {
  it('keeps exact source and never splits a surrogate pair at a batch boundary', () => {
    const text = 'x'.repeat(249_999) + '😀\r\n' + '尾'.repeat(250_000);
    const chunks = splitNovelText(text);
    expect(chunks.join('')).toBe(text); expect(chunks.length).toBe(3);
    expect(chunks.every(chunk => chunk.length <= 250_000 && chunk.isWellFormed())).toBe(true);
    expect(chunks[0]!.length).toBe(249_999); expect(Object.isFrozen(chunks)).toBe(true);
  });
  it.each(['', '\0', '\ud800', 'x'.repeat(16_000_001)])('rejects invalid or over-limit source', text => {
    expect(() => splitNovelText(text)).toThrow(UploadError);
  });
});

describe('idempotent upload orchestration', () => {
  it('sends stable batch IDs, source slices and fixed revision progression', async () => {
    const input = prepared('x'.repeat(250_000) + '😀尾');
    const send = vi.fn(async (command: { expectedRevision: number }) => receipt(command.expectedRevision + 1)); const progress = vi.fn();
    const result = await appendPreparedNovel(input, 2, send, progress, () => true, true);
    expect(result.revision).toBe(4);
    expect(send.mock.calls[0]![0]).toEqual({ batchId: `file-${input.digest}-0`, text: 'x'.repeat(250_000), expectedRevision: 2, title: '原文.txt' });
    expect(send.mock.calls[1]![0]).toEqual({ batchId: `file-${input.digest}-1`, text: '😀尾', expectedRevision: 3 });
    expect(progress.mock.calls.map(([fraction]) => fraction)).toEqual([0, 0.5, 1]);
  });
  it('recovers the original base revision on a repeated first batch without changing the file identity', async () => {
    const input = prepared('x'.repeat(500_001));
    const send = vi.fn().mockResolvedValueOnce(receipt(8, 3, true)).mockResolvedValueOnce(receipt(8, 4, true)).mockResolvedValueOnce(receipt(8, 5, true));
    expect((await appendPreparedNovel(input, 8, send, vi.fn(), () => true, false)).batchRevision).toBe(5);
    expect(send.mock.calls.map(([command]) => command.expectedRevision)).toEqual([8, 3, 4]);
    expect(send.mock.calls.every(([command]) => !Object.hasOwn(command, 'title'))).toBe(true);
  });
  it('refuses an interleaved upload or a new response with an unexpected batch position', async () => {
    const input = prepared('x'.repeat(250_001)); const progress = vi.fn();
    const send = vi.fn().mockResolvedValueOnce(receipt(3, 1, true)).mockResolvedValueOnce(receipt(3, 3, true));
    await expect(appendPreparedNovel(input, 3, send, progress, () => true, false)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(progress.mock.calls.map(([fraction]) => fraction)).toEqual([0, 0.5]);
    await expect(appendPreparedNovel(prepared(), 0, async () => receipt(2), vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it.each([-1, 0.2, NaN, Infinity, Number.MAX_SAFE_INTEGER])('rejects unsafe initial revision %s before sending', async revision => {
    const send = vi.fn();
    await expect(appendPreparedNovel(prepared(), revision, send, vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_REVISION' });
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    { revision: 0 }, { batchRevision: 0 }, { revision: 1.5 }, { batchRevision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 1, batchRevision: 2 }, { duplicate: 'yes' }, { sourceDigest: 'not a digest' },
    { kind: 'script' }, { format: 'docx' }, { documentId: '' },
  ])('rejects malformed or contradictory receipts', async patch => {
    await expect(appendPreparedNovel(prepared(), 0, async () => ({ ...receipt(1), ...patch }) as AppendReceipt, vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });
  it('does not accept a later response from a different document', async () => {
    const send = vi.fn().mockResolvedValueOnce(receipt(1)).mockResolvedValueOnce(receipt(2, 2, false, 'other'));
    await expect(appendPreparedNovel(prepared('x'.repeat(250_001)), 0, send, vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
    const decreasing = vi.fn().mockResolvedValueOnce(receipt(8, 1, true)).mockResolvedValueOnce(receipt(2, 2, true));
    await expect(appendPreparedNovel(prepared('x'.repeat(250_001)), 8, decreasing, vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
  });
  it('rejects missing receipts and unsafe recovered revision spans before another send', async () => {
    await expect(appendPreparedNovel(prepared(), 0, async () => null as unknown as AppendReceipt, vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
    const send = vi.fn(async () => receipt(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true));
    await expect(appendPreparedNovel(prepared('x'.repeat(250_001)), 0, send, vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_RECEIPT' });
    expect(send).toHaveBeenCalledOnce();
  });
  it('rejects corrupted preparation state instead of deriving unstable upload identities', async () => {
    for (const value of [null, { ...prepared(), format: 'docx' }, { ...prepared(), digest: 'bad' }])
      await expect(appendPreparedNovel(value as PreparedSource, 0, vi.fn(), vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_FILE' });
    await expect(appendPreparedNovel({ ...prepared(), novelText: null }, 0, vi.fn(), vi.fn(), () => true, false)).rejects.toMatchObject({ code: 'INVALID_TEXT' });
  });
  it('stops before any send or progress if the session is already inactive', async () => {
    const send = vi.fn(); const progress = vi.fn();
    await expect(appendPreparedNovel(prepared(), 0, send, progress, () => false, false)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(send).not.toHaveBeenCalled(); expect(progress).not.toHaveBeenCalled();
  });
  it('does not report progress or send another batch after cancellation during await', async () => {
    let active = true; const progress = vi.fn();
    const send = vi.fn(async () => { active = false; return receipt(1); });
    await expect(appendPreparedNovel(prepared('x'.repeat(250_001)), 0, send, progress, () => active, false)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(send).toHaveBeenCalledOnce(); expect(progress.mock.calls.map(([fraction]) => fraction)).toEqual([0]);
  });
  it('checks activity again after progress callbacks including the final one', async () => {
    let active = true; const send = vi.fn(async () => receipt(1));
    const progress = vi.fn((fraction: number) => { if (fraction === 1) active = false; });
    await expect(appendPreparedNovel(prepared(), 0, send, progress, () => active, false)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(send).toHaveBeenCalledOnce();
    active = true; const beforeSend = vi.fn();
    await expect(appendPreparedNovel(prepared(), 0, beforeSend, () => { active = false; }, () => active, false)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(beforeSend).not.toHaveBeenCalled();
  });
  it('redacts send failures and gives cancellation precedence after a failed await', async () => {
    await expect(appendPreparedNovel(prepared(), 0, async () => { throw new Error('private source'); }, vi.fn(), () => true, false)).rejects.toThrow('Upload failed (UPLOAD_FAILED)');
    let active = true;
    await expect(appendPreparedNovel(prepared(), 0, async () => { active = false; throw new Error('private source'); }, vi.fn(), () => active, false)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
  it('redacts callback errors and gives cancellation precedence when progress invalidates the session', async () => {
    await expect(appendPreparedNovel(prepared(), 0, vi.fn(), () => { throw new Error('private callback'); }, () => true, false)).rejects.toThrow('Upload failed (UPLOAD_FAILED)');
    await expect(appendPreparedNovel(prepared(), 0, vi.fn(), vi.fn(), () => { throw new Error('private session'); }, false)).rejects.toMatchObject({ code: 'CANCELLED' });
    let active = true;
    await expect(appendPreparedNovel(prepared(), 0, vi.fn(), () => { active = false; throw new Error('private callback'); }, () => active, false)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

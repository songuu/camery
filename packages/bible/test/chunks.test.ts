import { describe, expect, it } from 'vitest';
import { importNovel } from '@camery/ingest';
import type { SourceInput } from '../src/contracts.js';
import { captureSource, hash, textHash } from '../src/data.js';
import { createChunkPlan, readChunk, validateChunkPlan } from '../src/chunks.js';

function source(text = '第一章 初见\r\n小林遇见阿青。\r\n第二章 重逢\r\n阿青递来一封信。'): SourceInput {
  return { tenantId: 'tenant-a', projectId: 'project-a', documentId: 'novel-a', kind: 'novel', revision: 1, document: importNovel(text) };
}
function expectCoverage(input: SourceInput, options: { maxCharacters?: number; maxBytes?: number } = {}) {
  const captured = captureSource(input); const plan = validateChunkPlan(captured, createChunkPlan(input, options));
  let end = 0; const texts: string[] = [];
  for (const [ordinal, chunk] of plan.chunks.entries()) {
    const text = input.document.text.slice(chunk.start, chunk.end);
    expect(chunk.start).toBe(end); expect(chunk.end).toBeGreaterThan(chunk.start); expect(chunk.ordinal).toBe(ordinal);
    expect(chunk.id).toBe(`c-${String(ordinal + 1).padStart(6, '0')}`);
    expect(text.length).toBeLessThanOrEqual(plan.maxCharacters); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(plan.maxBytes);
    expect(text.isWellFormed()).toBe(true);
    expect(input.document.text.slice(chunk.end - 1, chunk.end + 1)).not.toBe('\r\n');
    expect(chunk.textDigest).toBe(textHash(text));
    expect(readChunk(captured, plan, chunk.id)).toEqual({ chunk, text });
    end = chunk.end; texts.push(text);
  }
  expect(end).toBe(input.document.text.length); expect(texts.join('')).toBe(input.document.text);
  const { digest, ...body } = plan; expect(digest).toBe(hash(body));
  expect(validateChunkPlan(captured, plan)).toEqual(plan);
  return plan;
}

describe('deterministic StoryBible chunk planning', () => {
  it('covers ten chapters and preserves BOM, CRLF and all source text', () => {
    const text = '\uFEFF引言。\r\n' + Array.from({ length: 10 }, (_, n) => `第${n + 1}章 雾港来信\r\n${'小林看到阿青手里的信。😀\r\n'.repeat(12)}`).join('');
    const input = source(text); const plan = expectCoverage(input, { maxCharacters: 400, maxBytes: 1200 });
    expect(input.document.units.filter(unit => unit.kind === 'chapter')).toHaveLength(10);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(createChunkPlan(input, { maxCharacters: 400, maxBytes: 1200 })).toEqual(plan);
    expect(plan.source).toMatchObject({ sourceDigest: input.document.sourceDigest, totalCharacters: text.length, kind: 'novel', revision: 1 });
  });
  it('uses bounded defaults and prefers the last complete structural unit that fits', () => {
    const input = source(); const unitEnd = input.document.units[0]!.end;
    const plan = expectCoverage(input, { maxCharacters: unitEnd + 3 });
    expect(plan.chunks[0]!.end).toBe(unitEnd);
    const defaults = createChunkPlan(input); expect(defaults.maxCharacters).toBe(12000); expect(defaults.maxBytes).toBe(48000);
  });
  it('splits an overlong chapter without manufacturing content or stripping whitespace', () => {
    const input = source('第一章 长夜\n' + '甲😀乙\r\n'.repeat(800));
    const plan = expectCoverage(input, { maxCharacters: 113, maxBytes: 200 });
    expect(plan.chunks.length).toBeGreaterThan(40);
  });
  it.each(['😀😀😀', '\r\n\r\n', '甲😀\r\n乙😀\r\n', 'é中😀é中😀', 'a\r\nb\r\nc'])('keeps atomic Unicode and CRLF boundaries with tiny limits: %s', text => {
    expectCoverage(source(text), { maxCharacters: 2, maxBytes: 4 });
  });
  it('enforces UTF-8 bytes independently of UTF-16 length', () => {
    const input = source('甲'.repeat(10)); const plan = expectCoverage(input, { maxCharacters: 20, maxBytes: 4 });
    expect(plan.chunks).toHaveLength(10);
  });
  it('does not choose a structural boundary that bisects CRLF', () => {
    const input = source('甲\r\n乙');
    const altered = { ...input, document: { ...input.document, units: [
      { ordinal: 0, kind: 'frontmatter' as const, title: '', start: 0, end: 2, speaker: null },
      { ordinal: 1, kind: 'chapter' as const, title: '', start: 2, end: 4, speaker: null },
    ] } };
    const plan = expectCoverage(altered, { maxCharacters: 3 }); expect(plan.chunks[0]!.end).toBe(3);
  });
  it('returns immutable plans independently of caller mutation', () => {
    const input = source(); const plan = createChunkPlan(input);
    expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.chunks)).toBe(true); expect(Object.isFrozen(plan.chunks[0])).toBe(true);
    (input as { projectId: string }).projectId = 'changed';
    expect(plan.source.projectId).toBe('project-a');
    expect(() => { (plan.chunks[0] as { start: number }).start = 1; }).toThrow();
  });
  it('only reuses internally verified plans and does not trust a frozen outer object', () => {
    const input = source(); const captured = captureSource(input); const original = createChunkPlan(input);
    const mutable = structuredClone(original); const canonical = validateChunkPlan(captured, mutable);
    expect(canonical).not.toBe(mutable); expect(Object.isFrozen(canonical)).toBe(true);
    expect(validateChunkPlan(captured, canonical)).toBe(canonical);
    mutable.chunks[0]!.end--;
    expect(() => validateChunkPlan(captured, mutable)).toThrow();
    expect(readChunk(captured, canonical, canonical.chunks[0]!.id).text).toBe(input.document.text);
    const fake = Object.freeze({ ...original, chunks: structuredClone(original.chunks) });
    fake.chunks[0]!.start = 1;
    expect(() => validateChunkPlan(captured, fake)).toThrow();
    expect(() => validateChunkPlan(Object.freeze({ ...captured, source: { ...captured.source, revision: 2 } }), canonical)).toThrow();
  });
  it.each([
    { maxCharacters: 1 }, { maxCharacters: 20001 }, { maxCharacters: 2.5 }, { maxCharacters: NaN }, { maxCharacters: Infinity },
    { maxBytes: 3 }, { maxBytes: 60001 }, { maxBytes: 4.5 }, { maxBytes: NaN }, { unknown: 1 }, null, [],
  ])('rejects invalid limits %j', options => {
    expect(() => createChunkPlan(source(), options as never)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('fails rather than truncate a source requiring more than 4096 chunks', () => {
    expect(() => createChunkPlan(source('甲'.repeat(4097)), { maxCharacters: 2, maxBytes: 4 })).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });
  it.each(['tenantId','projectId','documentId','revision'] as const)('rejects a valid plan from a different %s', field => {
    const input = source(); const plan = createChunkPlan(input); const changed = { ...input, [field]: field === 'revision' ? 2 : 'other' };
    expect(() => validateChunkPlan(captureSource(changed), plan)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });
  it.each([
    (plan: ReturnType<typeof createChunkPlan>) => { plan.chunks[0]!.start = 1; },
    (plan: ReturnType<typeof createChunkPlan>) => { plan.chunks[0]!.end--; },
    (plan: ReturnType<typeof createChunkPlan>) => { plan.chunks[0]!.id = 'other'; },
    (plan: ReturnType<typeof createChunkPlan>) => { plan.chunks[0]!.textDigest = 'a'.repeat(64); },
    (plan: ReturnType<typeof createChunkPlan>) => { plan.chunks.reverse(); },
    (plan: ReturnType<typeof createChunkPlan>) => { plan.chunks.pop(); },
    (plan: ReturnType<typeof createChunkPlan>) => { plan.chunks[0]!.ordinal = 4; },
  ])('rejects plan alterations even if the caller supplies a fresh overall digest', alter => {
    const input = source(); const plan = structuredClone(createChunkPlan(input, { maxCharacters: 15 })); alter(plan);
    const { digest: _old, ...body } = plan; plan.digest = hash(body);
    expect(() => validateChunkPlan(captureSource(input), plan)).toThrow();
  });
  it('rejects unknown plan fields, malformed identities and missing chunks', () => {
    const input = source(); const plan = createChunkPlan(input); const captured = captureSource(input);
    expect(() => validateChunkPlan(captured, { ...plan, chunks: Array(4097).fill(plan.chunks[0]) })).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
    expect(() => validateChunkPlan(captured, null)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => validateChunkPlan(captured, { ...plan, digest: 'b'.repeat(64) })).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => validateChunkPlan(captured, { ...plan, extra: true })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => readChunk(captured, plan, 'missing')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => readChunk(captured, plan, '../c-000001')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => validateChunkPlan({ ...captured, source: { ...captured.source, sourceDigest: 'b'.repeat(64) } }, plan)).toThrow();
    expect(() => createChunkPlan({ ...input, document: { ...input.document, sourceDigest: 'b'.repeat(64) } })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

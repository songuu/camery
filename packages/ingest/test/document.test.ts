import { describe, expect, it } from 'vitest';
import { createSourcePage, validateImportedDocument } from '../src/document.js';
import { importNovel } from '../src/novel.js';
import { importFountain, importScriptTable } from '../src/screenplay.js';
import { textDigest } from '../src/data.js';
import type { ImportedDocument } from '../src/types.js';

const novel = () => importNovel('\uFEFF前言😀\r\n第一章 起点\r\n甲😀乙\n第二章 结尾\n丙');
const info = (document = novel()) => ({ documentId: 'source-1', title: '原稿', kind: 'novel' as const, revision: 1, document });
const invalid = { code: 'INVALID_INPUT', operation: 'document' };

describe('persisted imported document contract', () => {
  it('returns the adjacent prior page from a persisted checkpoint without splitting an emoji',()=>{
    const document=importNovel('a'.repeat(12000)+'😀'+'b'.repeat(12000));
    const page=createSourcePage({...info(document),checkpoint:{offset:24002,version:1}},{before:24002});
    expect(page.excerpt).toEqual({start:12002,end:24002,text:'b'.repeat(12000)});
    const emojiEdge=createSourcePage(info(importNovel('a'.repeat(12000)+'😀X')),{before:12003,limit:2});
    expect(emojiEdge.excerpt).toEqual({start:12002,end:12003,text:'X'});
    expect(()=>createSourcePage(info(document),{offset:0,before:12000})).toThrow();
    expect(()=>createSourcePage(info(document),{before:12001})).toThrow();
  });
  it('requires text formats to bind the original digest to the exact source text', () => {
    for (const document of [novel(),importFountain('原文\n'),importScriptTable('对白\n原文\n')])
      expect(()=>validateImportedDocument({...document,originalDigest:'0'.repeat(64)})).toThrow(expect.objectContaining(invalid));
  });
  it('accepts parser results without losing source bytes, metadata or immutability', () => {
    for (const document of [novel(), importFountain('.内景 场所\n\n@小林\n你好😀\n'), importScriptTable('场景,角色,对白\n屋内,甲,"你好\n世界"\n'), importScriptTable('角色\t对白\n甲\t你好\n', '\t')]) {
      const result = validateImportedDocument(JSON.parse(JSON.stringify(document)));
      expect(result).toEqual(document); expect(Object.isFrozen(result.units)).toBe(true);
      expect(result.units.map(unit => result.text.slice(unit.start, unit.end)).join('')).toBe(document.text);
    }
    const word = { ...importFountain('正文\n'), format: 'docx', originalDigest: '1'.repeat(64) };
    expect(validateImportedDocument(word)).toEqual(word);
  });

  it.each([null, [], {}, { ...novel(), extra: 'secret' }, { ...novel(), format: 'doc' }, { ...novel(), offsetUnit: 'bytes' },
    { ...novel(), sourceDigest: '0'.repeat(64) }, { ...novel(), sourceDigest: 'A'.repeat(64) }, { ...novel(), originalDigest: 'not-a-digest' },
    { ...novel(), text: '' }, { ...novel(), text: '\0' }, { ...novel(), text: '\ud800' }, { ...novel(), units: [] },
    { ...novel(), warnings: [42] }, { ...novel(), warnings: ['bad\0warning'] }, { ...novel(), warnings: ['\ud800'] },
    { ...novel(), warnings: null }, { ...novel(), units: null },
  ])('rejects malformed or mismatched imported state %j', input => {
    expect(() => validateImportedDocument(input)).toThrow(expect.objectContaining(invalid));
  });

  it('validates all unit identities, ranges and metadata without trusting storage', () => {
    const base = importFountain('甲😀乙\n');
    const unit = base.units[0]!;
    for (const patch of [{ ordinal: 1 }, { start: 1 }, { end: 0 }, { end: base.text.length + 1 }, { end: 2 }, { start: 0.5 },
      { kind: 'not-a-kind' }, { title: '\0' }, { title: '\ud800' }, { speaker: 42 }, { speaker: '\udfff' },
      { fields: [] }, { fields: null }, { fields: { key: 42 } }, { fields: { key: '\0' } }, { fields: { ['\ud800']: 'text' } },
      { fields: JSON.parse('{"__proto__":"unsafe"}') }, { extra: true },
    ]) expect(() => validateImportedDocument({ ...base, units: [{ ...unit, ...patch }] })).toThrow(expect.objectContaining(invalid));
    expect(() => validateImportedDocument({ ...base, units: [{ ...unit, end: 1 }] })).toThrow(expect.objectContaining(invalid));
    expect(() => validateImportedDocument({ ...base, units: [{ ...unit, end: 2 }, { ...unit, ordinal: 1, start: 2 }] })).toThrow(expect.objectContaining(invalid));
  });

  it('bounds text, unit counts, warning sizes and field counts before returning projections', () => {
    const base = novel();
    for (const patch of [{ text: 'x'.repeat(16_000_001) }, { units: Array(100_002).fill(base.units[0]) },
      { warnings: Array(65).fill('warning') }, { warnings: ['x'.repeat(129)] },
      { units: [{ ...base.units[0], fields: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`k${index}`, 'value'])) }] },
    ]) expect(() => validateImportedDocument({ ...base, ...patch })).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });

  it('charges repeated logical metadata before validating or copying more units', () => {
    const text = 'xy';
    const digest = textDigest(text);
    const document = { format: 'docx', text, offsetUnit: 'utf16', sourceDigest: digest, originalDigest: digest, warnings: [], units: [
      { ordinal: 0, kind: 'action', title: 'a'.repeat(9_000_000), start: 0, end: 1, speaker: null },
      { ordinal: 1, kind: 'action', title: 'a'.repeat(9_000_000), start: 1, end: 2, speaker: null },
    ] };
    expect(() => validateImportedDocument(document)).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });
});

describe('bounded source read projection', () => {
  it('returns only bounded display metadata and the exact requested source excerpt', () => {
    const document = novel();
    const page = createSourcePage(info(document), { offset: '0', limit: '12' });
    expect(page).toMatchObject({ documentId: 'source-1', title: '原稿', kind: 'novel', format: 'novel', revision: 1, totalCharacters: document.text.length,
      unitCount: document.units.length, sourceDigest: document.sourceDigest, originalDigest: document.originalDigest, checkpoint: null,
      excerpt: { start: 0, end: 12, text: document.text.slice(0, 12) }, warnings: [] });
    expect(page).not.toHaveProperty('document'); expect(page).not.toHaveProperty('snapshot'); expect(page).not.toHaveProperty('text');
    expect(Object.isFrozen(page.excerpt)).toBe(true);
  });

  it('uses the reader checkpoint by default and allows an empty end-of-source page', () => {
    const document = novel();
    const checkpoint = { offset: document.text.indexOf('第一章'), version: 4 };
    expect(createSourcePage({ ...info(document), checkpoint }).excerpt.start).toBe(checkpoint.offset);
    expect(createSourcePage({ ...info(document), checkpoint }).checkpoint).toEqual(checkpoint);
    expect(createSourcePage(info(document), { offset: document.text.length })).toMatchObject({ excerpt: { start: document.text.length, end: document.text.length, text: '' }, units: [] });
    expect(createSourcePage({ ...info(document), checkpoint: null }).checkpoint).toBeNull();
  });

  it('never cuts surrogate pairs in source excerpts or shortened labels', () => {
    const text = 'a😀b'; const digest = textDigest(text);
    const document: ImportedDocument = { format: 'fountain', text, sourceDigest: digest, originalDigest: digest, offsetUnit: 'utf16', warnings: [],
      units: [{ ordinal: 0, kind: 'character', title: 'x'.repeat(119) + '😀long', speaker: 'x'.repeat(119) + '😀long', start: 0, end: text.length, fields: { custom: 'not sent' } }] };
    const page = createSourcePage({ ...info(document), kind: 'script' }, { offset: 0, limit: 2 });
    expect(page.excerpt).toEqual({ start: 0, end: 1, text: 'a' });
    expect(page.units[0]?.title).toBe('x'.repeat(119)); expect(page.units[0]?.speaker).toBe('x'.repeat(119));
    expect(page.units[0]).not.toHaveProperty('fields');
    expect(createSourcePage({ ...info(document), kind: 'script' }, { offset: 1, limit: 2 }).excerpt.text).toBe('😀');
    expect(() => createSourcePage({ ...info(document), kind: 'script' }, { offset: 2 })).toThrow(expect.objectContaining(invalid));
  });

  it('caps intersecting units at 200 without changing the stored source or total count', () => {
    const document = importFountain('x\n'.repeat(300));
    const page = createSourcePage({ ...info(document), kind: 'script' });
    expect(page.units).toHaveLength(200); expect(page.unitCount).toBe(300); expect(page.excerpt.text).toBe(document.text);
    expect(document.units).toHaveLength(300);
  });

  it.each([null, [], { extra: true }, { offset: '' }, { offset: '-1' }, { offset: '1e1' }, { offset: '1\n' }, { offset: '9007199254740992' },
    { offset: NaN }, { offset: Infinity }, { offset: -1 }, { offset: 0.5 }, { offset: 99999 }, { limit: 1 }, { limit: 20001 }, { limit: ' 12' },
  ])('rejects invalid paging input %j', query => {
    expect(() => createSourcePage(info(), query)).toThrow(expect.objectContaining(invalid));
  });

  it('rejects invalid source identities and checkpoint state', () => {
    const base = info();
    for (const patch of [{ documentId: 'source\n' }, { documentId: '../source' }, { title: 'x'.repeat(201) }, { title: '\0' }, { title: '\ud800' },
      { revision: 0 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { kind: 'script' }, { kind: 'unknown' }, { extra: 1 },
      { checkpoint: { offset: 2, version: 0 } }, { checkpoint: { offset: 4, version: 1 } }, { checkpoint: { offset: 999, version: 1 } },
      { checkpoint: { offset: -1, version: 1 } }, { checkpoint: { offset: 0, version: 1, readerId: 'spoof' } },
    ]) expect(() => createSourcePage({ ...base, ...patch } as typeof base)).toThrow(expect.objectContaining(invalid));
    const script = importFountain('action');
    expect(() => createSourcePage({ ...info(script), kind: 'script', checkpoint: { offset: 0, version: 1 } })).toThrow(expect.objectContaining(invalid));
  });
});

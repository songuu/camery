import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { importNovel } from '../src/novel.js';
import { ImportError } from '../src/types.js';
import { MAX_DOCUMENT_CHARACTERS } from '../src/data.js';

describe('novel source import', () => {
  it('preserves BOM, CRLF, emoji, frontmatter and the exact UTF-16 chapter ranges', () => {
    const text = '\uFEFF作者的话😀\r\n第一章 起点\r\n甲😀\r\n第2回：再见\r\n乙';
    const first = text.indexOf('第一章'); const second = text.indexOf('第2回');
    const document = importNovel(text);
    expect(document).toEqual({
      format: 'novel', text, offsetUnit: 'utf16',
      sourceDigest: createHash('sha256').update(text).digest('hex'),
      originalDigest: createHash('sha256').update(text).digest('hex'),
      units: [
        { ordinal: 0, kind: 'frontmatter', title: '', start: 0, end: first, speaker: null },
        { ordinal: 1, kind: 'chapter', title: '第一章 起点', start: first, end: second, speaker: null },
        { ordinal: 2, kind: 'chapter', title: '第2回：再见', start: second, end: text.length, speaker: null },
      ], warnings: [],
    });
    expect(document.units.map(unit => document.text.slice(unit.start, unit.end)).join('')).toBe(text);
  });

  it('allows a BOM on the first heading and mixed line separators without normalization', () => {
    const text = '\uFEFF\t第一章\r甲\n  第二集 乙\r\n丙';
    const document = importNovel(text);
    expect(document.units).toEqual([
      { ordinal: 0, kind: 'chapter', title: '第一章', start: 0, end: text.indexOf('  第二集'), speaker: null },
      { ordinal: 1, kind: 'chapter', title: '第二集 乙', start: text.indexOf('  第二集'), end: text.length, speaker: null },
    ]);
  });

  it.each(['没有标题的一段😀正文', ' \r\n\t ', '第一章没有分隔符的正文', '    第一章 缩进正文', '人物说：“第一章 标题”', 'Chapter 1: unsupported explicit heading'])('does not invent chapters from non-heading content: %j', text => {
    const document = importNovel(text);
    expect(document.units).toEqual([{ ordinal: 0, kind: 'frontmatter', title: '', start: 0, end: text.length, speaker: null }]);
    expect(document.warnings).toEqual(['NO_EXPLICIT_HEADINGS']);
  });

  it('keeps chapter ordinals and boundaries deterministic across cumulative batches', () => {
    const parts = ['前言\r\n第', '一章 标', '题\r\n内容😀\r\n第二', '章\r\n结束'];
    const text = parts.join('');
    let cumulative = '';
    for (const part of parts) { cumulative += part; expect(importNovel(cumulative).text).toBe(cumulative); }
    expect(importNovel(cumulative)).toEqual(importNovel(text));
    expect(importNovel(text).units.map(unit => [unit.ordinal, unit.start])).toEqual([[0, 0], [1, text.indexOf('第一章')], [2, text.indexOf('第二章')]]);
  });

  it('freezes nested output and creates independent deterministic results', () => {
    const document = importNovel('第一章\n正文');
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.units)).toBe(true);
    expect(Object.isFrozen(document.units[0])).toBe(true);
    expect(Object.isFrozen(document.warnings)).toBe(true);
    expect(importNovel(document.text)).toEqual(document);
  });

  it.each([null, undefined, false, 123, {}, [], '', '\0secret', '\uD800', '\uDC00'])('rejects malformed source without exposing content: %j', input => {
    expect(() => importNovel(input)).toThrowError(ImportError);
    try { importNovel(input); } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_INPUT', operation: 'novel source' });
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('accepts the document character limit including astral characters', () => {
    const text = '😀'.repeat(MAX_DOCUMENT_CHARACTERS / 2);
    const document = importNovel(text);
    expect(document.units[0]?.end).toBe(MAX_DOCUMENT_CHARACTERS);
    expect(document.text).toBe(text);
  });

  it('rejects text over the document character limit', () => {
    expect(() => importNovel('甲'.repeat(MAX_DOCUMENT_CHARACTERS + 1))).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });

  it('accepts at most 10,000 output units and rejects the next heading', () => {
    const text = '第一章\n'.repeat(10000);
    expect(importNovel(text).units).toHaveLength(10000);
    expect(() => importNovel(text + '第一章')).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT', operation: 'novel chapters' }));
  });

  it('counts frontmatter toward the output unit limit', () => {
    const text = '前言\n' + '第一章\n'.repeat(9999);
    expect(importNovel(text).units).toHaveLength(10000);
    expect(() => importNovel(text + '第一章')).toThrowError(expect.objectContaining({ code: 'INPUT_LIMIT', operation: 'novel chapters' }));
  });
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chapterExecutor, chapterPack, recognizeChapterHeading } from '../src/chapter.js';

describe('shared chapter heading grammar', () => {
  it.each([
    ['第1章', '第1章'], ['\uFEFF\t第〇回 开端  ', '第〇回 开端'], ['   第两万集：结束', '第两万集：结束'],
    ['第一章正文', null], ['    第一章 标题', null], ['第1章\n正文', null], ['\uFEFF\uFEFF第一章', null], ['第1章 ' + '甲'.repeat(81), null],
    ['第一章:', null], ['第一章: ', '第一章:'], ['第一章::', '第一章::'], ['第一章：', null], ['第一章：：', '第一章：：'],
    ['第一章\r\n', null], ['第一章\r', null], ['第一章\n', null], ['第一章\u2028', null], ['第一章\u2029', null],
    ['第一章:甲\r乙', null], ['第一章:甲\n乙', null],
  ])('recognizes %j without changing source bytes', (line, title) => {
    expect(recognizeChapterHeading(line!)).toBe(title);
  });

  it('matches the original bounded heading grammar across delimiter, title and trailing-space splits', () => {
    const original = /^\uFEFF?[ \t]{0,3}第[0-9〇零一二三四五六七八九十百千万两]+[章回集](?:[ \t:：、.]+[^\r\n]{1,80})?[ \t]*$/;
    const prefixes = ['第一章', '\uFEFF\t第2回', '   第两万集', '    第3章', '第章', '第1节', '第123章', '第1', '第一章正文'];
    const tails = ['', ' ', '\t', ':', '::', ': ', '：', '：：', '：\t', '、.', '甲', '😀', '\r', '\n', '\u2028', '\u2029'];
    for (const prefix of prefixes) for (const delimiter of tails) for (const body of ['', '甲', '甲'.repeat(79), '甲'.repeat(80), '甲'.repeat(81), '😀'.repeat(40), '😀'.repeat(41)]) for (const trailing of ['', ' ', '\t  ']) {
      const line = prefix + delimiter + body + trailing;
      expect(recognizeChapterHeading(line)).toBe(original.test(line) ? line.replace(/^\uFEFF/, '').trim() : null);
    }
  });

  it('handles adversarial whitespace in a bounded child process without restricting valid whitespace', () => {
    // The old overlapping quantifiers can hang on malformed source; a child bounds that failure mode.
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { recognizeChapterHeading } from './src/chapter.ts';
      process.stdout.write('ready\\n');
      const padding = ' '.repeat(1_000_000);
      const rejected = recognizeChapterHeading('第一章 ' + padding + 'x'.repeat(81)) === null;
      const delimiterAccepted = recognizeChapterHeading('第一章' + padding + 'x') !== null;
      const trailingAccepted = recognizeChapterHeading('第一章' + padding) === '第一章';
      process.stdout.write(JSON.stringify({ rejected, delimiterAccepted, trailingAccepted }));
    `], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096 });
    expect(child.error, child.stdout + child.stderr).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('ready\n{"rejected":true,"delimiterAccepted":true,"trailingAccepted":true}');
  });

  it('retains method output boundaries and its existing canonical digest contract', async () => {
    const text = '前言\r\n第一章 标题\r\n正文😀';
    const result = await chapterExecutor.execute({ text }, { tenantId: 'tenant', connectionId: 'connection', modeDigest: 'a'.repeat(64), idempotencyKey: 'chapter', signal: new AbortController().signal }, chapterPack);
    expect(result).toMatchObject({
      sourceDigest: 'a5f12b5ff970f032a3640e6f1fdca506b25e8397ff508cafb9fbd8b199d765cd',
      offsetUnit: 'utf16', warnings: [],
      chapters: [{ ordinal: 0, kind: 'frontmatter', title: '', start: 0, end: 4 }, { ordinal: 1, kind: 'chapter', title: '第一章 标题', start: 4, end: text.length }],
    });
  });

  it('retains the method executor heading count limit', async () => {
    await expect(chapterExecutor.execute({ text: '第一章\n'.repeat(10001) }, { tenantId: 'tenant', connectionId: 'connection', modeDigest: 'a'.repeat(64), idempotencyKey: 'chapter-limit', signal: new AbortController().signal }, chapterPack)).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  });
});

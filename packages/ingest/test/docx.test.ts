import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as yauzl from 'yauzl';
import { describe, expect, it, vi } from 'vitest';
import { importDocx } from '../src/node/docx.js';
import { textDigest } from '../src/data.js';

import { ns, contentTypes, document, zip, docx } from './fixtures/docx.js';

function boundedDocx(bytes: Uint8Array): Promise<{ elapsed: number; units: number | null; code: string | null }> {
  const source = `
    import { importDocx } from ${JSON.stringify(new URL('../src/node/docx.ts', import.meta.url).href)};
    process.on('message', async (encoded) => {
      const bytes = Buffer.from(encoded, 'base64'); const started = performance.now();
      try {
        const output = await importDocx(bytes);
        process.send({ kind: 'done', elapsed: performance.now() - started, units: output.units.length, code: null }, () => process.disconnect());
      } catch (error) {
        process.send({ kind: 'done', elapsed: performance.now() - started, units: null, code: error.code ?? 'UNKNOWN' }, () => process.disconnect());
      }
    });
    process.send({ kind: 'ready' });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let result: { elapsed: number; units: number | null; code: string | null } | undefined; let settled = false; let diagnostics = '';
    const fail = (message: string) => { if (!settled) { settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(message)); } };
    let timer = setTimeout(() => fail('DOCX child startup timed out'), 10000);
    child.stderr?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
    child.on('error', () => fail('DOCX child failed to start'));
    child.on('message', (message: { kind?: string; elapsed?: number; units?: number | null; code?: string | null }) => {
      if (message.kind === 'ready') { clearTimeout(timer); timer = setTimeout(() => fail('DOCX parsing exceeded 1800ms after ready'), 1800); child.send(Buffer.from(bytes).toString('base64')); }
      else if (message.kind === 'done' && message.elapsed !== undefined && message.units !== undefined && message.code !== undefined) { clearTimeout(timer); result = { elapsed: message.elapsed, units: message.units, code: message.code }; timer = setTimeout(() => fail('DOCX child failed to exit'), 1000); }
    });
    child.on('exit', code => { clearTimeout(timer); if (settled) return; settled = true; if (code === 0 && result) resolve(result); else reject(new Error(`DOCX child exited ${code}: ${diagnostics}`)); });
  });
}

describe('bounded Word DOCX screenplay extraction', () => {
  it.each(['moderate-style', 'long-title'])('bounds multiplicative %s projection in an isolated child', async variant => {
    const repeated = '<w:br/>'.repeat(50_000);
    const style = variant === 'moderate-style' ? 'Q'.repeat(200) : 'SceneHeading';
    const text = variant === 'long-title' ? ' '.repeat(1_000_000) + 'A' : 'A';
    const bytes = docx(`<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t>${repeated}</w:r></w:p>`);
    expect(bytes.length).toBeLessThan(10_000);
    const value = await boundedDocx(bytes);
    expect(value.elapsed).toBeLessThan(1800); expect(value.units).toBe(50_001); expect(value.code).toBeNull();
  }, 15000);
  it.each(['style', 'title', 'speaker'])('rejects serialized %s amplification before returning projected units', async variant => {
    const style = variant === 'style' ? 'Q'.repeat(1_000_000) : variant === 'title' ? 'SceneHeading' : 'Character';
    const text = variant === 'style' ? 'A' : variant === 'title' ? 'A'.repeat(1_000_000) : '@' + 'BOB'.repeat(100_000);
    const bytes = docx(`<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${text}</w:t>${'<w:br/>'.repeat(200)}</w:r></w:p>`);
    expect(bytes.length).toBeLessThan(10_000);
    const value = await boundedDocx(bytes);
    expect(value.elapsed).toBeLessThan(1800); expect(value.code).toBe('INPUT_LIMIT'); expect(value.units).toBeNull();
  }, 15000);
  it('limits paragraphs during extraction before allocating an oversized paragraph list', async () => {
    const body = '<w:p><w:r><w:t>正文</w:t></w:r></w:p>' + '<w:p/>'.repeat(100_000);
    await expect(importDocx(docx(body))).rejects.toMatchObject({ code: 'INPUT_LIMIT', operation: 'docx paragraphs' });
  });
  it('extracts runs, XML escapes, paragraphs, breaks, tabs and table text without disk extraction', async () => {
    const bytes = docx('<w:p><w:r><w:t>INT. ROOM - DAY</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>@小林</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">你 &amp; 我</w:t><w:tab/><w:t>😀</w:t><w:br/><w:t>下一句</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格文字</w:t></w:r></w:p></w:tc></w:tr></w:tbl>');
    const value = await importDocx(bytes);
    expect(value.format).toBe('docx'); expect(value.text).toBe('INT. ROOM - DAY\n\n@小林\n你 & 我\t😀\n下一句\n表格文字\n');
    expect(value.originalDigest).toBe(textDigest(bytes)); expect(value.sourceDigest).toBe(textDigest(value.text));
    expect(value.units.some(u => u.kind === 'scene')).toBe(true); expect(value.units.some(u => u.kind === 'dialogue' && u.speaker === '小林')).toBe(true);
    expect(value.units.map(u => value.text.slice(u.start, u.end)).join('')).toBe(value.text);
    expect(value.warnings).toContain('DOCX_TEXT_EXTRACTION'); expect(Object.isFrozen(value)).toBe(true);
  });
  it('honors explicit standard screenplay paragraph styles and preserves style metadata', async () => {
    const bytes = docx('<w:p><w:pPr><w:pStyle w:val="SceneHeading"/></w:pPr><w:r><w:t>内景 房间 日</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Character"/></w:pPr><w:r><w:t>小林</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Dialogue"/></w:pPr><w:r><w:t>你好。</w:t></w:r></w:p>');
    const value = await importDocx(bytes);
    expect(value.units.map(u => u.kind)).toEqual(['scene', 'character', 'dialogue']);
    expect(value.units[2]?.speaker).toBe('小林'); expect(value.units[0]?.fields?.['wordStyle']).toBe('SceneHeading');
  });
  it('captures the original bytes before asynchronous parsing, even if the caller mutates its buffer', async () => {
    const bytes = docx('<w:p><w:r><w:t>原文</w:t></w:r></w:p>'); const expected = textDigest(bytes);
    const pending = importDocx(bytes); bytes.fill(0);
    const value = await pending; expect(value.originalDigest).toBe(expected); expect(value.text).toBe('原文\n');
  });
  it('supports strict OOXML namespaces and ignores comments, relations and non-body content with warning', async () => {
    const xml = '<x:document xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"><x:body><x:p><x:r><x:t><![CDATA[正文]]></x:t><x:cr/><x:t>结束</x:t></x:r></x:p></x:body></x:document>';
    const value = await importDocx(zip([{ name: '[Content_Types].xml', text: contentTypes }, { name: 'word/document.xml', text: xml }, { name: 'word/_rels/document.xml.rels', text: '<Relationships><Relationship Target="https://example.invalid/never-fetch" TargetMode="External"/></Relationships>' }]));
    expect(value.text).toBe('正文\n结束\n'); expect(value.warnings).toContain('DOCX_NON_BODY_CONTENT_NOT_IMPORTED');
  });
  it.each([new Uint8Array(), Buffer.from('not a zip'), null, 'file.docx'])('rejects invalid DOCX bytes', async bytes => {
    await expect(importDocx(bytes as Uint8Array)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|MALFORMED_DOCUMENT/) });
  });
  it('rejects overlarge compressed input before opening ZIP', async () => {
    await expect(importDocx(new Uint8Array(8_000_001))).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  });
  it.each([
    [],
    [{ name: 'word/document.xml', text: document('<w:p/>') }],
    [{ name: '[Content_Types].xml', text: contentTypes }],
    [{ name: '[Content_Types].xml', text: '<Types/>' }, { name: 'word/document.xml', text: document('<w:p/>') }],
    [{ name: '[Content_Types].xml', text: contentTypes }, { name: 'word/document.xml', text: '<wrong/>' }],
  ].map(entries => ({ entries })))('rejects archives missing a supported DOCX content type or body', async ({ entries }) => {
    await expect(importDocx(zip(entries))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT' });
  });
  it.each([
    '<w:p><w:r><w:t>&unknown;</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>unclosed</w:p>',
    '<w:p><w:r><w:t>\0</w:t></w:r></w:p>',
  ])('rejects malformed XML and unknown entities', async body => {
    await expect(importDocx(docx(body))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT' });
  });
  it('rejects DTDs instead of resolving local or external entities', async () => {
    const xml = '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///never-read">]>' + document('<w:p><w:r><w:t>&x;</w:t></w:r></w:p>');
    await expect(importDocx(zip([{ name: '[Content_Types].xml', text: contentTypes }, { name: 'word/document.xml', text: xml }]))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT' });
  });
  it('rejects duplicate body parts, encrypted entries, macros and unsafe paths', async () => {
    for (const extra of [
      { name: 'word/document.xml', text: document('<w:p/>') },
      { name: 'word/vbaProject.bin', text: 'not executed' },
      { name: '../escape', text: 'not extracted' },
      { name: 'word\\evil', text: 'not extracted' },
      { name: 'word/encrypted', text: 'data', flags: 1 },
    ]) await expect(importDocx(docx('<w:p><w:r><w:t>A</w:t></w:r></w:p>', [extra]))).rejects.toMatchObject({ code: expect.stringMatching(/MALFORMED_DOCUMENT|UNSUPPORTED_FORMAT/) });
  });
  it('rejects dishonest sizes, CRC mismatch and advertised decompression bombs', async () => {
    for (const entry of [
      { name: 'word/document.xml', text: document('<w:p><w:r><w:t>A</w:t></w:r></w:p>'), advertisedSize: 1 },
      { name: 'word/document.xml', text: document('<w:p><w:r><w:t>A</w:t></w:r></w:p>'), badCrc: true },
      { name: 'word/document.xml', text: document('<w:p/>'), advertisedSize: 16_000_001 },
      { name: 'unused', text: 'ignored', advertisedSize: 33_000_000 },
    ]) await expect(importDocx(zip([{ name: '[Content_Types].xml', text: contentTypes }, entry]))).rejects.toMatchObject({ code: expect.stringMatching(/MALFORMED_DOCUMENT|INPUT_LIMIT/) });
  });
  it('bounds XML nesting and ZIP entry count', async () => {
    await expect(importDocx(docx('<w:sdt>'.repeat(129) + '<w:p/>' + '</w:sdt>'.repeat(129)))).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
    await expect(importDocx(docx('<w:p/>', Array.from({ length: 2049 }, (_, i) => ({ name: `unused${i}`, text: '' }))))).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
  });
  it('does not import deleted tracked content as current text or silently flatten active changes', async () => {
    await expect(importDocx(docx('<w:p><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del></w:p>'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
  it('rejects duplicate or nested bodies, nested paragraphs and invalid body encodings', async () => {
    const originals = [
      `<w:document xmlns:w="${ns}"><w:body/><w:body/></w:document>`,
      `<w:document xmlns:w="${ns}"><w:p><w:body/></w:p></w:document>`,
      document('<w:p><w:p/></w:p>'),
      `<w:document xmlns:w="${ns}"><w:p/></w:document>`,
    ];
    for (const xml of originals) await expect(importDocx(zip([{ name: '[Content_Types].xml', text: contentTypes }, { name: 'word/document.xml', text: xml }]))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT' });
    await expect(importDocx(zip([{ name: '[Content_Types].xml', text: contentTypes }, { name: 'word/document.xml', text: '', raw: Uint8Array.of(0xc0) }]))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT' });
    await expect(importDocx(zip([{ name: '[Content_Types].xml', text: '<x:Override xmlns:x="wrong" PartName="/word/document.xml" ContentType="wrong"/>' }, { name: 'word/document.xml', text: document('<w:p/>') }]))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT' });
  });
  it('retains unrecognized styles and skips non-Word XML without inventing source content', async () => {
    const value = await importDocx(docx('<w:p><w:pPr><w:pStyle/></w:pPr><x:ignored xmlns:x="urn:other">hidden</x:ignored><w:r><w:t>Actual</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Custom"/></w:pPr><w:r><w:t>Paragraph</w:t></w:r></w:p>'));
    expect(value.text).toBe('Actual\nParagraph\n'); expect(value.units[1]?.fields?.['wordStyle']).toBe('Custom');
  });
  it('does not resurrect a Fountain-inferred speaker overridden by an explicit Word action style', async () => {
    const value = await importDocx(docx('<w:p><w:pPr><w:pStyle w:val="Action"/></w:pPr><w:r><w:t>BOB</w:t></w:r></w:p><w:p><w:r><w:t>Unassigned words</w:t></w:r></w:p>'));
    expect(value.units.map(u => u.kind)).toEqual(['action', 'action']); expect(value.units[1]?.speaker).toBeNull();
  });
  it('maps ZIP entry open failures and enforces an independent actual-output bound', async () => {
    const spy = vi.spyOn(yauzl.ZipFile.prototype, 'openReadStream');
    try {
      spy.mockImplementationOnce((...args) => { const callback = args.at(-1); if (typeof callback === 'function') Reflect.apply(callback, undefined, [new Error('underlying detail')]); });
      await expect(importDocx(docx('<w:p/>'))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT' });
      spy.mockImplementationOnce((...args) => { const callback = args.at(-1); if (typeof callback === 'function') Reflect.apply(callback, undefined, [null, Readable.from([Buffer.alloc(250_001)])]); });
      await expect(importDocx(docx('<w:p/>'))).rejects.toMatchObject({ code: 'INPUT_LIMIT' });
      spy.mockImplementationOnce(() => { throw new Error('underlying sensitive detail'); });
      await expect(importDocx(docx('<w:p/>'))).rejects.toMatchObject({ code: 'MALFORMED_DOCUMENT', message: 'Import docx failed (MALFORMED_DOCUMENT)' });
    } finally { spy.mockRestore(); }
  });
});

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importFountain, importScriptTable } from '../src/screenplay.js';
import { textDigest } from '../src/data.js';
import { ImportError } from '../src/types.js';

function boundedFountain(pattern: string): Promise<number> {
  const source = `
    import { importFountain } from ${JSON.stringify(new URL('../src/screenplay.ts', import.meta.url).href)};
    process.on('message', (pattern) => {
      const inputs = {
        spaces: 'A' + ' '.repeat(100000) + 'B',
        opening: 'A' + '('.repeat(100000) + 'B',
        spacedOpening: 'A' + ' ('.repeat(50000) + 'B',
        suffix: 'BOB' + ' '.repeat(100000) + '(on radio)',
        dual: 'BOB' + '\\t'.repeat(100000) + '^',
        section: '#'.repeat(100000) + ' ' + 'B',
      };
      const input = inputs[pattern]; const started = performance.now();
      const output = importFountain(input);
      if (output.text !== input) throw new Error('source changed');
      process.send({ kind: 'done', elapsed: performance.now() - started }, () => process.disconnect());
    });
    process.send({ kind: 'ready' });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let elapsed: number | undefined; let settled = false; let diagnostics = '';
    const fail = (message: string) => { if (!settled) { settled = true; clearTimeout(timer); child.kill('SIGKILL'); reject(new Error(message)); } };
    // Loader/worker startup is excluded; only parsing after the explicit ready handshake is bounded.
    let timer = setTimeout(() => fail('Fountain child startup timed out'), 10000);
    child.stderr?.on('data', (data: Buffer) => { diagnostics = (diagnostics + data.toString()).slice(-2000); });
    child.on('error', () => fail('Fountain child failed to start'));
    child.on('message', (message: { kind?: string; elapsed?: number }) => {
      if (message.kind === 'ready') { clearTimeout(timer); timer = setTimeout(() => fail(`Fountain ${pattern} exceeded 1800ms after ready`), 1800); child.send(pattern); }
      else if (message.kind === 'done') { clearTimeout(timer); elapsed = message.elapsed; timer = setTimeout(() => fail('Fountain child failed to exit'), 1000); }
    });
    child.on('exit', code => {
      clearTimeout(timer); if (settled) return; settled = true;
      if (code === 0 && elapsed !== undefined) resolve(elapsed); else reject(new Error(`Fountain child exited ${code}: ${diagnostics}`));
    });
  });
}

describe('Fountain source import', () => {
  it('bounds a huge character name reused by many dialogue lines before serialization', () => {
    const text = '@' + 'A'.repeat(1_000_000) + '\n' + 'dialogue\n'.repeat(20);
    expect(() => importFountain(text)).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT', operation: 'projection metadata' }));
  });
  it.each(['spaces', 'opening', 'spacedOpening', 'suffix', 'dual', 'section'])('bounds hostile %s lines in an isolated child after startup', async pattern => {
    expect(await boundedFountain(pattern)).toBeLessThan(1800);
  }, 15000);
  it('structures scenes, speakers, dialogue and parentheticals without losing original CRLF or emoji', () => {
    const text = '\uFEFFTitle: 原创试稿\r\nAuthor: 测试作者\r\n\r\nINT. ROOM - DAY\r\n\r\nA red mug.😀\r\n\r\n@小林\r\n(轻声)\r\n你好。\r\n\r\nCUT TO:\r\n\r\n.外景——雨中\r\n\r\n~雨声\r\n';
    const value = importFountain(text);
    expect(value.format).toBe('fountain'); expect(value.text).toBe(text);
    expect(value.sourceDigest).toBe(textDigest(text)); expect(value.originalDigest).toBe(value.sourceDigest);
    expect(value.units.filter(u => u.kind === 'scene').map(u => u.title)).toEqual(['INT. ROOM - DAY', '外景——雨中']);
    expect(value.units.find(u => u.kind === 'character')?.speaker).toBe('小林');
    expect(value.units.find(u => u.kind === 'dialogue')?.speaker).toBe('小林');
    expect(value.units.some(u => u.kind === 'parenthetical')).toBe(true);
    expect(value.units.some(u => u.kind === 'transition')).toBe(true);
    expect(value.units.some(u => u.kind === 'lyric')).toBe(true);
    expect(value.units.map(u => text.slice(u.start, u.end)).join('')).toBe(text);
    expect(value.units.map(u => u.ordinal)).toEqual(value.units.map((_, i) => i));
    expect(Object.isFrozen(value.units[0])).toBe(true);
  });
  it('respects automatic character context, extensions, forced action and dual dialogue', () => {
    const text = 'INT. ROOM - DAY\n\nMOM (on radio)\nHello.\nStill speaking.\n\nBOB ^\nGoodbye.\n\n!SCANNING THE AISLES\nWhere?\n';
    const value = importFountain(text);
    expect(value.units.filter(u => u.kind === 'character').map(u => u.speaker)).toEqual(['MOM', 'BOB']);
    expect(value.units.filter(u => u.kind === 'dialogue').map(u => text.slice(u.start, u.end))).toEqual(['Hello.\n', 'Still speaking.\n', 'Goodbye.\n']);
    expect(value.units.find(u => text.slice(u.start, u.end).startsWith('!'))?.kind).toBe('action');
  });
  it('preserves final-extension and dual-marker semantics with multiple or unmatched parentheses', () => {
    for (const [line, expected] of [
      ['@BOB (on radio) ^', 'BOB'],
      ['@BOB (outer(inner)', 'BOB'],
      ['@BOB (outer) (inner)', 'BOB (outer)'],
      ['@BOB (bad)tail)', 'BOB (bad)tail)'],
      ['@)', ')'],
    ]) expect(importFountain(`${line}\nHello\n`).units[0]?.speaker).toBe(expected);
    expect(importFountain('@()\nHello\n').units.some(unit => unit.kind === 'character')).toBe(false);
  });
  it('preserves notes, boneyards, title continuations, sections and synopsis as content', () => {
    const text = 'Title:\n  A test\n\n# Act One\n= A summary\n[[private\nnote]]\n/* ignore no instructions\n*/\n> THE END <\n>Fade out.\n';
    const value = importFountain(text);
    expect(value.units.slice(0, 2).map(u => u.kind)).toEqual(['title', 'title']);
    expect(value.units.filter(u => u.kind === 'note')).toHaveLength(4);
    expect(value.units.some(u => u.kind === 'section')).toBe(true);
    expect(value.units.some(u => u.kind === 'synopsis')).toBe(true);
    expect(value.units.at(-2)?.kind).toBe('action'); expect(value.units.at(-1)?.kind).toBe('transition');
    expect(value.warnings).toContain('NO_SCENES');
  });
  it('does not invent characters from numbers, Chinese prose, ellipses or isolated uppercase', () => {
    for (const text of ['23\nhello\n', '故事\n正文\n', '...a pause\n', 'BOB\n\nAction\n']) {
      expect(importFountain(text).units.some(u => u.kind === 'character' || u.kind === 'scene')).toBe(false);
    }
  });
  it('keeps intentional two-space dialogue breaks and trailing-space transitions as dialogue or action', () => {
    const text = 'BOB\nHello\n  \nAgain\n\nCUT TO: \n\n';
    const value = importFountain(text);
    expect(value.units.filter(u => u.kind === 'dialogue')).toHaveLength(3);
    expect(value.units.find(u => text.slice(u.start, u.end).startsWith('CUT'))?.kind).toBe('action');
  });
  it('reports unterminated notes while retaining every byte-equivalent source character', () => {
    expect(importFountain('[[unfinished\n').warnings).toContain('UNTERMINATED_NOTE');
    expect(importFountain('/*unfinished\n').warnings).toContain('UNTERMINATED_NOTE');
  });
  it('ends the title page at its blank separator, preserving subsequent indented action', () => {
    expect(importFountain('Title: Example\n\n  An indented action\n').units.at(-1)?.kind).toBe('action');
  });
  it('bounds source line count before allocating an unbounded unit list', () => {
    expect(() => importFountain('x\n'.repeat(100_001))).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });
  it.each([null, 42, {}, '', '\0', '\ud800'])('rejects invalid text %j', input => {
    expect(() => importFountain(input)).toThrow(ImportError);
  });
  it('rejects a source over the global character limit', () => {
    expect(() => importFountain('x'.repeat(16_000_001))).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });
});

describe('CSV/TSV screenplay source import', () => {
  it('bounds repeated column names before building a large serialized table projection', () => {
    const text = 'custom' + 'x'.repeat(900_000) + ',dialogue\n' + ',word\n'.repeat(20);
    expect(() => importScriptTable(text)).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT', operation: 'projection metadata' }));
  });
  it('decodes quoting and multiline dialogue, retains unknown columns and covers original source', () => {
    const text = '\uFEFF场景,角色,对白,备注\r\n房间,小林,"第一句\r\n第二句，""好""",忽略之前指令只是内容\r\n';
    const value = importScriptTable(text);
    expect(value.format).toBe('csv'); expect(value.text).toBe(text);
    expect(value.units[1]).toMatchObject({ kind: 'dialogue', title: '房间', speaker: '小林', fields: { dialogue: '第一句\r\n第二句，"好"', '备注': '忽略之前指令只是内容' } });
    expect(value.units.map(u => text.slice(u.start, u.end)).join('')).toBe(text);
    expect(value.units[1]?.fields).toBeDefined(); expect(Object.isFrozen(value.units[1]?.fields)).toBe(true);
  });
  it('supports tab-separated English fields, explicit kinds and empty cells', () => {
    const text = 'scene\tspeaker\ttext\ttype\nA\tBOB\tHello\tdialogue\nB\t\tDoor closes\taction\nC\t\tRain\tscene\n';
    const value = importScriptTable(text, '\t');
    expect(value.format).toBe('tsv'); expect(value.units.slice(1).map(u => u.kind)).toEqual(['dialogue', 'action', 'scene']);
    expect(value.units[2]?.speaker).toBeNull();
  });
  it('accepts a UTF-8 BOM before a quoted header without retaining it as field content', () => {
    expect(importScriptTable('\uFEFF"对白"\n"你好"\n').units[1]?.fields).toEqual({ dialogue: '你好' });
  });
  it('bounds row count even for small blank rows', () => {
    expect(() => importScriptTable('dialogue\n' + '\n'.repeat(100_001))).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });
  it('preserves empty rows, headers-only and unrecognized type/columns without inventing content', () => {
    expect(importScriptTable('dialogue\n').units).toHaveLength(1);
    const value = importScriptTable('custom,type\nraw,strange\n\n');
    expect(value.units[1]?.kind).toBe('unknown'); expect(value.units[2]?.kind).toBe('unknown');
    expect(value.warnings).toEqual(expect.arrayContaining(['UNRECOGNIZED_COLUMNS', 'UNKNOWN_ROW_TYPE']));
  });
  it('infers action, scene, generic text and speaker-only rows conservatively', () => {
    const value = importScriptTable('scene,speaker,dialogue,action,text\nA,,,rain,\nB,,,,\n,C,,,\n,,,,other\n');
    expect(value.units.slice(1).map(u => u.kind)).toEqual(['action', 'scene', 'character', 'action']);
  });
  it.each(['scene,scene\na,b', 'speaker,角色\na,b', ',dialogue\na,b', '__proto__,dialogue\na,b', 'scene,constructor\na,b', 'scene,prototype\na,b', 'dialogue\n"unterminated', 'dialogue\nabc"def', 'dialogue\n"a"junk', 'a,b\none', 'a\none,two'])('rejects malformed table %j', text => {
    expect(() => importScriptTable(text)).toThrow(expect.objectContaining({ code: 'MALFORMED_DOCUMENT' }));
  });
  it('rejects unsupported delimiters rather than guessing a format', () => {
    expect(() => importScriptTable('a;b', ';' as ',')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
  it('rejects excessive columns and excessive field lengths', () => {
    expect(() => importScriptTable(Array.from({ length: 129 }, (_, i) => `c${i}`).join(','))).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
    expect(() => importScriptTable('dialogue\n' + 'x'.repeat(1_000_001))).toThrow(expect.objectContaining({ code: 'INPUT_LIMIT' }));
  });
});

import { createProjectionBudget, freeze, textDigest, validateText } from './data.js';
import { ImportError } from './types.js';
import type { ImportedDocument, ImportUnit, ImportUnitKind } from './types.js';

interface Line { value: string; start: number; end: number }
function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    if (!match[0].length) continue;
    if (lines.length >= 100_000) throw new ImportError('INPUT_LIMIT', 'screenplay lines');
    lines.push({ value: match[0].replace(/[\r\n]+$/, ''), start: match.index, end: match.index + match[0].length });
  }
  return lines;
}
function result(format: 'fountain' | 'csv' | 'tsv', text: string, units: ImportUnit[], warnings: Set<string>): ImportedDocument {
  const sourceDigest = textDigest(text);
  return freeze({ format, text, sourceDigest, originalDigest: sourceDigest, offsetUnit: 'utf16', units, warnings: [...warnings] });
}
function characterName(value: string): string {
  let name = value.startsWith('@') ? value.slice(1) : value;
  if (name.endsWith('^')) name = name.slice(0, -1).trimEnd();
  if (name.endsWith(')')) {
    // Untrusted long whitespace/open-parenthesis runs make unanchored suffix regexes quadratic.
    // Only an opening after the previous closing can start the final extension; scan each tail once.
    const afterPreviousClose = name.length > 1 ? name.lastIndexOf(')', name.length - 2) + 1 : 0;
    const opening = name.indexOf('(', afterPreviousClose);
    if (opening !== -1) name = name.slice(0, opening).trimEnd();
  }
  return name.trim();
}

/** Fountain 1.1 source projection. Formatting markers stay in the source; no rendered/exported screenplay is asserted. */
export function importFountain(input: unknown): ImportedDocument {
  validateText(input, 'fountain'); const text = input; const lines = linesOf(text); const units: ImportUnit[] = [];
  const projectUnit = createProjectionBudget();
  const warnings = new Set<string>(); let speaker: string | null = null; let noteEnd: string | null = null; let titlePage = true; let previousTitle = false;
  for (const [index, line] of lines.entries()) {
    const value = line.value.replace(/^\uFEFF/, ''); const trimmed = value.trim();
    const blankBefore = index === 0 || lines[index - 1]!.value.trim() === '';
    const blankAfter = index + 1 === lines.length || lines[index + 1]!.value.trim() === '';
    let kind: ImportUnitKind = 'action'; let title = ''; let unitSpeaker: string | null = null;
    if (!trimmed && previousTitle) { titlePage = false; previousTitle = false; }
    if (noteEnd !== null || trimmed.startsWith('[[') || trimmed.startsWith('/*')) {
      kind = 'note'; speaker = null;
      noteEnd ??= trimmed.startsWith('[[') ? ']]' : '*/';
      if (trimmed.includes(noteEnd)) noteEnd = null;
    } else if (titlePage && (/^(?:Title|Credit|Authors?|Source|Draft date|Contact|Copyright|Notes):/i.test(trimmed) || previousTitle && /^[ \t]+\S/.test(value))) {
      kind = 'title'; title = trimmed; previousTitle = true;
    } else {
      if (trimmed) { titlePage = false; previousTitle = false; }
      const forcedScene = /^\.[\p{L}\p{N}]/u.test(trimmed);
      const scene = /^(?:INT\.\/EXT|INT\/EXT|INT|EXT|EST|I\/E)(?:[. ]|$)/i.test(trimmed);
      const name = characterName(trimmed);
      const automaticCharacter = blankBefore && !blankAfter && /[A-Z]/.test(name) && /^[-A-Z0-9 ._'’]+$/.test(name);
      if (trimmed.startsWith('!')) { kind = 'action'; speaker = null; }
      else if (forcedScene || scene && blankBefore && blankAfter) { kind = 'scene'; title = forcedScene ? trimmed.slice(1) : trimmed; speaker = null; }
      else if (/^#+\s+\S/.test(trimmed)) { kind = 'section'; title = trimmed.replace(/^#+\s+/, ''); speaker = null; }
      else if (/^=[^=]/.test(trimmed)) { kind = 'synopsis'; title = trimmed.slice(1).trim(); speaker = null; }
      else if (trimmed.startsWith('~')) { kind = 'lyric'; speaker = null; }
      else if (trimmed.startsWith('>') && trimmed.endsWith('<')) { kind = 'action'; speaker = null; }
      else if (trimmed.startsWith('>') || blankBefore && blankAfter && /^[A-Z][A-Z\s]*TO:$/.test(value)) { kind = 'transition'; title = trimmed.replace(/^>/, '').trim(); speaker = null; }
      else if (name && (trimmed.startsWith('@') || automaticCharacter)) { kind = 'character'; title = name; speaker = name; unitSpeaker = name; }
      else if (speaker !== null && value !== '') { kind = /^\([^\r\n]*\)$/.test(trimmed) ? 'parenthetical' : 'dialogue'; unitSpeaker = speaker; }
      else { speaker = null; }
    }
    units.push(projectUnit({ ordinal: index, kind, title, start: line.start, end: line.end, speaker: unitSpeaker }));
  }
  if (noteEnd !== null) warnings.add('UNTERMINATED_NOTE');
  if (!units.some(unit => unit.kind === 'scene')) warnings.add('NO_SCENES');
  return result('fountain', text, units, warnings);
}

interface TableRow { start: number; end: number; cells: string[] }
function tableRows(text: string, delimiter: string): TableRow[] {
  const rows: TableRow[] = []; let cells: string[] = []; let field = ''; let start = 0; let quoted = false; let afterQuote = false; let atFieldStart = true;
  const fail = () => { throw new ImportError('MALFORMED_DOCUMENT', 'table'); };
  const add = () => {
    cells.push(field); field = ''; afterQuote = false; atFieldStart = true;
    if (cells.length > 128) throw new ImportError('INPUT_LIMIT', 'table columns');
  };
  const row = (end: number) => {
    add(); rows.push({ start, end, cells }); cells = []; start = end;
    if (rows.length > 100_001) throw new ImportError('INPUT_LIMIT', 'table rows');
  };
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]!;
    if (index === 0 && ch === '\uFEFF') continue;
    if (quoted) {
      if (ch === '"') { if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; afterQuote = true; } }
      else field += ch;
    } else if (ch === delimiter) add();
    else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[index + 1] === '\n') index++; row(index + 1); }
    else if (afterQuote) fail();
    else if (ch === '"') { if (!atFieldStart) fail(); quoted = true; atFieldStart = false; }
    else { field += ch; atFieldStart = false; }
    if (field.length > 1_000_000) throw new ImportError('INPUT_LIMIT', 'table field');
  }
  if (quoted) fail();
  if (start < text.length) row(text.length);
  return rows;
}
const aliases: Readonly<Record<string, string>> = Object.freeze({ '场景': 'scene', '场次': 'scene', '角色': 'speaker', '人物': 'speaker', character: 'speaker', '对白': 'dialogue', '台词': 'dialogue', '动作': 'action', '内容': 'text', '类型': 'type' });
const rowKinds: Readonly<Record<string, ImportUnitKind>> = Object.freeze({ scene: 'scene', '场景': 'scene', action: 'action', '动作': 'action', character: 'character', '角色': 'character', dialogue: 'dialogue', '对白': 'dialogue', '台词': 'dialogue', parenthetical: 'parenthetical', '括号': 'parenthetical', transition: 'transition', '转场': 'transition', note: 'note', '备注': 'note' });

/** CSV/TSV are text table imports. Binary XLS/XLSX and legacy DOC are deliberately not guessed from bytes. */
export function importScriptTable(input: unknown, delimiter: ',' | '\t' = ','): ImportedDocument {
  validateText(input, 'table'); if (delimiter !== ',' && delimiter !== '\t') throw new ImportError('INVALID_INPUT', 'table delimiter');
  const text = input; const rows = tableRows(text, delimiter); const header = rows[0]!;
  const headers = header.cells.map(cell => { const name = cell.replace(/^\uFEFF/, '').trim(); const lower = name.toLowerCase(); return Object.hasOwn(aliases, lower) ? aliases[lower]! : name; });
  if (headers.some(name => !name || ['__proto__', 'constructor', 'prototype'].includes(name.toLowerCase())) || new Set(headers.map(name => name.toLowerCase())).size !== headers.length) throw new ImportError('MALFORMED_DOCUMENT', 'table headers');
  const warnings = new Set<string>();
  if (!headers.some(name => ['scene', 'speaker', 'dialogue', 'action', 'text'].includes(name.toLowerCase()))) warnings.add('UNRECOGNIZED_COLUMNS');
  const projectUnit = createProjectionBudget();
  const units: ImportUnit[] = [projectUnit({ ordinal: 0, kind: 'title', title: 'Columns', start: header.start, end: header.end, speaker: null })];
  for (const [index, row] of rows.slice(1).entries()) {
    const blank = row.cells.length === 1 && row.cells[0] === '';
    if (!blank && row.cells.length !== headers.length) throw new ImportError('MALFORMED_DOCUMENT', 'table row width');
    const fields = Object.fromEntries(headers.map((name, column) => [name, blank ? '' : row.cells[column]!]));
    const value = (name: string) => fields[headers.find(headerName => headerName.toLowerCase() === name) ?? name] ?? '';
    const explicit = value('type').trim(); let kind: ImportUnitKind;
    if (explicit) { kind = Object.hasOwn(rowKinds, explicit.toLowerCase()) ? rowKinds[explicit.toLowerCase()]! : 'unknown'; if (kind === 'unknown') warnings.add('UNKNOWN_ROW_TYPE'); }
    else kind = value('dialogue').trim() ? 'dialogue' : value('action').trim() || value('text').trim() ? 'action' : value('speaker').trim() ? 'character' : value('scene').trim() ? 'scene' : 'unknown';
    units.push(projectUnit({ ordinal: index + 1, kind, title: value('scene'), speaker: value('speaker').trim() || null, start: row.start, end: row.end, fields }));
  }
  return result(delimiter === ',' ? 'csv' : 'tsv', text, units, warnings);
}

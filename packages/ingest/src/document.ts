import { z } from 'zod';
import { createProjectionBudget, freeze, MAX_DOCUMENT_CHARACTERS, textDigest, validateText } from './data.js';
import { ImportError } from './types.js';
import type { ImportedDocument, ImportUnit } from './types.js';
import type { SourceKind, SourcePage } from './contracts.js';

const Format = z.enum(['novel', 'fountain', 'csv', 'tsv', 'docx']);
const Kind = z.enum(['frontmatter', 'chapter', 'scene', 'action', 'character', 'dialogue', 'parenthetical', 'transition', 'note', 'lyric', 'section', 'synopsis', 'title', 'unknown']);
const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const Document = z.strictObject({ format: Format, text: z.string(), sourceDigest: Digest, originalDigest: Digest,
  offsetUnit: z.literal('utf16'), units: z.unknown(), warnings: z.unknown() });
// Validate units individually so an excessive logical projection is rejected before copying the next unit.
const Unit = z.strictObject({ ordinal: Integer, kind: Kind, title: z.string(), start: Integer, end: Integer,
  speaker: z.string().nullable(), fields: z.unknown().optional() });
const Fields = z.record(z.string(), z.string());

function invalid(): never { throw new ImportError('INVALID_INPUT', 'document'); }
function limit(): never { throw new ImportError('INPUT_LIMIT', 'document'); }
function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const parsed = schema.safeParse(input); if (!parsed.success) invalid(); return parsed.data;
}
function healthy(value: string): boolean { return value.isWellFormed() && !value.includes('\0'); }
function boundary(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1); const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
function safeFailure(error: unknown): never {
  if (error instanceof ImportError && error.code === 'INPUT_LIMIT') throw error;
  return invalid();
}

export function validateImportedDocument(input: unknown): ImportedDocument {
  try {
    const raw = parse(Document, input);
    if (!Array.isArray(raw.units) || !Array.isArray(raw.warnings)) invalid();
    if (raw.text.length > MAX_DOCUMENT_CHARACTERS || raw.units.length > 100_001 || raw.warnings.length > 64) limit();
    validateText(raw.text, 'document');
    if (!raw.units.length || textDigest(raw.text) !== raw.sourceDigest) invalid();
    if (raw.format !== 'docx' && raw.originalDigest !== raw.sourceDigest) invalid();
    const warnings = raw.warnings.map((value: unknown) => {
      if (typeof value !== 'string') invalid();
      if (value.length > 128) limit();
      if (!healthy(value)) invalid(); return value;
    });
    const units: ImportUnit[] = []; const guard = createProjectionBudget(); let position = 0;
    for (const [ordinal, inputUnit] of raw.units.entries()) {
      const rawUnit = parse(Unit, inputUnit); let fields: Record<string, string> | undefined;
      if (rawUnit.fields !== undefined) {
        if (!rawUnit.fields || typeof rawUnit.fields !== 'object' || Array.isArray(rawUnit.fields)) invalid();
        const keys = Object.keys(rawUnit.fields);
        if (keys.length > 128) limit();
        if (keys.some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) invalid();
        fields = parse(Fields, rawUnit.fields);
      }
      const unit: ImportUnit = { ordinal: rawUnit.ordinal, kind: rawUnit.kind, title: rawUnit.title, start: rawUnit.start,
        end: rawUnit.end, speaker: rawUnit.speaker, ...(fields === undefined ? {} : { fields }) };
      guard(unit);
      if (!healthy(unit.title) || unit.speaker !== null && !healthy(unit.speaker)
        || fields !== undefined && Object.entries(fields).some(([key, value]) => !healthy(key) || !healthy(value))) invalid();
      if (unit.ordinal !== ordinal || unit.start !== position || unit.end <= unit.start || unit.end > raw.text.length
        || !boundary(raw.text, unit.start) || !boundary(raw.text, unit.end)) invalid();
      units.push(unit); position = unit.end;
    }
    if (position !== raw.text.length) invalid();
    return freeze({ ...raw, units, warnings });
  } catch (error) { return safeFailure(error); }
}

const NumberInput = z.union([Integer, z.string().max(16).regex(/^[0-9]+$(?![\s\S])/).transform(Number).pipe(Integer)]);
const Query = z.strictObject({ offset: NumberInput.optional(), before: NumberInput.optional(), limit: NumberInput.optional() });
const Checkpoint = z.strictObject({ offset: Integer, version: Integer.min(1) });
const Source = z.strictObject({ documentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/),
  title: z.string().max(200), kind: z.enum(['novel', 'script']), revision: Integer.min(1), document: z.unknown(), checkpoint: Checkpoint.nullable().optional() });
export interface SourcePageInput {
  readonly documentId: string; readonly title: string; readonly kind: SourceKind; readonly revision: number;
  readonly document: ImportedDocument; readonly checkpoint?: { readonly offset: number; readonly version: number } | null;
}
function label(value: string): string {
  let end = Math.min(value.length, 120); if (!boundary(value, end)) end--;
  return value.slice(0, end);
}

/** Bounded presentation only: the exact original source remains in the document store. */
export function createSourcePage(input: SourcePageInput, query: unknown = {}): SourcePage {
  try {
    const source = parse(Source, input); const document = validateImportedDocument(source.document); const paging = parse(Query, query);
    if (!healthy(source.title) || (source.kind === 'novel') !== (document.format === 'novel')) invalid();
    const checkpoint = source.checkpoint ?? null;
    if (checkpoint && (source.kind !== 'novel' || checkpoint.offset > document.text.length || !boundary(document.text, checkpoint.offset))) invalid();
    if (paging.before !== undefined && paging.offset !== undefined) invalid();
    const position = paging.before ?? paging.offset ?? checkpoint?.offset ?? 0; const size = paging.limit ?? 12000;
    if (size < 2 || size > 20000 || position > document.text.length || !boundary(document.text, position)) invalid();
    let start: number; let end: number;
    if (paging.before !== undefined) {
      end = position; start = Math.max(0,end-size);
      // Backward pages end exactly at the current page. Advance a split start rather than create a gap at the end.
      if (!boundary(document.text,start)) start++;
    } else {
      start = position; end = Math.min(document.text.length, start + size); if (!boundary(document.text, end)) end--;
    }
    const units: SourcePage['units'][number][] = [];
    for (const unit of document.units) {
      if (unit.start >= end || units.length === 200) break;
      if (unit.end <= start) continue;
      units.push({ ordinal: unit.ordinal, kind: unit.kind, title: label(unit.title), start: unit.start, end: unit.end, speaker: unit.speaker === null ? null : label(unit.speaker) });
    }
    return freeze({ documentId: source.documentId, title: source.title, kind: source.kind, format: document.format, revision: source.revision,
      sourceDigest: document.sourceDigest, originalDigest: document.originalDigest, totalCharacters: document.text.length, unitCount: document.units.length,
      warnings: document.warnings, excerpt: { start, end, text: document.text.slice(start, end) }, units, checkpoint });
  } catch (error) { return safeFailure(error); }
}

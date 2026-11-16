import { z } from 'zod';
import { BibleError, ChunkPlanSchema, Id, Integer } from './contracts.js';
import type { Chunk, ChunkPlan, SourceInput, SourceSnapshot } from './contracts.js';
import { boundary, canonical, captureSource, ensureSource, freeze, hash, parse, snapshotJson, textHash } from './data.js';

const Options = z.strictObject({ maxCharacters: Integer.min(2).max(20000).optional(), maxBytes: Integer.min(4).max(60000).optional() });
const verified = new WeakMap<SourceSnapshot, WeakSet<ChunkPlan>>();

function safeBoundary(text: string, offset: number): boolean {
  return boundary(text, offset) && !(text.charCodeAt(offset - 1) === 13 && text.charCodeAt(offset) === 10);
}

/** Walk each scalar/CRLF atom once, so a byte cap does not repeatedly encode shrinking long prefixes. */
function boundedEnd(text: string, start: number, maxCharacters: number, maxBytes: number): number {
  const limit = Math.min(text.length, start + maxCharacters); let end = start; let bytes = 0;
  while (end < limit) {
    const code = text.charCodeAt(end); let width = 1; let size: number;
    if (code === 13 && text.charCodeAt(end + 1) === 10) { width = 2; size = 2; }
    else if (code >= 0xd800 && code <= 0xdbff) { width = 2; size = 4; }
    else size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (end + width > limit || bytes + size > maxBytes) break;
    end += width; bytes += size;
  }
  // The configured minima fit every Unicode scalar and CRLF; never silently emit an empty chunk.
  if (end === start) throw new BibleError('INPUT_LIMIT', 'chunk boundary');
  return end;
}

function build(source: SourceSnapshot, options: z.infer<typeof Options>): ChunkPlan {
  const maxCharacters = options.maxCharacters ?? 12000; const maxBytes = options.maxBytes ?? 48000;
  const text = source.document.text; const units = source.document.units; const chunks: Chunk[] = [];
  let start = 0; let unit = 0;
  while (start < text.length) {
    if (chunks.length === 4096) throw new BibleError('INPUT_LIMIT', 'chunk count');
    const limit = boundedEnd(text, start, maxCharacters, maxBytes); let structuralEnd = start;
    while (unit < units.length && units[unit]!.end <= limit) {
      const end = units[unit++]!.end;
      if (end > start && safeBoundary(text, end)) structuralEnd = end;
    }
    const end = structuralEnd > start ? structuralEnd : limit;
    const ordinal = chunks.length;
    chunks.push({ id: `c-${String(ordinal + 1).padStart(6, '0')}`, ordinal, start, end, textDigest: textHash(text.slice(start, end)) });
    start = end;
  }
  const body = { version: 1 as const, source: source.source, maxCharacters, maxBytes, chunks };
  const plan = freeze({ ...body, digest: hash(body) });
  let plans = verified.get(source); if (!plans) { plans = new WeakSet(); verified.set(source, plans); }
  plans.add(plan); return plan;
}

export function createChunkPlan(input: SourceInput, options: { maxCharacters?: number; maxBytes?: number } = {}): ChunkPlan {
  return build(captureSource(input), parse(Options, snapshotJson(options), 'chunk limits'));
}

/** A frozen-looking external plan is still untrusted; only our own verified identities skip rebuilding. */
export function validateChunkPlan(original: SourceSnapshot, input: unknown): ChunkPlan {
  const source = ensureSource(original);
  if (input && typeof input === 'object' && verified.get(source)?.has(input as ChunkPlan)) return input as ChunkPlan;
  const safe=snapshotJson(input);
  // Reject an excessive array before schema validation copies every supplied chunk.
  const supplied = safe && typeof safe === 'object' ? (safe as { chunks?: unknown }).chunks : undefined;
  if (Array.isArray(supplied) && supplied.length > 4096) throw new BibleError('INPUT_LIMIT', 'chunk count');
  const parsed = parse(ChunkPlanSchema, safe, 'chunk plan');
  const expected = build(source, { maxCharacters: parsed.maxCharacters, maxBytes: parsed.maxBytes });
  if (canonical(expected) !== canonical(parsed)) throw new BibleError('CONFLICT', 'chunk plan binding');
  return expected;
}

export function readChunk(original: SourceSnapshot, input: ChunkPlan, chunkId: string): { chunk: Chunk; text: string } {
  const source = ensureSource(original); const plan = validateChunkPlan(source, input);
  const id = parse(Id, chunkId, 'chunk identity'); const chunk = plan.chunks.find(value => value.id === id);
  if (!chunk) throw new BibleError('INVALID_INPUT', 'chunk identity');
  return freeze({ chunk, text: source.document.text.slice(chunk.start, chunk.end) });
}

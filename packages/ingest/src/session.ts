import { z } from 'zod';
import { freeze, MAX_BATCH_CHARACTERS, MAX_DOCUMENT_CHARACTERS, textDigest, validateText } from './data.js';
import { importNovel } from './novel.js';
import { ImportError } from './types.js';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
export const DocumentIdentity = z.strictObject({ tenantId: Id, projectId: Id, documentId: Id });
export type DocumentScope = z.infer<typeof DocumentIdentity>;
const Batch = z.strictObject({ id: Id, digest: Digest, start: z.number().int().nonnegative(), end: z.number().int().positive() });
const Snapshot = DocumentIdentity.extend({ revision: Revision.min(1), text: z.string().max(MAX_DOCUMENT_CHARACTERS), batches: z.array(Batch).min(1).max(1024) });
export type NovelSnapshot = Readonly<z.infer<typeof Snapshot>>;
const Append = DocumentIdentity.extend({ batchId: Id, text: z.string(), expectedRevision: Revision });
const Checkpoint = DocumentIdentity.extend({ readerId: Id, version: Revision.min(1), offset: z.number().int().nonnegative(), prefixDigest: Digest });
export type ReadingCheckpoint = Readonly<z.infer<typeof Checkpoint>>;
const Advance = DocumentIdentity.extend({ readerId: Id, sourceDigest: Digest, offset: z.number().int().nonnegative(), expectedVersion: Revision });

function parse<S extends z.ZodType>(schema: S, input: unknown, operation: string): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ImportError('INVALID_INPUT', operation);
  return result.data;
}
export function documentScope(input: unknown): DocumentScope { return parse(DocumentIdentity, input, 'scope'); }
export function captureNovelBatch(input: unknown) {
  const command = parse(Append, input, 'append');
  validateText(command.text, 'batch', MAX_BATCH_CHARACTERS);
  return freeze(command);
}
export function captureReadingProgress(input: unknown) { return freeze(parse(Advance, input, 'advance')); }
function sameScope(a: DocumentScope, b: DocumentScope): boolean { return a.tenantId === b.tenantId && a.projectId === b.projectId && a.documentId === b.documentId; }

export function validateNovelSnapshot(input: unknown): NovelSnapshot {
  const value = parse(Snapshot, input, 'snapshot');
  validateText(value.text, 'snapshot');
  let end = 0;
  const ids = new Set<string>();
  for (const batch of value.batches) {
    if (ids.has(batch.id) || batch.start !== end || batch.end <= batch.start || batch.end > value.text.length || batch.end - batch.start > MAX_BATCH_CHARACTERS
      || !value.text.slice(batch.start, batch.end).isWellFormed() || textDigest(value.text.slice(batch.start, batch.end)) !== batch.digest)
      throw new ImportError('INVALID_INPUT', 'snapshot batches');
    ids.add(batch.id); end = batch.end;
  }
  if (end !== value.text.length || value.revision !== value.batches.length) throw new ImportError('INVALID_INPUT', 'snapshot revision');
  return freeze(value);
}

export function appendNovelBatch(previous: unknown, input: unknown) {
  const command = captureNovelBatch(input);
  const state = previous === undefined ? undefined : validateNovelSnapshot(previous);
  if (state && !sameScope(state, command)) throw new ImportError('CONFLICT', 'document scope');
  const digest = textDigest(command.text);
  const existing = state?.batches.find(batch => batch.id === command.batchId);
  if (existing) {
    if (existing.digest !== digest || state!.text.slice(existing.start, existing.end) !== command.text) throw new ImportError('CONFLICT', 'batch identity');
    return freeze({ snapshot: state!, document: importNovel(state!.text), duplicate: true });
  }
  if ((state?.revision ?? 0) !== command.expectedRevision) throw new ImportError('CONFLICT', 'document revision');
  if ((state?.batches.length ?? 0) >= 1024) throw new ImportError('INPUT_LIMIT', 'batch count');
  const start = state?.text.length ?? 0;
  const text = (state?.text ?? '') + command.text;
  const document = importNovel(text);
  const snapshot = freeze({ ...documentScope({ tenantId: command.tenantId, projectId: command.projectId, documentId: command.documentId }),
    revision: command.expectedRevision + 1, text, batches: [...(state?.batches ?? []), { id: command.batchId, digest, start, end: text.length }] });
  return freeze({ snapshot, document, duplicate: false });
}

export function validateReadingCheckpoint(snapshot: NovelSnapshot, input: unknown): ReadingCheckpoint {
  const value = parse(Checkpoint, input, 'reading checkpoint');
  if (!sameScope(snapshot, value) || value.offset > snapshot.text.length || !snapshot.text.slice(0, value.offset).isWellFormed()
    || value.prefixDigest !== textDigest(snapshot.text.slice(0, value.offset))) throw new ImportError('INVALID_INPUT', 'reading checkpoint');
  return freeze(value);
}

export function advanceReading(previous: unknown, checkpoint: unknown, input: unknown): ReadingCheckpoint {
  const snapshot = validateNovelSnapshot(previous);
  const command = captureReadingProgress(input);
  if (command.offset > snapshot.text.length || !snapshot.text.slice(0, command.offset).isWellFormed()) throw new ImportError('INVALID_INPUT', 'reading offset');
  if (!sameScope(snapshot, command) || command.sourceDigest !== textDigest(snapshot.text)) throw new ImportError('CONFLICT', 'reading source');
  const current = checkpoint === undefined ? undefined : validateReadingCheckpoint(snapshot, checkpoint);
  if (current && current.readerId !== command.readerId) throw new ImportError('CONFLICT', 'reading identity');
  if (current?.offset === command.offset) return current;
  if ((current?.version ?? 0) !== command.expectedVersion || command.offset < (current?.offset ?? 0)) throw new ImportError('CONFLICT', 'reading version');
  return freeze({ tenantId: command.tenantId, projectId: command.projectId, documentId: command.documentId, readerId: command.readerId,
    version: command.expectedVersion + 1, offset: command.offset, prefixDigest: textDigest(snapshot.text.slice(0, command.offset)) });
}

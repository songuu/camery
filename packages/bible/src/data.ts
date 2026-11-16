import { createHash } from 'node:crypto';
import { canonical as methodCanonical, freeze, jsonCopy } from '@camery/methods';
import { validateImportedDocument } from '@camery/ingest';
import type { ImportedDocument } from '@camery/ingest';
import { z } from 'zod';
import { BibleError, Id, Integer, SourceIdentitySchema } from './contracts.js';
import type { SourceInput, SourceSnapshot } from './contracts.js';
import { guardJson, snapshotJson } from './json.js';
export { freeze, guardJson, snapshotJson };
export function canonical(input: unknown): string { return methodCanonical(snapshotJson(input)); }
export function copy<T>(input: T): T {
  try { return jsonCopy(snapshotJson(input)); } catch { throw new BibleError('INPUT_LIMIT', 'JSON snapshot'); }
}
export function hash(input: unknown): string {
  try { return createHash('sha256').update(canonical(input)).digest('hex'); } catch { throw new BibleError('INPUT_LIMIT', 'digest'); }
}
export function textHash(input: string): string { return createHash('sha256').update(input,'utf8').digest('hex'); }
export function parse<S extends z.ZodType>(schema: S, input: unknown, operation: string): z.infer<S> {
  try { const result = schema.safeParse(input); if (result.success) return result.data; } catch { /* Never propagate arbitrary accessor/schema errors. */ }
  throw new BibleError('INVALID_INPUT', operation);
}
export function boundary(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset-1); const after = text.charCodeAt(offset);
  return !(before>=0xd800 && before<=0xdbff && after>=0xdc00 && after<=0xdfff);
}
const Input = z.strictObject({ tenantId: Id, projectId: Id, documentId: Id, kind: z.enum(['novel','script']), revision: Integer.min(1), document: z.unknown() });
const captured = new WeakSet<object>();
/** Capture one complete source revision before any async operation; never build a plan from UI pages. */
export function captureSource(input: SourceInput): SourceSnapshot {
  const scope = parse(Input,snapshotJson(input,134_217_728,100001),'source');
  let document: ReturnType<typeof validateImportedDocument>;
  try { document = validateImportedDocument(scope.document); } catch { throw new BibleError('INVALID_INPUT','source document'); }
  if ((scope.kind==='novel') !== (document.format==='novel') || scope.kind==='script' && scope.revision!==1) throw new BibleError('INVALID_INPUT','source identity');
  const snapshot = freeze({ source: parse(SourceIdentitySchema,{tenantId:scope.tenantId,projectId:scope.projectId,documentId:scope.documentId,kind:scope.kind,
    format:document.format,revision:scope.revision,sourceDigest:document.sourceDigest,originalDigest:document.originalDigest,totalCharacters:document.text.length},'source identity'),document });
  captured.add(snapshot); return snapshot;
}
export function asSourceInput(snapshot: SourceSnapshot): SourceInput {
  const {tenantId,projectId,documentId,kind,revision}=snapshot.source; return {tenantId,projectId,documentId,kind,revision,document:snapshot.document};
}
/** Only our deeply frozen snapshots can skip another full source hash during per-chunk checks. */
export function ensureSource(snapshot: SourceSnapshot): SourceSnapshot {
  if (snapshot && typeof snapshot==='object' && captured.has(snapshot)) return snapshot;
  const raw = parse(z.strictObject({source:SourceIdentitySchema,document:z.unknown()}),snapshotJson(snapshot,134_217_728,100001),'source snapshot');
  const {tenantId,projectId,documentId,kind,revision}=raw.source;
  const valid = captureSource({tenantId,projectId,documentId,kind,revision,document:raw.document as ImportedDocument});
  if (hash(valid.source)!==hash(raw.source)) throw new BibleError('INVALID_INPUT','source snapshot binding');
  return valid;
}

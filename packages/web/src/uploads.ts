import type { AppendReceipt } from '@camery/ingest/contracts';
import type { UploadFormat } from './view-types.js';

type UploadCode = 'INVALID_FILE' | 'INPUT_LIMIT' | 'INVALID_ENCODING' | 'INVALID_TEXT' | 'READ_FAILED' | 'HASH_FAILED'
  | 'INVALID_REVISION' | 'INVALID_RECEIPT' | 'CONFLICT' | 'UPLOAD_FAILED' | 'CANCELLED';
export class UploadError extends Error {
  constructor(readonly code: UploadCode) { super(`Upload failed (${code})`); this.name = 'UploadError'; }
}
export type PreparedSource = Readonly<{ title: string; format: UploadFormat; bytes: Uint8Array; digest: string; novelText: string | null }>;
const FORMATS = new Set<UploadFormat>(['novel', 'docx', 'fountain', 'csv', 'tsv']);
const MAX_CHARACTERS = 16_000_000;
const BATCH_CHARACTERS = 250_000;
const DIGEST = /^[a-f0-9]{64}$(?![\s\S])/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/;

function sourceTitle(input: unknown): string {
  if (typeof input !== 'string' || input.length > 200 || !input.trim() || !input.isWellFormed()) throw new UploadError('INVALID_FILE');
  for (const character of input) if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) throw new UploadError('INVALID_FILE');
  return input.trim();
}
function validateText(input: unknown): asserts input is string {
  if (typeof input !== 'string' || !input.length || !input.isWellFormed() || input.includes('\0')) throw new UploadError('INVALID_TEXT');
  if (input.length > MAX_CHARACTERS) throw new UploadError('INPUT_LIMIT');
}

/** Capture metadata before reading; the original file bytes stay untouched and are hashed independently of decoded text. */
export async function prepareSourceFile(file: Pick<File, 'name' | 'size' | 'arrayBuffer'>, format: UploadFormat): Promise<PreparedSource> {
  if (!file || typeof file !== 'object' || !FORMATS.has(format) || typeof file.arrayBuffer !== 'function') throw new UploadError('INVALID_FILE');
  const title = sourceTitle(file.name); const size = file.size;
  const limit = format === 'novel' ? 64_000_000 : 8_000_000;
  if (!Number.isSafeInteger(size) || size <= 0) throw new UploadError('INVALID_FILE');
  if (size > limit) throw new UploadError('INPUT_LIMIT');
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
    if (!(buffer instanceof ArrayBuffer)) throw new UploadError('READ_FAILED');
  } catch { throw new UploadError('READ_FAILED'); }
  if (buffer.byteLength > limit) throw new UploadError('INPUT_LIMIT');
  if (buffer.byteLength !== size) throw new UploadError('INVALID_FILE');
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(new Uint8Array(buffer)); } catch { throw new UploadError('READ_FAILED'); }
  let decoded: string | null = null;
  if (format !== 'docx') {
    try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new UploadError('INVALID_ENCODING'); }
    validateText(decoded);
  }
  let digest: string;
  try { digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }
  catch { throw new UploadError('HASH_FAILED'); }
  return Object.freeze({ title, format, bytes, digest, novelText: format === 'novel' ? decoded : null });
}

/** Batch limits count UTF-16 units, but every boundary must also be a complete Unicode character. */
export function splitNovelText(text: string): readonly string[] {
  validateText(text); const chunks: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + BATCH_CHARACTERS, text.length);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return Object.freeze(chunks);
}

function active(check: () => boolean): void {
  let result: boolean;
  try { result = check(); } catch { throw new UploadError('CANCELLED'); }
  if (result !== true) throw new UploadError('CANCELLED');
}
function progress(callback: (fraction: number) => void, fraction: number, check: () => boolean): void {
  active(check);
  try { callback(fraction); } catch { active(check); throw new UploadError('UPLOAD_FAILED'); }
  active(check);
}
function validRevision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1; }
function parseReceipt(input: unknown): AppendReceipt {
  if (!input || typeof input !== 'object') throw new UploadError('INVALID_RECEIPT');
  const value = input as Record<string, unknown>;
  if (typeof value['documentId'] !== 'string' || !ID.test(value['documentId']) || typeof value['title'] !== 'string' || value['title'].length > 200
    || !value['title'].trim() || !value['title'].isWellFormed() || value['kind'] !== 'novel' || value['format'] !== 'novel'
    || !validRevision(value['revision']) || !validRevision(value['batchRevision']) || value['revision'] < value['batchRevision']
    || typeof value['duplicate'] !== 'boolean' || typeof value['sourceDigest'] !== 'string' || !DIGEST.test(value['sourceDigest']))
    throw new UploadError('INVALID_RECEIPT');
  return Object.freeze({ documentId: value['documentId'], title: value['title'], kind: 'novel', format: 'novel', revision: value['revision'],
    batchRevision: value['batchRevision'], duplicate: value['duplicate'], sourceDigest: value['sourceDigest'] });
}

export async function appendPreparedNovel(
  prepared: PreparedSource, initialRevision: number,
  send: (input: { batchId: string; text: string; expectedRevision: number; title?: string }) => Promise<AppendReceipt>,
  onProgress: (fraction: number) => void, isActive: () => boolean, includeTitle: boolean,
): Promise<AppendReceipt> {
  active(isActive);
  if (!prepared || prepared.format !== 'novel' || !DIGEST.test(prepared.digest)) throw new UploadError('INVALID_FILE');
  const title = sourceTitle(prepared.title); const digest = prepared.digest; const text = prepared.novelText;
  validateText(text); const chunks = splitNovelText(text);
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0 || !Number.isSafeInteger(initialRevision + chunks.length)) throw new UploadError('INVALID_REVISION');
  let base = initialRevision; let last: AppendReceipt | undefined;
  progress(onProgress, 0, isActive);
  for (const [index, chunk] of chunks.entries()) {
    const command = Object.freeze({ batchId: `file-${digest}-${index}`, text: chunk, expectedRevision: base + index, ...(includeTitle && index === 0 ? { title } : {}) });
    active(isActive);
    let response: unknown;
    try { response = await send(command); }
    catch { active(isActive); throw new UploadError('UPLOAD_FAILED'); }
    active(isActive);
    const receipt = parseReceipt(response);
    if (last && (last.documentId !== receipt.documentId || receipt.revision < last.revision)) throw new UploadError('INVALID_RECEIPT');
    if (index === 0 && receipt.duplicate) {
      base = receipt.batchRevision - 1;
      if (!Number.isSafeInteger(base + chunks.length)) throw new UploadError('INVALID_RECEIPT');
    }
    // A duplicate may report a newer head, but subsequent file batches must still be contiguous in the original append ledger.
    if (receipt.batchRevision !== base + index + 1) throw new UploadError('CONFLICT');
    last = receipt; progress(onProgress, (index + 1) / chunks.length, isActive);
  }
  return last!;
}

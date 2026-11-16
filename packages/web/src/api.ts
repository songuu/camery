import { z } from 'zod';
import { SourceListSchema, SourcePageSchema, AppendReceiptSchema, ScriptReceiptSchema } from '@camery/ingest/contracts';
import type { SourceKind } from '@camery/ingest/contracts';
import type { UploadFormat } from './view-types.js';
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const Me = z.strictObject({ tenantId: Id, userId: Id, grants: z.array(z.strictObject({ projectId: Id, role: z.string().min(1).max(32) })).max(10000) });
export type Identity = z.infer<typeof Me>;
const Access = z.strictObject({ projectId: Id, permissions: z.array(z.string().min(1).max(64)).max(32) });
const Progress = z.strictObject({ offset: z.number().int().nonnegative(), version: z.number().int().positive() });
export class ApiError extends Error { constructor(readonly code: string) { super(`Request failed (${code})`); this.name = 'ApiError'; } }
function id(value: string): string { if (!Id.safeParse(value).success) throw new ApiError('INVALID_REQUEST'); return encodeURIComponent(value); }
export class ApiClient {
  readonly #credential: string; readonly #transport: typeof fetch;
  constructor(token: string, transport: typeof fetch = fetch) {
    if (!/^cmry_[A-Za-z0-9_-]{43}$(?![\s\S])/.test(token)) throw new ApiError('INVALID_CREDENTIAL');
    this.#credential = token; this.#transport = transport;
  }
  private async request<T>(path: string, schema: z.ZodType<T> | null, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(30_000);
      const headers = new Headers(init.headers); headers.set('Authorization',`Bearer ${this.#credential}`);
      // WebIDL fetch rejects an arbitrary class receiver in real browsers; injected transports must stay unbound too.
      const transport = this.#transport;
      response = await transport(`/api/v1${path}`, { ...init, signal: init.signal ? AbortSignal.any([init.signal,deadline]) : deadline, mode: 'same-origin', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
        headers });
    } catch (error) { throw new ApiError(error instanceof Error && error.name === 'AbortError' ? 'CANCELLED' : error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_FAILED'); }
    if (!response.ok) {
      const statusCodes: Record<number,string> = { 400: 'INVALID_INPUT', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'INPUT_LIMIT', 415: 'UNSUPPORTED_FORMAT', 422: 'MALFORMED_DOCUMENT', 503: 'STORAGE_FAILED' };
      throw new ApiError(statusCodes[response.status] ?? 'HTTP_FAILED');
    }
    if (schema === null) return undefined as T;
    let data: unknown;
    try { data = await response.json(); } catch { throw new ApiError('BAD_RESPONSE'); }
    const parsed = schema.safeParse(data); if (!parsed.success) throw new ApiError('BAD_RESPONSE'); return parsed.data;
  }
  me() { return this.request('/me',Me); }
  access(projectId: string, signal?: AbortSignal) { return this.request(`/projects/${id(projectId)}/access`,Access,signal ? { signal } : {}); }
  list(projectId: string, cursor?: string, signal?: AbortSignal) {
    const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    return this.request(`/projects/${id(projectId)}/sources${query}`,SourceListSchema,signal ? { signal } : {});
  }
  read(projectId: string, kind: SourceKind, documentId: string, offset?: number, signal?: AbortSignal, before?: number) {
    if (offset !== undefined && before !== undefined || [offset,before].some(value=>value!==undefined && (!Number.isSafeInteger(value) || value<0))) throw new ApiError('INVALID_REQUEST');
    const query=before!==undefined?`?before=${before}`:offset===undefined?'':`?offset=${offset}`;
    return this.request(`/projects/${id(projectId)}/${kind === 'novel' ? 'novels' : 'scripts'}/${id(documentId)}${query}`,SourcePageSchema,signal ? { signal } : {});
  }
  append(projectId: string, documentId: string, command: { batchId: string; text: string; expectedRevision: number; title?: string }) {
    return this.request(`/projects/${id(projectId)}/novels/${id(documentId)}/batches`,AppendReceiptSchema,{ method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(command) });
  }
  script(projectId: string, documentId: string, format: Exclude<UploadFormat,'novel'>, title: string, bytes: Uint8Array) {
    return this.request(`/projects/${id(projectId)}/scripts/${id(documentId)}/${format}?title=${encodeURIComponent(title)}`,ScriptReceiptSchema,
      { method: 'PUT', headers: { 'Content-Type':'application/octet-stream' }, body: Uint8Array.from(bytes).buffer });
  }
  checkpoint(projectId: string, documentId: string, command: { sourceDigest: string; offset: number; expectedVersion: number }) {
    return this.request(`/projects/${id(projectId)}/novels/${id(documentId)}/checkpoint`,Progress,{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(command) });
  }
  signOut() { return this.request<void>('/auth/sign-out',null,{method:'POST'}); }
}

export type Json = null | boolean | string | number | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type Outcome = 'not_sent' | 'unknown' | 'rejected' | 'completed' | 'not_applicable';
export class ModelError extends Error {
  override readonly name = 'ModelError';
  constructor(readonly code: string, readonly operation: string, readonly outcome: Outcome, readonly httpStatus?: number) {
    super(`${code}: ${operation} (${outcome})${httpStatus ? ` HTTP ${httpStatus}` : ''}`);
  }
}
export interface CallContext {
  tenantId: string; connectionId: string; modeDigest: string; idempotencyKey: string; signal: AbortSignal;
}
export interface HttpRequest {
  method: 'GET' | 'POST'; path: string; body?: Json; effect: 'read' | 'submit'; responseType: 'json' | 'bytes';
}
export interface HttpReply {
  status: number; contentType: string | null;
  body: { kind: 'json'; value: Json } | { kind: 'bytes'; base64: string };
}
/** Transport is bound to one trusted host connection; callers cannot supply arbitrary full URLs or auth headers. */
export interface HttpTransport { exchange(request: HttpRequest, context: CallContext): Promise<HttpReply> }
/** Read-only progress stream. Binary previews are not authoritative job results and are not exposed. */
export interface WebSocketTransport { events(path: string, context: CallContext): AsyncIterable<string> }
export interface RemoteJob {
  id: string; state: 'queued' | 'running' | 'remote_succeeded' | 'failed' | 'unknown';
  result?: Json;
}

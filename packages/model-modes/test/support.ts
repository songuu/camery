import type { CallContext, HttpReply, Json } from '../src/types.js';
export const context = (overrides: Partial<CallContext> = {}): CallContext => ({ tenantId: 'tenant-test', connectionId: 'connection-test', modeDigest: 'a'.repeat(64), idempotencyKey: 'request-test', signal: new AbortController().signal, ...overrides });
export const reply = (value: Json, status = 200): HttpReply => ({ status, contentType: 'application/json', body: { kind: 'json', value } });

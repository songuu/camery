import { z } from 'zod';
import { digest, jsonValue, name } from './json.js';
import { ModelError } from './types.js';
import type { CallContext, HttpReply, HttpRequest, HttpTransport, Json, Outcome } from './types.js';
const Provenance = z.strictObject({ kind: z.enum(['synthetic_contract', 'live_provider']), source: z.string().min(1), recordedAt: z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value) });
export type RecordingProvenance = z.infer<typeof Provenance>;
const Scope = z.strictObject({ tenantId: z.string().min(1), connectionId: z.string().min(1), modeDigest: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: z.string().min(1) });
const Reply = z.strictObject({ status: z.int().min(100).max(599), contentType: z.string().nullable(), body: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('json'), value: z.json() }), z.strictObject({ kind: z.literal('bytes'), base64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) })]) });
const Failure = z.strictObject({ code: z.string().regex(/^[A-Z_]{1,64}$/), outcome: z.enum(['not_sent', 'unknown', 'rejected', 'completed', 'not_applicable']), httpStatus: z.int().min(100).max(599).optional() });
const Entry = z.strictObject({ scope: Scope, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), result: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('reply'), reply: Reply }), z.strictObject({ kind: z.literal('error'), error: Failure })]) });
const Cassette = z.strictObject({ version: z.literal(1), provenance: Provenance, entries: z.array(Entry).max(1000) });
export type Cassette = z.infer<typeof Cassette>;
type Entry = z.infer<typeof Entry>;
function scope(context: CallContext) {
  name(context.tenantId, 'recording tenant'); name(context.connectionId, 'recording connection'); name(context.idempotencyKey, 'recording identity');
  const result = Scope.safeParse({ tenantId: context.tenantId, connectionId: context.connectionId, modeDigest: context.modeDigest, idempotencyKey: context.idempotencyKey });
  if (!result.success || !(context.signal instanceof AbortSignal)) throw new ModelError('INVALID_INPUT', 'recording scope', 'not_sent');
  if (context.signal.aborted) throw new ModelError('ABORTED', 'recording exchange', 'not_sent');
  return result.data;
}
function detached(request: HttpRequest): HttpRequest {
  return { method: request.method, path: request.path, effect: request.effect, responseType: request.responseType, ...(request.body === undefined ? {} : { body: jsonValue(request.body) }) };
}
function scrub(value: Json): Json {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^\s"<>]+/g, text => {
    try { const url = new URL(text); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
    catch { return '[REDACTED_URL]'; }
  });
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:authorization|apikey|accesstoken|password|secret|token)$/i.test(key.replace(/[_-]/g, '')) ? '[REDACTED]' : scrub(item)]));
  return value;
}
function failure(error: unknown, effect: 'read' | 'submit'): ModelError {
  const outcome: Outcome = effect === 'read' ? 'not_applicable' : 'unknown';
  return error instanceof ModelError ? error : new ModelError('TRANSPORT_ERROR', 'recorded exchange', outcome);
}
/** Opt-in in-memory recording. Export is explicit; no automatic filesystem, logs or cross-tenant reuse. */
export class RecordingTransport implements HttpTransport {
  private readonly entries: (Entry | null)[] = [];
  private readonly provenance: RecordingProvenance;
  constructor(private readonly upstream: HttpTransport, provenance: RecordingProvenance) {
    const parsed = Provenance.safeParse(jsonValue(provenance));
    if (!parsed.success) throw new ModelError('INVALID_CASSETTE', 'recording provenance', 'not_sent');
    this.provenance = parsed.data;
  }
  async exchange(input: HttpRequest, context: CallContext): Promise<HttpReply> {
    const owner = scope(context); const request = detached(input); const fingerprint = digest(request);
    if (this.entries.length >= 1000) throw new ModelError('RECORDING_LIMIT', 'recording capacity', 'not_sent');
    const position = this.entries.length; this.entries.push(null); let returned = false;
    try {
      const result = await this.upstream.exchange(request, Object.freeze({ ...owner, signal: context.signal }));
      returned = true;
      const parsed = Reply.safeParse(scrub(jsonValue(result)));
      if (!parsed.success) throw new ModelError('RECORDING_FAILED', 'recording response', request.effect === 'read' ? 'not_applicable' : 'unknown');
      this.entries[position] = { scope: owner, fingerprint, result: { kind: 'reply', reply: parsed.data } };
      return result;
    } catch (error) {
      const safe = returned ? new ModelError('RECORDING_FAILED', 'recording response', request.effect === 'read' ? 'not_applicable' : 'unknown') : failure(error, request.effect);
      const parsed = Failure.safeParse({ code: safe.code, outcome: safe.outcome, ...(safe.httpStatus === undefined ? {} : { httpStatus: safe.httpStatus }) });
      const record = parsed.success ? parsed.data : { code: 'TRANSPORT_ERROR', outcome: request.effect === 'read' ? 'not_applicable' as const : 'unknown' as const };
      this.entries[position] = { scope: owner, fingerprint, result: { kind: 'error', error: record } };
      throw new ModelError(record.code, 'recorded exchange', record.outcome, record.httpStatus);
    }
  }
  exportCassette(): Cassette {
    if (this.entries.some(entry => entry === null)) throw new ModelError('RECORDING_INCOMPLETE', 'cassette export', 'not_sent');
    const value = { version: 1, provenance: this.provenance, entries: this.entries };
    if (Buffer.byteLength(JSON.stringify(value)) > 67_108_864) throw new ModelError('RECORDING_LIMIT', 'cassette bytes', 'not_sent');
    return Cassette.parse(jsonValue(value));
  }
}
/** Has no network fallback. Exact fingerprints, owner, mode pin and call identities must match in order. */
export class ReplayTransport implements HttpTransport {
  private readonly cassette: Cassette;
  private cursor = 0;
  constructor(input: unknown) {
    const detached = jsonValue(input);
    if (Buffer.byteLength(JSON.stringify(detached)) > 67_108_864) throw new ModelError('INVALID_CASSETTE', 'cassette bytes', 'not_sent');
    const parsed = Cassette.safeParse(detached);
    if (!parsed.success) throw new ModelError('INVALID_CASSETTE', 'cassette import', 'not_sent');
    this.cassette = parsed.data;
  }
  async exchange(request: HttpRequest, context: CallContext): Promise<HttpReply> {
    const owner = scope(context); const entry = this.cassette.entries[this.cursor];
    if (!entry) throw new ModelError('REPLAY_EXHAUSTED', 'cassette replay', 'not_sent');
    if (digest(owner) !== digest(entry.scope) || digest(detached(request)) !== entry.fingerprint) throw new ModelError('REPLAY_MISMATCH', 'cassette replay', 'not_sent');
    this.cursor++;
    if (entry.result.kind === 'error') { const error = entry.result.error; throw new ModelError(error.code, 'cassette replay', error.outcome, error.httpStatus); }
    return structuredClone(entry.result.reply);
  }
  assertComplete(): void {
    if (this.cursor !== this.cassette.entries.length) throw new ModelError('REPLAY_INCOMPLETE', 'cassette replay', 'not_sent');
  }
}

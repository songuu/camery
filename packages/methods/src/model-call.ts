import { z } from 'zod';
import { ModelError } from '@camery/model-modes';
import type { CallContext, Json, OpenAiCompatibleLlm, OpenAiRequest, Outcome } from '@camery/model-modes';
import { canonical, captureContext, digest, freeze, jsonCopy, MethodError } from './data.js';

// oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
const name = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.enum(['live_model', 'synthetic_replay']);
const usage = z.strictObject({ inputTokens: z.int().nonnegative().nullable(), outputTokens: z.int().nonnegative().nullable() });
const Config = z.strictObject({ tenantId: name, connectionId: name, modeDigest: hash, modelIdentity: name, evidence,
  maxCalls: z.int().min(1).max(1000), timeoutMs: z.int().min(1).max(300_000), maxInputBytes: z.int().min(1).max(2_097_152).optional(), maxOutputBytes: z.int().min(1).max(2_097_152).optional() });
export type ModelSessionConfig = z.infer<typeof Config>;
export const ModelReceiptSchema = z.strictObject({ tenantId: name, connectionId: name, modeDigest: hash, modelIdentity: name, evidence,
  callId: name, providerRequestId: name, inputDigest: hash, outputDigest: hash, usage });
export type ModelReceipt = z.infer<typeof ModelReceiptSchema>;
export interface ModelCompletion { value: Json; receipt: ModelReceipt }
const Request = z.strictObject({ messages: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string() })).min(1).max(256),
  outputSchema: z.strictObject({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), schema: z.record(z.string(), z.json()) }) });

/** One host-bound model session. Attempts, including unknown failures, consume capacity; no retries or repairs. */
export class ModelSession {
  readonly profile: Readonly<Pick<ModelSessionConfig, 'tenantId' | 'connectionId' | 'modeDigest' | 'modelIdentity' | 'evidence'>>;
  private readonly config: ModelSessionConfig;
  private readonly invoke: OpenAiCompatibleLlm['complete'];
  private readonly identities = new Set<string>();
  private readonly records = new Map<string, ModelReceipt>();
  constructor(client: Pick<OpenAiCompatibleLlm, 'complete'>, input: ModelSessionConfig) {
    const parsed = Config.safeParse(jsonCopy(input));
    if (!parsed.success || typeof client.complete !== 'function') throw new MethodError('INVALID_MODEL_CONFIG', 'method model session', 'not_sent');
    this.config = freeze(parsed.data); const { tenantId, connectionId, modeDigest, modelIdentity, evidence } = this.config;
    this.profile = Object.freeze({ tenantId, connectionId, modeDigest, modelIdentity, evidence }); this.invoke = client.complete.bind(client);
  }
  get callsUsed(): number { return this.identities.size; }
  private scope(input: CallContext): Readonly<CallContext> {
    const context = captureContext(input, 'method model context');
    if (context.tenantId !== this.profile.tenantId || context.connectionId !== this.profile.connectionId || context.modeDigest !== this.profile.modeDigest) throw new MethodError('MODEL_SCOPE', 'method model session', 'not_sent');
    return context;
  }
  receiptFor(input: CallContext): ModelReceipt | undefined {
    const context = this.scope(input); const value = this.records.get(context.idempotencyKey);
    return value ? freeze(jsonCopy(value)) : undefined;
  }
  async complete(original: OpenAiRequest, supplied: CallContext): Promise<ModelCompletion> {
    const live = this.profile.evidence === 'live_model';
    let context: Readonly<CallContext>; let body: z.infer<typeof Request>; let validate: OpenAiRequest['validate'];
    try {
      context = this.scope(supplied);
      if (context.signal.aborted) throw new MethodError('ABORTED', 'method model call');
      validate = original.validate;
      const parsed = Request.safeParse(jsonCopy({ messages: original.messages, outputSchema: original.outputSchema }));
      if (!parsed.success || typeof validate !== 'function') throw new MethodError('INVALID_MODEL_REQUEST', 'method model call');
      body = parsed.data;
      if (Buffer.byteLength(canonical(body)) > (this.config.maxInputBytes ?? 131_072)) throw new MethodError('MODEL_INPUT_LIMIT', 'method model call');
      if (this.identities.has(context.idempotencyKey)) throw new MethodError('MODEL_KEY_REUSE', 'method model call');
      if (this.callsUsed >= this.config.maxCalls) throw new MethodError('MODEL_CALL_LIMIT', 'method model call');
    } catch (error) {
      throw new MethodError(error instanceof MethodError ? error.code : 'INVALID_MODEL_REQUEST', 'method model preflight', live ? 'not_sent' : 'not_applicable');
    }
    this.identities.add(context.idempotencyKey);
    let started = false; let returned = false; let timedOut = false;
    const outcome = (): Outcome => !live ? 'not_applicable' : returned ? 'completed' : started ? 'unknown' : 'not_sent';
    const controller = new AbortController(); const abort = (): void => { controller.abort(); };
    context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.config.timeoutMs);
    const cancelled = (): MethodError => new MethodError(timedOut ? 'TIMEOUT' : 'ABORTED', 'method model call', outcome());
    let onAbort: () => void = () => {};
    try {
      if (controller.signal.aborted) throw cancelled();
      const stop = new Promise<never>((_resolve, reject) => { onAbort = () => reject(cancelled()); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw cancelled(); started = true;
        return this.invoke({ ...jsonCopy(body), validate }, Object.freeze({ ...context, signal: controller.signal }));
      });
      const response = await Promise.race([pending, stop]); returned = true;
      if (controller.signal.aborted) throw cancelled();
      const value = jsonCopy(response.value);
      if (Buffer.byteLength(canonical(value)) > (this.config.maxOutputBytes ?? 131_072)) throw new MethodError('MODEL_OUTPUT_LIMIT', 'method model response', outcome());
      try {
        const valid = validate(jsonCopy(value));
        if (valid !== true) { void Promise.resolve(valid).catch(() => {}); throw new Error(); }
      } catch { throw new MethodError('MODEL_OUTPUT_INVALID', 'method model response', outcome()); }
      const checked = ModelReceiptSchema.safeParse(jsonCopy({ ...this.profile, callId: context.idempotencyKey, providerRequestId: response.providerRequestId,
        inputDigest: digest(body), outputDigest: digest(value), usage: response.usage }));
      if (!checked.success || response.finishReason !== 'stop') throw new MethodError('MODEL_RESPONSE_INVALID', 'method model response', outcome());
      const receipt = freeze(checked.data); this.records.set(context.idempotencyKey, receipt);
      return { value, receipt: freeze(jsonCopy(receipt)) };
    } catch (error) {
      if (controller.signal.aborted) throw cancelled();
      if (error instanceof MethodError) throw new MethodError(error.code, error.operation, outcome());
      throw new MethodError('MODEL_CALL_FAILED', 'method model call', live && error instanceof ModelError ? error.outcome : outcome());
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); }
  }
}

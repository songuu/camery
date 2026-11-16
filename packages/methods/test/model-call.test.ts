import { expect, it, vi } from 'vitest';
import { ModelError } from '@camery/model-modes';
import type { Json, OpenAiRequest, OpenAiResult } from '@camery/model-modes';
import { ModelSession } from '../src/model-call.js';
const config = () => ({ tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), modelIdentity: 'provider/model-a', evidence: 'live_model' as const, maxCalls: 2, timeoutMs: 1000 });
const context = (key = 'request-a') => ({ tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), idempotencyKey: key, signal: new AbortController().signal });
const request = (): OpenAiRequest => ({ messages: [{ role: 'user', content: 'untrusted source' }], outputSchema: { name: 'result', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }, validate: value => value !== null && typeof value === 'object' && !Array.isArray(value) && value['answer'] === 'ok' });
const reply = (): OpenAiResult => ({ providerRequestId: 'response-a', content: '{"answer":"ok"}', value: { answer: 'ok' }, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: null } });
it('binds scope, captures the request and returns detached receipts without raw prompt data', async () => {
  let release: () => void = () => {}; const ready = new Promise<void>(resolve => { release = resolve; });
  const complete = vi.fn(async (input: OpenAiRequest, ctx: ReturnType<typeof context>) => { await ready; expect(input.messages[0]?.content).toBe('untrusted source'); expect(ctx.tenantId).toBe('tenant-a'); return reply(); });
  const cfg = config(); const session = new ModelSession({ complete }, cfg); const input = request(); const ctx = context();
  const pending = session.complete(input, ctx); input.messages[0]!.content = 'changed'; ctx.tenantId = 'other'; cfg.modelIdentity = 'changed'; release();
  const result = await pending; expect(result.value).toEqual({ answer: 'ok' }); expect(result.receipt).toMatchObject({ modelIdentity: 'provider/model-a', callId: 'request-a', evidence: 'live_model', usage: { inputTokens: 10, outputTokens: null } });
  expect(JSON.stringify(result.receipt)).not.toContain('untrusted source'); expect(session.callsUsed).toBe(1);
  expect(session.receiptFor(context())).toEqual(result.receipt); expect(session.receiptFor(context('unknown'))).toBeUndefined();
});
it('reserves concurrent call capacity and request identity before starting a model', async () => {
  let release: (value: OpenAiResult) => void = () => {};
  const complete = vi.fn(() => new Promise<OpenAiResult>(resolve => { release = resolve; })); const session = new ModelSession({ complete }, { ...config(), maxCalls: 1 });
  const pending = session.complete(request(), context());
  await expect(session.complete(request(), context())).rejects.toMatchObject({ code: 'MODEL_KEY_REUSE' });
  await expect(session.complete(request(), context('request-b'))).rejects.toMatchObject({ code: 'MODEL_CALL_LIMIT' });
  await Promise.resolve(); release(reply()); await pending; expect(complete).toHaveBeenCalledOnce();
});
it('rejects wrong tenant/connection/mode and pre-cancelled input without spending a call', async () => {
  const complete = vi.fn(async () => reply()); const session = new ModelSession({ complete }, config());
  for (const overrides of [{ tenantId: 'other' }, { connectionId: 'other' }, { modeDigest: 'b'.repeat(64) }]) await expect(session.complete(request(), { ...context(), ...overrides })).rejects.toMatchObject({ code: 'MODEL_SCOPE' });
  const controller = new AbortController(); controller.abort(); await expect(session.complete(request(), { ...context(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_sent' });
  expect(session.callsUsed).toBe(0); expect(complete).not.toHaveBeenCalled();
});
it('keeps failures spent, preserves provider outcomes and never retries or emits late receipts', async () => {
  const failed = vi.fn(async () => { throw new ModelError('NETWORK_FAILED', 'provider', 'unknown'); }); const session = new ModelSession({ complete: failed }, config());
  await expect(session.complete(request(), context())).rejects.toMatchObject({ outcome: 'unknown' }); expect(failed).toHaveBeenCalledOnce(); expect(session.callsUsed).toBe(1); expect(session.receiptFor(context())).toBeUndefined();
  let resolve: (value: OpenAiResult) => void = () => {}; const slow = new ModelSession({ complete: () => new Promise(done => { resolve = done; }) }, { ...config(), timeoutMs: 10 });
  await expect(slow.complete(request(), context())).rejects.toMatchObject({ code: 'TIMEOUT', outcome: 'unknown' }); resolve(reply()); await Promise.resolve(); expect(slow.receiptFor(context())).toBeUndefined();
});
it('validates actual model output even if an injected client ignores validation', async () => {
  const session = new ModelSession({ complete: async () => ({ ...reply(), value: { answer: 'wrong' } }) }, config());
  await expect(session.complete(request(), context())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID', outcome: 'completed' });
  const asyncInput = request(); asyncInput.validate = (() => Promise.reject(new Error('late secret'))) as never;
  await expect(new ModelSession({ complete: async () => reply() }, config()).complete(asyncInput, context())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' }); await Promise.resolve();
});
it('bounds request/output sizes and rejects malformed receipts', async () => {
  const complete = vi.fn(async () => reply());
  await expect(new ModelSession({ complete }, { ...config(), maxInputBytes: 1 }).complete(request(), context())).rejects.toMatchObject({ code: 'MODEL_INPUT_LIMIT', outcome: 'not_sent' }); expect(complete).not.toHaveBeenCalled();
  await expect(new ModelSession({ complete }, { ...config(), maxOutputBytes: 1 }).complete(request(), context())).rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT', outcome: 'completed' });
  for (const value of [{ ...reply(), providerRequestId: '' }, { ...reply(), usage: { inputTokens: -1, outputTokens: 0 } }, { ...reply(), value: undefined as unknown as Json }]) await expect(new ModelSession({ complete: async () => value }, config()).complete(request(), context())).rejects.toThrow();
});
it('classifies generic preflight data/context failures before a live call as not_sent', async () => {
  const complete = vi.fn(async () => reply()); const session = new ModelSession({ complete }, config());
  const input = request(); input.messages[0]!.content = 'x'.repeat(2_097_153);
  await expect(session.complete(input, context())).rejects.toMatchObject({ code: 'DATA_LIMIT', outcome: 'not_sent' });
  await expect(session.complete(request(), { ...context(), tenantId: '' })).rejects.toMatchObject({ outcome: 'not_sent' });
  expect(session.callsUsed).toBe(0); expect(complete).not.toHaveBeenCalled();
});
it('rejects malformed session configuration and requests before invoking a provider', async () => {
  const complete = vi.fn(async () => reply());
  expect(() => new ModelSession({ complete }, { ...config(), maxCalls: 0 })).toThrow();
  expect(() => new ModelSession({ complete: false as never }, config())).toThrow();
  const session = new ModelSession({ complete }, config());
  await expect(session.complete({ ...request(), messages: [] }, context())).rejects.toMatchObject({ code: 'INVALID_MODEL_REQUEST', outcome: 'not_sent' });
  await expect(session.complete({ ...request(), validate: false as never }, context())).rejects.toMatchObject({ code: 'INVALID_MODEL_REQUEST', outcome: 'not_sent' });
  expect(session.callsUsed).toBe(0); expect(complete).not.toHaveBeenCalled();
});
it('marks replay cancellation and local failures as not_applicable', async () => {
  const complete = vi.fn(async () => reply()); const controller = new AbortController(); controller.abort();
  const session = new ModelSession({ complete }, { ...config(), evidence: 'synthetic_replay' });
  await expect(session.complete(request(), { ...context(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_applicable' });
  expect(complete).not.toHaveBeenCalled();
  const bad = new ModelSession({ complete: async () => { throw new Error('untrusted provider details'); } }, { ...config(), evidence: 'synthetic_replay' });
  await expect(bad.complete(request(), context())).rejects.toMatchObject({ code: 'MODEL_CALL_FAILED', outcome: 'not_applicable' });
});
it('keeps a live in-flight cancellation unknown and does not publish a late receipt', async () => {
  const controller = new AbortController(); let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; }); let finish: (value: OpenAiResult) => void = () => {};
  const session = new ModelSession({ complete: async () => { started(); return new Promise(resolve => { finish = resolve; }); } }, config());
  const pending = session.complete(request(), { ...context(), signal: controller.signal }); const observed = pending.catch(error => error);
  await ready; controller.abort(); expect(await observed).toMatchObject({ code: 'ABORTED', outcome: 'unknown' });
  finish(reply()); await Promise.resolve(); expect(session.receiptFor(context())).toBeUndefined(); expect(session.callsUsed).toBe(1);
});

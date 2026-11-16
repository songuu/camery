import { expect, it, vi } from 'vitest';
import { OpenAiCompatibleLlm } from '../src/connectors/openai.js';
import type { OpenAiRequest } from '../src/connectors/openai.js';
import type { HttpTransport, Json } from '../src/types.js';
import { context, reply } from './support.js';

const output = (overrides: Record<string, Json> = {}): Json => ({ id: 'completion-test', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"answer":42}' } }], usage: { prompt_tokens: 9, completion_tokens: 4 }, ...overrides });
const request = (): OpenAiRequest => ({ messages: [{ role: 'user', content: 'Return an answer' }], outputSchema: { name: 'answer', schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'number' } }, required: ['answer'] } }, validate: value => !!value && typeof value === 'object' && !Array.isArray(value) && value['answer'] === 42 });
function fixture(format: 'json_schema' | 'json_object' = 'json_schema') {
  const exchange = vi.fn<HttpTransport['exchange']>().mockResolvedValue(reply(output()));
  return { exchange, llm: new OpenAiCompatibleLlm({ exchange }, { model: 'configured-model', structuredOutput: format }) };
}
it('uses the declared model and strict structured format without silently changing model or retrying', async () => {
  const { llm, exchange } = fixture(); const input = request(); const ctx = context();
  const result = await llm.complete(input, ctx);
  expect(result).toEqual({ providerRequestId: 'completion-test', content: '{"answer":42}', value: { answer: 42 }, usage: { inputTokens: 9, outputTokens: 4 }, finishReason: 'stop' });
  expect(exchange).toHaveBeenCalledTimes(1);
  expect(exchange).toHaveBeenCalledWith({ method: 'POST', path: '/chat/completions', effect: 'submit', responseType: 'json', body: { model: 'configured-model', messages: input.messages, stream: false, n: 1, response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: input.outputSchema.schema, strict: true } } } }, ctx);
});
it('JSON-object mode explicitly instructs JSON and includes the schema in a system instruction', async () => {
  const { llm, exchange } = fixture('json_object'); await llm.complete(request(), context());
  const sent = exchange.mock.calls[0]![0].body as { response_format: Json; messages: { role: string; content: string }[] };
  expect(sent.response_format).toEqual({ type: 'json_object' }); expect(sent.messages[0]?.role).toBe('system'); expect(sent.messages[0]?.content).toContain('JSON'); expect(sent.messages[0]?.content).toContain('"required":["answer"]');
});
it.each(['length', 'content_filter', 'tool_calls', 'function_call', null])('rejects finish reason %s as a completed charged call', async reason => {
  const { llm, exchange } = fixture(); exchange.mockResolvedValue(reply(output({ choices: [{ finish_reason: reason, message: { content: '{"answer":42}' } }] })));
  await expect(llm.complete(request(), context())).rejects.toMatchObject({ outcome: 'completed' }); expect(exchange).toHaveBeenCalledTimes(1);
});
it.each([
  { choices: [] }, { choices: [{ finish_reason: 'stop', message: { content: null } }] },
  { choices: [{ finish_reason: 'stop', message: { content: '{"answer":42}', refusal: 'provider refusal details must stay private' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: '{"answer":42,"answer":43}' } }] },
  { choices: [{ finish_reason: 'stop', message: { content: '{"__proto__":{}}' } }] },
  { id: '' }, { choices: [null] }, { choices: {} },
])('rejects malformed, refused and duplicate-key output without a hidden repair', async malformed => {
  const { llm, exchange } = fixture(); exchange.mockResolvedValue(reply(output(malformed as Record<string, Json>)));
  await expect(llm.complete(request(), context())).rejects.toMatchObject({ outcome: 'completed' }); expect(exchange).toHaveBeenCalledTimes(1);
});
it.each(['false', 'throws', 'async-true', 'async-reject'] as const)('fails closed for validator %s and observes async rejection', async kind => {
  const { llm, exchange } = fixture(); const input = request();
  input.validate = (kind === 'throws' ? () => { throw new Error('secret validation context'); } : kind === 'async-true' ? async () => true : kind === 'async-reject' ? async () => { throw new Error('secret validator unavailable'); } : () => false) as OpenAiRequest['validate'];
  await expect(llm.complete(input, context())).rejects.toMatchObject({ code: 'OUTPUT_INVALID', outcome: 'completed' });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(exchange).toHaveBeenCalledTimes(1);
});
it('does not let a validator mutate returned data and freezes the request at the call boundary', async () => {
  const { llm, exchange } = fixture(); const input = request(); let release: (value: ReturnType<typeof reply>) => void = () => {};
  exchange.mockImplementation(async () => new Promise(resolve => { release = resolve; }));
  input.validate = value => { if (value && typeof value === 'object' && !Array.isArray(value)) value['answer'] = 100; return true; };
  const pending = llm.complete(input, context()); input.messages[0]!.content = 'changed after invocation'; input.outputSchema.schema['type'] = 'array'; input.validate = () => false;
  release(reply(output())); expect((await pending).value).toEqual({ answer: 42 });
  const sent = exchange.mock.calls[0]![0].body as { messages: { content: string }[]; response_format: { json_schema: { schema: Json } } };
  expect(sent.messages[0]?.content).toBe('Return an answer'); expect(sent.response_format.json_schema.schema).toMatchObject({ type: 'object' });
});
it.each([null, {}, { prompt_tokens: -1, completion_tokens: 1.5 }, { prompt_tokens: '9', completion_tokens: 0 }])('reports only safe observed usage for %s', async usage => {
  const { llm, exchange } = fixture(); exchange.mockResolvedValue(reply(output({ usage })));
  const result = await llm.complete(request(), context()); expect(result.usage.inputTokens).toBeNull(); expect(result.usage.outputTokens).toBe(usage && typeof usage === 'object' && 'completion_tokens' in usage && usage.completion_tokens === 0 ? 0 : null);
});
it.each([400, 401, 403, 422, 429, 500, 503])('does not retry HTTP %s or leak provider error text', async status => {
  const { llm, exchange } = fixture(); exchange.mockResolvedValue(reply({ error: { message: 'private-credential-or-input' } }, status));
  await expect(llm.complete(request(), context())).rejects.toMatchObject({ httpStatus: status, outcome: status < 500 ? 'rejected' : 'unknown' }); expect(exchange).toHaveBeenCalledTimes(1);
});
it('propagates unknown transport outcomes without repair or a second submit', async () => {
  const { llm, exchange } = fixture(); const failure = new Error('opaque transport error'); exchange.mockRejectedValue(failure);
  await expect(llm.complete(request(), context())).rejects.toBe(failure); expect(exchange).toHaveBeenCalledTimes(1);
});
it('permits exactly one explicitly invoked repair exchange using a different idempotency key', async () => {
  const { llm, exchange } = fixture(); const original = request();
  await expect(llm.repair(original, { idempotencyKey: 'same', content: '{invalid}' }, context({ idempotencyKey: 'same' }))).rejects.toMatchObject({ code: 'REPAIR_KEY_REUSE', outcome: 'not_sent' }); expect(exchange).not.toHaveBeenCalled();
  const result = await llm.repair(original, { idempotencyKey: 'original', content: '{invalid}' }, context({ idempotencyKey: 'repair-1' }));
  expect(result.value).toEqual({ answer: 42 }); expect(exchange).toHaveBeenCalledTimes(1); expect(original.messages).toHaveLength(1);
  const sent = exchange.mock.calls[0]![0].body as { messages: { role: string; content: string }[] };
  expect(sent.messages).toHaveLength(3); expect(sent.messages[1]).toEqual({ role: 'assistant', content: '{invalid}' }); expect(sent.messages[2]?.content).toContain('JSON');
});
it('validates configuration and request shape before any network action', async () => {
  const { exchange } = fixture();
  expect(() => new OpenAiCompatibleLlm({ exchange }, { model: '', structuredOutput: 'json_schema' })).toThrow();
  expect(() => new OpenAiCompatibleLlm({ exchange }, { model: 'm', structuredOutput: 'unknown' as 'json_schema' })).toThrow();
  for (const patch of [{ messages: [] }, { messages: [{ role: 'tool', content: 'x' }] }, { messages: [{ role: 'user', content: 1 }] }, { outputSchema: { name: '', schema: {} } }, { outputSchema: { name: 'x', schema: [] } }, { validate: null }]) {
    const { llm, exchange: call } = fixture(); await expect(llm.complete({ ...request(), ...patch } as OpenAiRequest, context())).rejects.toMatchObject({ outcome: 'not_sent' }); expect(call).not.toHaveBeenCalled();
  }
  const { llm } = fixture(); const abort = new AbortController(); abort.abort(); await expect(llm.complete(request(), context({ signal: abort.signal }))).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_sent' });
  await expect(llm.repair(request(), { idempotencyKey: '', content: 'x' }, context())).rejects.toMatchObject({ outcome: 'not_sent' });
});

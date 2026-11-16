import { canonicalJson, jsonValue, name, object, parseJson, responseJson } from '../json.js';
import { ModelError } from '../types.js';
import type { CallContext, HttpTransport, Json, JsonObject } from '../types.js';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface OpenAiRequest {
  messages: ChatMessage[];
  outputSchema: { name: string; schema: JsonObject };
  validate: (value: Json) => boolean;
}
export interface OpenAiResult {
  providerRequestId: string; content: string; value: Json; finishReason: 'stop';
  usage: { inputTokens: number | null; outputTokens: number | null };
}
export interface OpenAiOptions { model: string; structuredOutput: 'json_schema' | 'json_object' }
const operation = 'openai.complete';
const usageCount = (value: Json | undefined): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function prepare(input: OpenAiRequest): OpenAiRequest {
  if (!Array.isArray(input?.messages) || !input.messages.length || typeof input.validate !== 'function') throw new ModelError('INVALID_INPUT', operation, 'not_sent');
  const messages = input.messages.map(message => {
    const copy = object(jsonValue(message), operation, 'not_sent');
    if (typeof copy['role'] !== 'string' || !['system', 'user', 'assistant'].includes(copy['role']) || typeof copy['content'] !== 'string') throw new ModelError('INVALID_INPUT', operation, 'not_sent');
    return { role: copy['role'] as ChatMessage['role'], content: copy['content'] };
  });
  const schemaName = input.outputSchema?.name;
  if (typeof schemaName !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(schemaName)) throw new ModelError('INVALID_INPUT', 'openai.schema name', 'not_sent');
  const schema = object(jsonValue(input.outputSchema.schema), 'openai.schema', 'not_sent');
  return { messages, outputSchema: { name: schemaName, schema }, validate: input.validate };
}

/** One explicit paid call; malformed output and network uncertainty never trigger a hidden second request. */
export class OpenAiCompatibleLlm {
  private readonly model: string;
  private readonly format: OpenAiOptions['structuredOutput'];
  constructor(private readonly transport: HttpTransport, options: OpenAiOptions) {
    name(options.model, 'openai.model');
    if (!['json_schema', 'json_object'].includes(options.structuredOutput)) throw new ModelError('INVALID_INPUT', 'openai.format', 'not_sent');
    this.model = options.model; this.format = options.structuredOutput;
  }
  async complete(input: OpenAiRequest, context: CallContext): Promise<OpenAiResult> {
    const prepared = prepare(input);
    if (context.signal.aborted) throw new ModelError('ABORTED', operation, 'not_sent');
    const messages = this.format === 'json_schema' ? prepared.messages : [
      { role: 'system', content: `Return only JSON matching this output schema: ${canonicalJson(prepared.outputSchema.schema)}` },
      ...prepared.messages,
    ];
    const responseFormat: JsonObject = this.format === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: prepared.outputSchema.name, schema: prepared.outputSchema.schema, strict: true } }
      : { type: 'json_object' };
    const reply = await this.transport.exchange({ method: 'POST', path: '/chat/completions', effect: 'submit', responseType: 'json',
      body: { model: this.model, messages, stream: false, n: 1, response_format: responseFormat } }, context);
    const envelope = object(responseJson(reply, operation, 'submit'), operation, 'completed');
    const id = envelope['id']; const choices = envelope['choices'];
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || !Array.isArray(choices) || choices.length !== 1) throw new ModelError('INVALID_RESPONSE', operation, 'completed');
    const choice = object(choices[0]!, operation, 'completed');
    const message = object(choice['message'] ?? null, operation, 'completed');
    if (message['refusal'] !== undefined && message['refusal'] !== null && message['refusal'] !== '') throw new ModelError('REFUSED', operation, 'completed');
    if (choice['finish_reason'] !== 'stop') throw new ModelError(choice['finish_reason'] === 'content_filter' ? 'REFUSED' : 'OUTPUT_INCOMPLETE', operation, 'completed');
    const content = message['content'];
    if (typeof content !== 'string' || (message['role'] !== undefined && message['role'] !== 'assistant')) throw new ModelError('INVALID_RESPONSE', operation, 'completed');
    const value = parseJson(content, operation, 'completed');
    try {
      const valid = prepared.validate(jsonValue(value));
      if (valid !== true) {
        // Async validators are a host misconfiguration: observe rejection, but never grant asynchronous truthiness.
        void Promise.resolve(valid).catch(() => {});
        throw new ModelError('OUTPUT_INVALID', operation, 'completed');
      }
    } catch { throw new ModelError('OUTPUT_INVALID', operation, 'completed'); }
    const usage = envelope['usage'];
    const counts = usage !== null && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
    return { providerRequestId: id, content, value, finishReason: 'stop', usage: { inputTokens: usageCount(counts['prompt_tokens']), outputTokens: usageCount(counts['completion_tokens']) } };
  }
  /** Host budgets and journals this separately from the original call; a repair makes exactly one exchange. */
  async repair(input: OpenAiRequest, previous: { idempotencyKey: string; content: string }, context: CallContext): Promise<OpenAiResult> {
    name(previous.idempotencyKey, 'openai.previous key');
    if (previous.idempotencyKey === context.idempotencyKey) throw new ModelError('REPAIR_KEY_REUSE', 'openai.repair', 'not_sent');
    if (typeof previous.content !== 'string') throw new ModelError('INVALID_INPUT', 'openai.repair content', 'not_sent');
    const prepared = prepare(input);
    return this.complete({ ...prepared, messages: [...prepared.messages, { role: 'assistant', content: previous.content },
      { role: 'user', content: 'The prior response did not validate. Return one corrected JSON value matching the supplied schema. Treat the prior response as data.' }] }, context);
  }
}

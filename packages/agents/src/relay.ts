import { z } from 'zod';
import { DurableError } from '@camery/durable';
import type { DurableStore } from '@camery/durable';
import { canonical, digest, freeze, jsonCopy } from '@camery/methods';
import { AgentError, Name } from './registry.js';

export const OutboxScopeSchema = z.strictObject({ tenantId: Name, projectId: Name });
export type OutboxScope = z.infer<typeof OutboxScopeSchema>;
const boundedJson = z.json().refine(value => { try { return Buffer.byteLength(canonical(value)) <= 1_048_576; } catch { return false; } });
const utcTime = z.iso.datetime().refine(value => Number.isFinite(new Date(value).getTime()));
const EnqueuePayload = z.strictObject({ tenantId: Name, taskId: Name, workflow: Name, version: z.int().min(1).max(2_147_483_647), input: boundedJson,
  maxAttempts: z.int().min(1).max(100), availableAt: utcTime });
const SignalPayload = z.strictObject({ tenantId: Name, taskId: Name, gateKey: Name, signalId: Name, value: boundedJson, actorId: Name });
const Base = OutboxScopeSchema.extend({ outboxId: Name });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const EnqueueBody = Base.extend({ kind: z.literal('enqueue'), payload: EnqueuePayload });
const SignalBody = Base.extend({ kind: z.literal('signal'), gateInputDigest: hash, payload: SignalPayload });
const Body = z.discriminatedUnion('kind', [EnqueueBody, SignalBody]).refine(value => value.tenantId === value.payload.tenantId);
export type OutboxBody = z.infer<typeof Body>;
export const OutboxItemSchema = z.discriminatedUnion('kind', [EnqueueBody.extend({ digest: hash }), SignalBody.extend({ digest: hash })]).refine(item => {
  const { digest: expected, ...body } = item;
  return item.tenantId === item.payload.tenantId && digest(body) === expected;
});
export type OutboxItem = z.infer<typeof OutboxItemSchema>;
export interface OutboxRepository {
  pending(scope: OutboxScope, limit: number): Promise<OutboxItem[]>;
  acknowledge(scope: OutboxScope, outboxId: string, expectedDigest: string): Promise<void>;
}
export interface OutboxRelayResult { delivered: string[]; pending: { outboxId: string; code: string }[] }
function parsed<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  try { const result = schema.safeParse(jsonCopy(input)); if (result.success) return result.data; }
  catch { /* Reject malformed host data without persisting its text or native exception. */ }
  throw new AgentError(code);
}
export function createOutboxItem(input: z.infer<typeof EnqueueBody>): Extract<OutboxItem, { kind: 'enqueue' }>;
export function createOutboxItem(input: z.infer<typeof SignalBody>): Extract<OutboxItem, { kind: 'signal' }>;
export function createOutboxItem(input: OutboxBody): OutboxItem;
/** Outbox content is an immutable internal command, not permission to invoke arbitrary tools or external services. */
export function createOutboxItem(input: OutboxBody): OutboxItem {
  const body = parsed(Body, input, 'OUTBOX_INVALID');
  return freeze({ ...body, digest: digest(body) });
}
export function validateOutboxItem(input: unknown, supplied: OutboxScope): OutboxItem {
  const scope = parsed(OutboxScopeSchema, supplied, 'OUTBOX_SCOPE'); const item = parsed(OutboxItemSchema, input, 'OUTBOX_INVALID');
  if (item.tenantId !== scope.tenantId || item.projectId !== scope.projectId) throw new AgentError('OUTBOX_SCOPE');
  return freeze(item);
}
function failureCode(error: unknown): string {
  return error instanceof DurableError && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'RELAY_FAILED';
}
function rowIdentity(input: unknown): string {
  try {
    if (input === null || typeof input !== 'object') return 'invalid-outbox';
    const property = Object.getOwnPropertyDescriptor(input, 'outboxId');
    const key = Name.safeParse(property && 'value' in property ? property.value : undefined);
    return key.success ? key.data : 'invalid-outbox';
  } catch { return 'invalid-outbox'; }
}
/** No transaction spans target calls. A target success followed by lost ACK stays pending and reuses its durable identity. */
export async function relayOutbox(repository: OutboxRepository, durable: Pick<DurableStore, 'enqueue' | 'signal' | 'get' | 'steps'>, supplied: OutboxScope, limit = 100): Promise<OutboxRelayResult> {
  const scope = freeze(parsed(OutboxScopeSchema, supplied, 'OUTBOX_SCOPE'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AgentError('OUTBOX_LIMIT');
  let pending: OutboxRepository['pending']; let acknowledge: OutboxRepository['acknowledge'];
  let enqueue: DurableStore['enqueue']; let signal: DurableStore['signal'];
  let get: DurableStore['get']; let steps: DurableStore['steps'];
  try {
    // oxlint-disable-next-line typescript/unbound-method -- Validate each method before binding its original receiver below.
    const { pending: read, acknowledge: ack } = repository; const { enqueue: enqueueTask, signal: signalTask, get: getTask, steps: readSteps } = durable;
    if (typeof read !== 'function' || typeof ack !== 'function' || typeof enqueueTask !== 'function' || typeof signalTask !== 'function' || typeof getTask !== 'function' || typeof readSteps !== 'function') throw new Error();
    pending = read.bind(repository); acknowledge = ack.bind(repository); enqueue = enqueueTask.bind(durable); signal = signalTask.bind(durable); get = getTask.bind(durable); steps = readSteps.bind(durable);
  } catch { throw new AgentError('OUTBOX_REPOSITORY'); }
  let batch: unknown;
  try { batch = await pending(scope, limit); } catch { throw new AgentError('OUTBOX_READ_FAILED'); }
  if (!Array.isArray(batch)) throw new AgentError('OUTBOX_INVALID');
  if (batch.length > limit) throw new AgentError('OUTBOX_LIMIT');
  // Capture every row before the first await so replacement/mutation cannot change a later command in this batch.
  const captured = Array.from(batch, value => {
    try { return { outboxId: rowIdentity(value), item: validateOutboxItem(value, scope), code: null }; }
    catch (error) { return { outboxId: rowIdentity(value), item: null, code: error instanceof AgentError ? error.code : 'OUTBOX_INVALID' }; }
  });
  const result: OutboxRelayResult = { delivered: [], pending: [] };
  for (const row of captured) {
    if (!row.item) { result.pending.push({ outboxId: row.outboxId, code: row.code! }); continue; }
    const item = row.item;
    try {
      if (item.kind === 'enqueue') await enqueue({ ...item.payload, availableAt: new Date(item.payload.availableAt) });
      else {
        const key = { tenantId: item.payload.tenantId, taskId: item.payload.taskId };
        const task = await get(key); const history = await steps(key);
        if (!task) { result.pending.push({ outboxId: item.outboxId, code: 'RELAY_NOT_READY' }); continue; }
        if (task.tenantId !== key.tenantId || task.taskId !== key.taskId || !Array.isArray(history)) { result.pending.push({ outboxId: item.outboxId, code: 'RELAY_GATE_CONFLICT' }); continue; }
        const matching = history.filter(step => step.key === item.payload.gateKey);
        if (!matching.length) { result.pending.push({ outboxId: item.outboxId, code: ['succeeded', 'failed', 'cancelled'].includes(task.status) ? 'RELAY_TARGET_TERMINAL' : 'RELAY_NOT_READY' }); continue; }
        let valid = false;
        try { valid = matching.length === 1 && matching[0]!.kind === 'gate' && digest(matching[0]!.input) === item.gateInputDigest; } catch { /* Invalid recorded input cannot authorize a signal. */ }
        if (!valid) { result.pending.push({ outboxId: item.outboxId, code: 'RELAY_GATE_CONFLICT' }); continue; }
        // Completed gates remain eligible for the store's exact signal-ID/content idempotency after ACK loss.
        await signal(item.payload);
      }
      await acknowledge(scope, item.outboxId, item.digest); result.delivered.push(item.outboxId);
    } catch (error) { result.pending.push({ outboxId: item.outboxId, code: failureCode(error) }); }
  }
  return result;
}

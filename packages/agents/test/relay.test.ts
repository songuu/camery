import { expect, it, vi } from 'vitest';
import { DurableError } from '@camery/durable';
import type { EnqueueTask, Step, Task } from '@camery/durable';
import { digest } from '@camery/methods';
import { createOutboxItem, relayOutbox, validateOutboxItem } from '../src/relay.js';
import type { OutboxItem, OutboxRepository, OutboxScope } from '../src/relay.js';

const scope = (): OutboxScope => ({ tenantId: 'tenant-a', projectId: 'project-a' });
const enqueue = (outboxId = 'enqueue-a') => createOutboxItem({ ...scope(), outboxId, kind: 'enqueue', payload: { tenantId: 'tenant-a', taskId: 'task-a', workflow: 'research', version: 1, input: { source: 'original' }, maxAttempts: 3, availableAt: '2026-11-11T05:00:00.000Z' } });
const gateInput = { question: 'Review this candidate?' };
const signal = (outboxId = 'signal-a') => createOutboxItem({ ...scope(), outboxId, kind: 'signal', gateInputDigest: digest(gateInput), payload: { tenantId: 'tenant-a', taskId: 'task-a', gateKey: 'approve', signalId: 'decision-a', value: { answer: 'revise' }, actorId: 'trusted-human' } });
const queued = (input: EnqueueTask): Task => ({ ...input, status: 'queued', attempts: 0, fence: 0, owner: null, leaseUntil: null, output: null, error: null });
function fixture(items: OutboxItem[] = [enqueue(), signal()]) {
  const waiting = new Map(items.map(item => [item.outboxId, item]));
  const repo: OutboxRepository = { pending: vi.fn(async () => [...waiting.values()]), acknowledge: vi.fn(async (_scope, outboxId, expectedDigest) => { expect(waiting.get(outboxId)?.digest).toBe(expectedDigest); waiting.delete(outboxId); }) };
  const gate: Step = { key: 'approve', position: 0, kind: 'gate', input: gateInput, fingerprint: digest({ kind: 'gate', input: gateInput }), idempotencyKey: 'gate-id', status: 'waiting', output: null, error: null, dueAt: null };
  const durable = { enqueue: vi.fn(async (input: EnqueueTask) => queued(input)), signal: vi.fn(async () => {}),
    get: vi.fn(async () => queued({ tenantId: 'tenant-a', taskId: 'task-a', workflow: 'research', version: 1, input: null, maxAttempts: 3, availableAt: new Date('2026-11-11T05:00:00.000Z') })), steps: vi.fn(async () => [gate]) };
  return { waiting, repo, durable };
}

it('creates immutable typed commands with digests over the complete scoped body', () => {
  const original = { ...scope(), outboxId: 'enqueue-a', kind: 'enqueue' as const, payload: { tenantId: 'tenant-a', taskId: 'task-a', workflow: 'research', version: 1, input: { source: 'original' }, maxAttempts: 3, availableAt: '2026-11-11T05:00:00.000Z' } };
  const item = createOutboxItem(original); expect(item.digest).toBe(digest(original)); original.payload.input.source = 'changed';
  expect(item.payload).toMatchObject({ input: { source: 'original' } }); expect(Object.isFrozen(item)).toBe(true); expect(Object.isFrozen(item.payload)).toBe(true);
  expect(validateOutboxItem(item, scope())).toEqual(item);
});
it.each(['date', 'non-utc', 'infinite-date', 'duplicate-field', 'wrong-payload', 'cross-tenant', 'invalid-attempts', 'invalid-version', 'non-json', 'oversized-json'] as const)('rejects invalid enqueue commands: %s', kind => {
  const item = structuredClone(enqueue()); const { digest: _digest, ...body } = item;
  if (kind === 'date') body.payload.availableAt = '2026-02-30T00:00:00Z';
  if (kind === 'non-utc') body.payload.availableAt = '2026-11-11T13:00:00+08:00';
  if (kind === 'infinite-date') body.payload.availableAt = '+999999-01-01T00:00:00.000Z';
  if (kind === 'duplicate-field') Object.assign(body.payload, { script: 'process.exit()' });
  if (kind === 'wrong-payload') Object.assign(body, { payload: signal().payload });
  if (kind === 'cross-tenant') body.payload.tenantId = 'tenant-b';
  if (kind === 'invalid-attempts') body.payload.maxAttempts = 0;
  if (kind === 'invalid-version') body.payload.version = 0;
  if (kind === 'non-json') body.payload.input = undefined as never;
  if (kind === 'oversized-json') body.payload.input = { source: 'x'.repeat(1_048_577) };
  expect(() => createOutboxItem(body)).toThrow();
});
it('rejects unknown signal fields, missing actors and cross-scope/tampered records', () => {
  const item = signal(); const { digest: _digest, ...body } = item;
  for (const payload of [{ ...body.payload, actorId: '' }, { ...body.payload, extra: true }, { ...body.payload, tenantId: 'other' }]) expect(() => createOutboxItem({ ...body, payload })).toThrow();
  for (const altered of [{ ...item, digest: 'b'.repeat(64) }, { ...item, projectId: 'other' }, { ...item, payload: { ...item.payload, signalId: 'changed' } }]) expect(() => validateOutboxItem(altered, scope())).toThrow();
  expect(() => validateOutboxItem(item, { ...scope(), tenantId: 'other' })).toThrow();
});
it('forwards enqueue and signal sequentially, then acknowledges with the exact stored digest', async () => {
  const f = fixture(); const order: string[] = [];
  f.durable.enqueue.mockImplementation(async input => { order.push('enqueue'); expect(input.availableAt).toEqual(new Date('2026-11-11T05:00:00.000Z')); return queued(input); });
  f.durable.signal.mockImplementation(async () => { order.push('signal'); });
  vi.mocked(f.repo.acknowledge).mockImplementation(async (_scope, id, expected) => { expect(expected).toBe(f.waiting.get(id)!.digest); order.push(`ack-${id}`); f.waiting.delete(id); });
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: ['enqueue-a', 'signal-a'], pending: [] });
  expect(order).toEqual(['enqueue', 'ack-enqueue-a', 'signal', 'ack-signal-a']); expect(f.waiting.size).toBe(0);
});
it('retains an ACK-loss command and relies on exact durable identity to retry without another job', async () => {
  const f = fixture([enqueue()]); const jobs = new Map<string, EnqueueTask>();
  f.durable.enqueue.mockImplementation(async input => {
    const key = `${input.tenantId}/${input.taskId}`; const prior = jobs.get(key);
    if (prior) expect(input).toEqual(prior); else jobs.set(key, input); return queued(input);
  });
  vi.mocked(f.repo.acknowledge).mockRejectedValueOnce(new Error('postgres://secret:password@host'));
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: [], pending: [{ outboxId: 'enqueue-a', code: 'RELAY_FAILED' }] });
  expect(f.waiting.size).toBe(1);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: ['enqueue-a'], pending: [] });
  expect(jobs.size).toBe(1); expect(f.durable.enqueue).toHaveBeenCalledTimes(2); expect(f.waiting.size).toBe(0);
});
it('retains a signal sent before its actual gate is waiting, then retries the same signal identity', async () => {
  const f = fixture([signal()]); f.durable.signal.mockRejectedValueOnce(new DurableError('GATE_NOT_WAITING', 'provider secret'));
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: [], pending: [{ outboxId: 'signal-a', code: 'GATE_NOT_WAITING' }] });
  expect(f.repo.acknowledge).not.toHaveBeenCalled(); expect(f.waiting.size).toBe(1);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: ['signal-a'], pending: [] });
  expect(f.durable.signal.mock.calls[0]).toEqual(f.durable.signal.mock.calls[1]);
});
it('keeps an early answer pending until the matching gate and input are durably present', async () => {
  const f = fixture([signal()]); f.durable.steps.mockResolvedValueOnce([]);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: [], pending: [{ outboxId: 'signal-a', code: 'RELAY_NOT_READY' }] });
  expect(f.durable.signal).not.toHaveBeenCalled(); expect(f.repo.acknowledge).not.toHaveBeenCalled();
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: ['signal-a'], pending: [] });
  expect(f.durable.get).toHaveBeenCalledWith({ tenantId: 'tenant-a', taskId: 'task-a' }); expect(f.durable.steps).toHaveBeenCalledWith({ tenantId: 'tenant-a', taskId: 'task-a' });
});
it.each(['kind', 'input'] as const)('rejects a mismatched durable gate %s without forwarding the answer', async field => {
  const f = fixture([signal()]); const gate = (await f.durable.steps())[0]!;
  f.durable.steps.mockResolvedValue([{ ...gate, ...(field === 'kind' ? { kind: 'replayable' as const } : { input: { question: 'Different candidate?' } }) }]);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: [], pending: [{ outboxId: 'signal-a', code: 'RELAY_GATE_CONFLICT' }] });
  expect(f.durable.signal).not.toHaveBeenCalled(); expect(f.repo.acknowledge).not.toHaveBeenCalled();
});
it('distinguishes a terminal target without a gate and a target not yet enqueued', async () => {
  const f = fixture([signal()]); const target = await f.durable.get(); f.durable.get.mockResolvedValueOnce({ ...target, status: 'cancelled' }); f.durable.steps.mockResolvedValue([]);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: [], pending: [{ outboxId: 'signal-a', code: 'RELAY_TARGET_TERMINAL' }] });
  f.durable.get.mockResolvedValueOnce(null as never);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: [], pending: [{ outboxId: 'signal-a', code: 'RELAY_NOT_READY' }] });
  expect(f.durable.signal).not.toHaveBeenCalled();
});
it('can ACK an already delivered exact signal after ACK loss even when its task has since succeeded', async () => {
  const f = fixture([signal()]); const target = await f.durable.get(); const gate = (await f.durable.steps())[0]!; let applied = false; let writes = 0;
  f.durable.signal.mockImplementation(async () => { if (!applied) { applied = true; writes++; f.durable.get.mockResolvedValue({ ...target, status: 'succeeded' }); f.durable.steps.mockResolvedValue([{ ...gate, status: 'completed' }]); } });
  vi.mocked(f.repo.acknowledge).mockRejectedValueOnce(new Error('lost ACK'));
  expect((await relayOutbox(f.repo, f.durable, scope())).pending).toEqual([{ outboxId: 'signal-a', code: 'RELAY_FAILED' }]);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: ['signal-a'], pending: [] }); expect(writes).toBe(1); expect(f.durable.signal).toHaveBeenCalledTimes(2);
});
it('does not dispatch hash/scope-invalid rows and continues with later valid commands', async () => {
  const wrong = { ...enqueue('bad-hash'), digest: 'b'.repeat(64) }; const { digest: _digest, ...body } = signal('other-tenant');
  const other = createOutboxItem({ ...body, tenantId: 'tenant-b', payload: { ...body.payload, tenantId: 'tenant-b' } });
  const f = fixture([wrong, other, signal()]); const result = await relayOutbox(f.repo, f.durable, scope());
  expect(result.delivered).toEqual(['signal-a']); expect(result.pending.map(value => value.outboxId)).toEqual(['bad-hash', 'other-tenant']);
  expect(f.durable.enqueue).not.toHaveBeenCalled(); expect(f.durable.signal).toHaveBeenCalledOnce(); expect(f.repo.acknowledge).toHaveBeenCalledOnce();
});
it.each([0, 101, -1, NaN, 1.5])('rejects an invalid relay limit %s before reading the queue', async limit => {
  const f = fixture(); await expect(relayOutbox(f.repo, f.durable, scope(), limit)).rejects.toThrow(); expect(f.repo.pending).not.toHaveBeenCalled();
});
it('honors the limit passed to the repository and refuses oversized batches', async () => {
  const f = fixture(); await expect(relayOutbox(f.repo, f.durable, scope(), 1)).rejects.toThrow('OUTBOX_LIMIT');
  expect(f.repo.pending).toHaveBeenCalledWith(scope(), 1); expect(f.durable.enqueue).not.toHaveBeenCalled();
});
it('captures scope, methods and every row before waiting on target work', async () => {
  const items = [structuredClone(enqueue()), structuredClone(signal())]; const f = fixture(items); const supplied = scope();
  let release: () => void = () => {}; const waiting = new Promise<void>(resolve => { release = resolve; });
  let started: () => void = () => {}; const startedAtTarget = new Promise<void>(resolve => { started = resolve; });
  f.durable.enqueue.mockImplementation(async input => { started(); await waiting; return queued(input); });
  const pending = relayOutbox(f.repo, f.durable, supplied); await startedAtTarget;
  supplied.tenantId = 'other'; items[1]!.payload.tenantId = 'other'; f.repo.acknowledge = vi.fn(async () => { throw new Error('replaced'); }); f.durable.signal = vi.fn(async () => { throw new Error('replaced'); });
  release(); const result = await pending; expect(result.delivered).toEqual(['enqueue-a', 'signal-a']); expect(result.pending).toEqual([]);
});
it('awaits asynchronous target and ACK rejections without exposing arbitrary messages or unsafe codes', async () => {
  const f = fixture(); f.durable.enqueue.mockImplementation(async () => { await Promise.resolve(); throw new DurableError('secret-url:password', 'do not expose this secret'); });
  vi.mocked(f.repo.acknowledge).mockImplementation(async () => { await Promise.resolve(); throw new Error('postgres://secret:password@host'); });
  const result = await relayOutbox(f.repo, f.durable, scope()); expect(result).toEqual({ delivered: [], pending: [{ outboxId: 'enqueue-a', code: 'RELAY_FAILED' }, { outboxId: 'signal-a', code: 'RELAY_FAILED' }] });
  expect(JSON.stringify(result)).not.toMatch(/password|postgres|secret/); expect(f.waiting.size).toBe(2);
});
it('rejects invalid repository contracts, malformed batches and queue read failures safely', async () => {
  const f = fixture(); await expect(relayOutbox({ ...f.repo, pending: false as never }, f.durable, scope())).rejects.toThrow();
  await expect(relayOutbox(f.repo, { ...f.durable, signal: false as never }, scope())).rejects.toThrow();
  await expect(relayOutbox(f.repo, f.durable, { ...scope(), projectId: '' })).rejects.toThrow();
  vi.mocked(f.repo.pending).mockResolvedValueOnce(null as never); await expect(relayOutbox(f.repo, f.durable, scope())).rejects.toThrow();
  vi.mocked(f.repo.pending).mockRejectedValueOnce(new Error('database password')); await expect(relayOutbox(f.repo, f.durable, scope())).rejects.toThrow('OUTBOX_READ_FAILED');
});
it('keeps malformed host rows pending without evaluating accessors or dispatching commands', async () => {
  const f = fixture([]); let accessed = false;
  const accessor = Object.defineProperty({}, 'outboxId', { enumerable: true, get: () => { accessed = true; return 'secret'; } });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('untrusted proxy text'); }, ownKeys: () => { throw new Error('untrusted proxy text'); } });
  vi.mocked(f.repo.pending).mockResolvedValueOnce([null, accessor, proxy] as never);
  const result = await relayOutbox(f.repo, f.durable, scope()); expect(result.delivered).toEqual([]); expect(result.pending).toHaveLength(3);
  expect(result.pending.every(value => value.outboxId === 'invalid-outbox' && value.code === 'OUTBOX_INVALID')).toBe(true);
  expect(accessed).toBe(false); expect(f.durable.enqueue).not.toHaveBeenCalled(); expect(f.durable.signal).not.toHaveBeenCalled();
});
it.each(['different-tenant', 'different-task', 'malformed-history', 'duplicate-gate', 'invalid-gate-input'] as const)('does not authorize a signal from inconsistent durable evidence: %s', async kind => {
  const f = fixture([signal()]); const task = await f.durable.get(); const gate = (await f.durable.steps())[0]!;
  if (kind === 'different-tenant') f.durable.get.mockResolvedValue({ ...task, tenantId: 'other' });
  if (kind === 'different-task') f.durable.get.mockResolvedValue({ ...task, taskId: 'other' });
  if (kind === 'malformed-history') f.durable.steps.mockResolvedValue(null as never);
  if (kind === 'duplicate-gate') f.durable.steps.mockResolvedValue([gate, gate]);
  if (kind === 'invalid-gate-input') f.durable.steps.mockResolvedValue([{ ...gate, input: undefined as never }]);
  expect(await relayOutbox(f.repo, f.durable, scope())).toEqual({ delivered: [], pending: [{ outboxId: 'signal-a', code: 'RELAY_GATE_CONFLICT' }] });
  expect(f.durable.signal).not.toHaveBeenCalled(); expect(f.repo.acknowledge).not.toHaveBeenCalled();
});

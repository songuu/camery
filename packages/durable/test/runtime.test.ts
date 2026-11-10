import { expect, it, vi } from 'vitest';
import { DurableWorker } from '../src/runtime.js';
import { DurableError } from '../src/types.js';
import type { DurableStore, Json, StepSpec, Task } from '../src/types.js';
import { makeTask } from './support.js';

function fixture(options: ConstructorParameters<typeof DurableWorker>[1] = {}) {
  const task: Task = { ...makeTask(), status: 'running', owner: 'worker', fence: 1, leaseUntil: new Date(Date.now() + 3000), attempts: 1, output: null, error: null };
  const store: DurableStore = {
    enqueue: vi.fn(), get: vi.fn(async () => structuredClone(task)), steps: vi.fn(), events: vi.fn(),
    claim: vi.fn(async () => ({ task: structuredClone(task), lease: { tenantId: task.tenantId, taskId: task.taskId, owner: 'worker', fence: 1 } })),
    heartbeat: vi.fn(async () => {}), openStep: vi.fn(async () => ({ state: 'execute' as const })),
    completeStep: vi.fn(async () => {}), failStep: vi.fn(async (_lease, _key, _error, uncertain) => { if (uncertain) task.status = 'reconciling'; }),
    finish: vi.fn(async (_lease, output) => { task.output = output; task.status = 'succeeded'; }),
    fail: vi.fn(async () => { task.status = 'queued'; }), cancel: vi.fn(), signal: vi.fn(), reconcile: vi.fn(),
  };
  const worker = new DurableWorker(store, options);
  return { worker, store, task, run: () => worker.runOne(task.tenantId, 'worker') };
}

it('executes sequential steps, preserves stable idempotency and validates detached JSON at both boundaries', async () => {
  const f = fixture(); const original = { b: 2, a: 1 }; const observed: string[] = [];
  f.worker.register({ name: 'test', version: 1, async run(input, ctx) {
    expect(input).toBeNull();
    const first = await ctx.step('fetch', { kind: 'external', input: original }, async args => { observed.push(args.idempotencyKey); expect(args.input).not.toBe(original); return { id: 'provider-1' }; });
    return ctx.step('normalize', { kind: 'replayable', input: first }, async ({ input: next }) => next);
  } });
  expect((await f.run())?.output).toEqual({ id: 'provider-1' });
  expect(f.store.completeStep).toHaveBeenCalledTimes(2);
  const spec = vi.mocked(f.store.openStep).mock.calls[0]![1];
  expect(spec).toMatchObject({ key: 'fetch', position: 0, kind: 'external' });
  expect(spec.fingerprint).toMatch(/^[a-f0-9]{64}$/); expect(observed[0]).toMatch(/^camery_[a-f0-9]{64}$/);
  const other = fixture(); Object.assign(other.task, { tenantId: f.task.tenantId, taskId: f.task.taskId });
  other.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('fetch', { kind: 'external', input: { a: 1, b: 2 } }, async args => { expect(args.idempotencyKey).toBe(observed[0]); return null; }) });
  await other.run();
});
it('replays cached results without invoking an effect', async () => {
  const f = fixture(); const effect = vi.fn();
  vi.mocked(f.store.openStep).mockResolvedValue({ state: 'cached', output: { saved: true } });
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('saved', { kind: 'external', input: null }, effect) });
  expect((await f.run())?.output).toEqual({ saved: true }); expect(effect).not.toHaveBeenCalled(); expect(f.store.completeStep).not.toHaveBeenCalled();
});
it('returns idle without claiming unknown work or invoking handlers', async () => {
  const f = fixture(); vi.mocked(f.store.claim).mockResolvedValue(null);
  expect(await f.run()).toBeNull(); expect(f.store.get).not.toHaveBeenCalled();
});
it('persists unsupported workflow as a bounded failure, never dispatches to another version', async () => {
  const f = fixture(); f.worker.register({ name: 'test', version: 2, run: async () => null });
  expect((await f.run())?.status).toBe('queued'); expect(f.store.fail).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('WORKFLOW_UNAVAILABLE'), 1000);
});
it.each(['gate', 'timer'] as const)('suspends %s without task failure or step side effect', async kind => {
  const f = fixture(); vi.mocked(f.store.openStep).mockResolvedValue({ state: 'suspended' }); f.task.status = 'waiting';
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => kind === 'gate' ? ctx.waitForSignal('approval', { reason: 'review' }) : ctx.sleepUntil('later', new Date('2030-01-01T00:00:00Z')) });
  expect((await f.run())?.status).toBe('waiting'); expect(f.store.fail).not.toHaveBeenCalled(); expect(f.store.finish).not.toHaveBeenCalled();
});
it('replays a completed gate and timer and includes them in visited count', async () => {
  const f = fixture(); vi.mocked(f.store.openStep).mockResolvedValue({ state: 'cached', output: null });
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => { await ctx.waitForSignal('approval'); return ctx.sleepUntil('later', new Date('2020-01-01')); } });
  expect((await f.run())?.status).toBe('succeeded'); expect(f.store.finish).toHaveBeenCalledWith(expect.anything(), null, 2);
});
it.each(['replayable', 'external'] as const)('classifies %s timeouts and aborts callback even if it never settles', async kind => {
  const f = fixture(); let signal: AbortSignal | undefined;
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('hung', { kind, input: null, timeoutMs: 5 }, async args => { signal = args.signal; return new Promise<Json>(() => {}); }) });
  await f.run(); expect(signal?.aborted).toBe(true);
  expect(f.store.failStep).toHaveBeenCalledWith(expect.anything(), 'hung', expect.stringContaining('STEP_TIMEOUT'), kind === 'external');
  if (kind === 'external') expect(f.store.fail).not.toHaveBeenCalled();
  else expect(f.store.fail).toHaveBeenCalled();
});
it('treats invalid external output as uncertain and never stores invalid JSON', async () => {
  const f = fixture();
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('provider', { kind: 'external', input: null }, async () => NaN) });
  expect((await f.run())?.status).toBe('reconciling'); expect(f.store.completeStep).not.toHaveBeenCalled();
});
it('does not persist untrusted error message or stack that may contain credentials', async () => {
  const f = fixture(); f.worker.register({ name: 'test', version: 1, run: async () => { throw new Error('https://secret:password@host'); } });
  await f.run(); const error = vi.mocked(f.store.fail).mock.calls[0]![1];
  expect(error).toContain('WORKFLOW_FAILED'); expect(error).not.toContain('password');
});
it('stops on lease loss without attempting a stale failure write', async () => {
  const f = fixture(); vi.mocked(f.store.openStep).mockRejectedValue(new DurableError('LEASE_LOST', 'stale worker'));
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.waitForSignal('gate') });
  await f.run(); expect(f.store.fail).not.toHaveBeenCalled();
});
it('heartbeats long steps and aborts on heartbeat failure', async () => {
  const f = fixture({ leaseMs: 30, runTimeoutMs: 1000 });
  vi.mocked(f.store.heartbeat).mockRejectedValue(new DurableError('LEASE_LOST', 'expired'));
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('wait', { kind: 'replayable', input: null }, async () => new Promise<Json>(() => {})) });
  await f.run(); expect(f.store.heartbeat).toHaveBeenCalled(); expect(f.store.fail).not.toHaveBeenCalled();
});
it('enforces a run deadline even outside step callbacks', async () => {
  const f = fixture({ runTimeoutMs: 5 }); f.worker.register({ name: 'test', version: 1, run: async () => new Promise<Json>(() => {}) });
  await f.run(); expect(f.store.fail).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('RUN_TIMEOUT'), 1000);
});
it.each(['duplicate', 'parallel', 'limit', 'invalid-timer', 'invalid-kind', 'invalid-output'] as const)('rejects workflow misuse: %s', async mode => {
  const f = fixture({ maxSteps: 1 });
  f.worker.register({ name: 'test', version: 1, async run(_input, ctx) {
    if (mode === 'invalid-timer') return ctx.sleepUntil('timer', new Date(NaN));
    if (mode === 'invalid-output') return undefined as unknown as Json;
    if (mode === 'invalid-kind') return ctx.step('s', { kind: 'gate' as 'external', input: null }, async () => null);
    const step = (key: string) => ctx.step(key, { kind: 'replayable', input: null }, async () => null);
    if (mode === 'parallel') return Promise.all([step('a'), step('b')]);
    await step('a'); return step(mode === 'duplicate' ? 'a' : 'b');
  } });
  await f.run(); expect(f.store.finish).not.toHaveBeenCalled(); expect(f.store.fail).toHaveBeenCalled();
});
it('validates configuration, registration, effect timeout and caller identities', async () => {
  for (const options of [{ leaseMs: 29 }, { leaseMs: NaN }, { runTimeoutMs: 0 }, { retryDelayMs: -1 }, { maxSteps: 0 }, { maxSteps: 10001 }]) expect(() => fixture(options)).toThrow();
  const f = fixture(); const definition = { name: 'test', version: 1, run: async () => null };
  f.worker.register(definition); expect(() => f.worker.register(definition)).toThrow();
  expect(() => f.worker.register({ ...definition, name: '' })).toThrow(); expect(() => f.worker.register({ ...definition, version: 0 })).toThrow();
  await expect(f.worker.runOne('', 'worker')).rejects.toThrow(); await expect(f.worker.runOne('tenant', '')).rejects.toThrow();
  const g = fixture(); g.worker.register({ ...definition, run: async (_input, ctx) => ctx.step('x', { kind: 'external', input: null, timeoutMs: 0 }, async () => null) });
  await g.run(); expect(g.store.openStep).not.toHaveBeenCalled();
});
it('stops a late callback from committing after a timeout', async () => {
  const f = fixture(); let settle: (value: Json) => void = () => {};
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('late', { kind: 'external', input: null, timeoutMs: 5 }, async () => new Promise<Json>(resolve => { settle = resolve; })) });
  await f.run(); settle({ late: true }); await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.store.completeStep).not.toHaveBeenCalled();
});
it.each(['deadline', 'heartbeat'] as const)('never starts an external effect when journal preparation resolves after %s abort', async reason => {
  const f = fixture({ leaseMs: 30, runTimeoutMs: reason === 'deadline' ? 5 : 1000 });
  let release: (value: { state: 'execute' }) => void = () => {};
  vi.mocked(f.store.openStep).mockImplementation(async () => new Promise(resolve => { release = resolve; }));
  if (reason === 'heartbeat') vi.mocked(f.store.heartbeat).mockRejectedValue(new DurableError('LEASE_LOST', 'lost'));
  const effect = vi.fn(async () => 'must never happen');
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('remote', { kind: 'external', input: null }, effect) });
  await f.run(); release({ state: 'execute' }); await new Promise(resolve => setTimeout(resolve, 5));
  expect(effect).not.toHaveBeenCalled(); expect(f.store.completeStep).not.toHaveBeenCalled();
});
it('bounds an unawaited external step and observes its rejection internally', async () => {
  const f = fixture(); const effect = vi.fn(async () => null);
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => { void ctx.step('floating', { kind: 'external', input: null }, effect); return null; } });
  await f.run(); await new Promise(resolve => setTimeout(resolve, 5));
  expect(f.store.finish).not.toHaveBeenCalled(); expect(f.store.fail).toHaveBeenCalled(); expect(f.store.completeStep).not.toHaveBeenCalled();
});
it.each(['timeout', 'kind', 'timer', 'caught'] as const)('cannot report success after an invalid context operation (%s)', async mode => {
  const f = fixture(); const effect = vi.fn(async () => null);
  f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => {
    if (mode === 'timer') void ctx.sleepUntil('bad', new Date(NaN));
    else if (mode === 'kind') void ctx.step('bad', { kind: 'gate' as 'external', input: null }, effect);
    else if (mode === 'caught') { try { await ctx.step('bad', { kind: 'external', input: null, timeoutMs: 0 }, effect); } catch { return 'fallback'; } }
    else void ctx.step('bad', { kind: 'external', input: null, timeoutMs: 0 }, effect);
    return null;
  } });
  await f.run(); expect(f.store.finish).not.toHaveBeenCalled(); expect(f.store.fail).toHaveBeenCalled(); expect(effect).not.toHaveBeenCalled();
});
it('fingerprints include operation kind and input, and step identity is tenant scoped', async () => {
  const specifications: StepSpec[] = [];
  for (const kind of ['external', 'replayable'] as const) {
    const f = fixture(); vi.mocked(f.store.openStep).mockImplementation(async (_lease, spec) => { specifications.push(spec); return { state: 'execute' }; });
    f.worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('s', { kind, input: 1 }, async () => null) }); await f.run();
  }
  expect(specifications[0]?.fingerprint).not.toBe(specifications[1]?.fingerprint); expect(specifications[0]?.idempotencyKey).not.toBe(specifications[1]?.idempotencyKey);
});

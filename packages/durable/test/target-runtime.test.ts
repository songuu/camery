import { expect, it, vi } from 'vitest';
import { DurableWorker, stepIdempotencyKey } from '../src/runtime.js';
import type { ClaimedTask, DurableStore, Task, TaskKey } from '../src/types.js';

function fixture() {
  const task: Task = { tenantId: 'tenant-a', taskId: 'target-a', workflow: 'target-test', version: 1, input: { original: true }, maxAttempts: 3, availableAt: null,
    status: 'running', attempts: 1, fence: 1, owner: 'worker-a', leaseUntil: new Date('2099-01-01'), output: null, error: null };
  const receipt = (): ClaimedTask => ({ task: structuredClone(task), lease: { tenantId: task.tenantId, taskId: task.taskId, owner: 'worker-a', fence: 1 } });
  const claimTask = vi.fn(async (_key: TaskKey, _worker: string, _duration: number) => receipt() as ClaimedTask | null);
  const store: DurableStore & { claimTask: typeof claimTask } = { enqueue: vi.fn(), get: vi.fn(async () => structuredClone(task)), steps: vi.fn(), events: vi.fn(),
    claim: vi.fn(async () => receipt()), claimTask, heartbeat: vi.fn(async () => {}), openStep: vi.fn(async () => ({ state: 'execute' as const })), completeStep: vi.fn(async () => {}), failStep: vi.fn(async () => {}),
    finish: vi.fn(async (_lease, output) => { task.status = 'succeeded'; task.output = output; }), fail: vi.fn(async () => {}), cancel: vi.fn(), signal: vi.fn(), reconcile: vi.fn() };
  const worker = new DurableWorker(store); const key = { tenantId: task.tenantId, taskId: task.taskId }; return { task, key, receipt, store, worker };
}
it('checks registered workflow names and exact versions without claiming work', () => {
  const f = fixture(); expect(f.worker.hasWorkflow('target-test', 1)).toBe(false); f.worker.register({ name: 'target-test', version: 1, run: async () => null });
  expect(f.worker.hasWorkflow('target-test', 1)).toBe(true); expect(f.worker.hasWorkflow('target-test', 2)).toBe(false);
  for (const [name, version] of [['', 1], ['target-test', 0], ['target-test', NaN]] as const) expect(() => f.worker.hasWorkflow(name, version)).toThrow();
  expect(f.store.claim).not.toHaveBeenCalled(); expect(f.store.claimTask).not.toHaveBeenCalled();
});
it('runs only the exact claimed task and shares step execution semantics with runOne', async () => {
  for (const mode of ['target', 'queue'] as const) {
    const f = fixture(); const effect = vi.fn(async () => ({ saved: true }));
    f.worker.register({ name: 'target-test', version: 1, run: async (_input, ctx) => { expect(ctx.task).toEqual(f.key); return ctx.step('saved', { kind: 'external', input: null }, effect); } });
    const result = mode === 'target' ? await f.worker.runTask(f.key, 'worker-a') : await f.worker.runOne(f.key.tenantId, 'worker-a');
    expect(result).toMatchObject({ status: 'succeeded', output: { saved: true } }); expect(effect).toHaveBeenCalledOnce(); expect(f.store.finish).toHaveBeenCalledWith(expect.objectContaining(f.key), { saved: true }, 1);
    if (mode === 'target') { expect(f.store.claimTask).toHaveBeenCalledWith(f.key, 'worker-a', 30_000); expect(f.store.claim).not.toHaveBeenCalled(); }
    else expect(f.store.claimTask).not.toHaveBeenCalled();
  }
});
it('returns null without a queue fallback when the exact task is not claimable', async () => {
  const f = fixture(); f.store.claimTask.mockResolvedValue(null); const handler = vi.fn(async () => null); f.worker.register({ name: 'target-test', version: 1, run: handler });
  expect(await f.worker.runTask(f.key, 'worker-a')).toBeNull(); expect(handler).not.toHaveBeenCalled(); expect(f.store.claim).not.toHaveBeenCalled();
});
it('rejects a missing exact-claim capability before claiming or executing any task', async () => {
  const f = fixture(); const { claimTask: _claim, ...store } = f.store; const worker = new DurableWorker(store);
  await expect(worker.runTask(f.key, 'worker-a')).rejects.toMatchObject({ code: 'STORE_CAPABILITY' }); expect(f.store.claim).not.toHaveBeenCalled(); expect(f.store.finish).not.toHaveBeenCalled();
});
it.each(['task-tenant', 'task-id', 'lease-tenant', 'lease-id', 'lease-owner', 'task-owner', 'fence', 'status'] as const)('does not execute a mismatched claim receipt: %s', async field => {
  const f = fixture(); const receipt = f.receipt();
  if (field === 'task-tenant') receipt.task.tenantId = 'other';
  if (field === 'task-id') receipt.task.taskId = 'other';
  if (field === 'lease-tenant') receipt.lease.tenantId = 'other';
  if (field === 'lease-id') receipt.lease.taskId = 'other';
  if (field === 'lease-owner') receipt.lease.owner = 'other';
  if (field === 'task-owner') receipt.task.owner = 'other';
  if (field === 'fence') receipt.task.fence = receipt.lease.fence + 1;
  if (field === 'status') receipt.task.status = 'queued';
  f.store.claimTask.mockResolvedValue(receipt); const handler = vi.fn(async () => null); f.worker.register({ name: 'target-test', version: 1, run: handler });
  await expect(f.worker.runTask(f.key, 'worker-a')).rejects.toMatchObject({ code: 'STORE_PROTOCOL' }); expect(handler).not.toHaveBeenCalled(); expect(f.store.claim).not.toHaveBeenCalled(); expect(f.store.fail).not.toHaveBeenCalled();
});
it('captures the input key before awaiting claim and detaches the returned task before the handler runs', async () => {
  const f = fixture(); const key = { ...f.key }; const receipt = f.receipt(); let release: () => void = () => {}; const waiting = new Promise<void>(resolve => { release = resolve; });
  f.store.claimTask.mockImplementation(async captured => { expect(Object.isFrozen(captured)).toBe(true); await waiting; expect(captured).toEqual(f.key); return receipt; });
  f.worker.register({ name: 'target-test', version: 1, run: async input => input }); const pending = f.worker.runTask(key, 'worker-a'); key.tenantId = 'other'; key.taskId = 'other'; release();
  expect((await pending)?.output).toEqual({ original: true }); expect(f.store.claim).not.toHaveBeenCalled();
});
it('keeps the returned receipt detached while an asynchronous handler is suspended', async () => {
  const f = fixture(); const receipt = f.receipt(); f.store.claimTask.mockResolvedValue(receipt);
  let entered: () => void = () => {}; const ready = new Promise<void>(resolve => { entered = resolve; }); let release: () => void = () => {}; const waiting = new Promise<void>(resolve => { release = resolve; });
  f.worker.register({ name: 'target-test', version: 1, async run(input, ctx) { entered(); await waiting; expect(ctx.task).toEqual(f.key); return ctx.step('saved', { kind: 'replayable', input }, async effect => effect.input); } });
  const pending = f.worker.runTask(f.key, 'worker-a'); await ready;
  receipt.task.tenantId = 'foreign'; receipt.task.taskId = 'foreign'; (receipt.task.input as Record<string, unknown>)['original'] = false; receipt.lease.taskId = 'foreign'; release();
  expect((await pending)?.output).toEqual({ original: true });
  expect(f.store.openStep).toHaveBeenCalledWith(expect.objectContaining(f.key), expect.objectContaining({ idempotencyKey: stepIdempotencyKey(f.key, 'saved') }), undefined);
  expect(f.store.finish).toHaveBeenCalledWith(expect.objectContaining(f.key), { original: true }, 1);
});
it('validates target scope and worker identity before touching storage and replays a saved step without reexecution', async () => {
  const f = fixture();
  for (const [key, worker] of [[{ ...f.key, tenantId: '' }, 'worker-a'], [{ ...f.key, taskId: '' }, 'worker-a'], [f.key, '']] as const) await expect(f.worker.runTask(key, worker)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  let accessed = false; const accessor = Object.defineProperty({ taskId: f.key.taskId }, 'tenantId', { enumerable: true, get: () => { accessed = true; return f.key.tenantId; } });
  await expect(f.worker.runTask(accessor as TaskKey, 'worker-a')).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(accessed).toBe(false);
  expect(f.store.claimTask).not.toHaveBeenCalled(); const effect = vi.fn(async () => null); vi.mocked(f.store.openStep).mockResolvedValue({ state: 'cached', output: { retained: true } });
  f.worker.register({ name: 'target-test', version: 1, run: async (_input, ctx) => ctx.step('saved', { kind: 'external', input: null }, effect) });
  expect((await f.worker.runTask(f.key, 'worker-a'))?.output).toEqual({ retained: true }); expect(effect).not.toHaveBeenCalled();
});

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker } from '../src/runtime.js';
import { PostgresDurableStore } from '../src/store.js';
import { migrateDurable } from '../src/migrate.js';
import { makeTask, testPool } from './support.js';
const pool = testPool(); const store = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); }); afterAll(async () => { await pool.end(); });
it('executes an exact target even with an earlier unrelated task queued in the same tenant', async () => {
  const foreign = makeTask({ workflow: 'foreign-workflow', availableAt: new Date('2020-01-01') }); const target = makeTask({ tenantId: foreign.tenantId, workflow: 'target-workflow' }); await store.enqueue(foreign); await store.enqueue(target);
  const worker = new DurableWorker(store); const handler = vi.fn(async () => ({ target: true })); worker.register({ name: 'target-workflow', version: 1, run: handler });
  expect((await worker.runTask(target, 'target-worker'))?.output).toEqual({ target: true }); expect(handler).toHaveBeenCalledOnce();
  expect(await store.get(foreign)).toMatchObject({ status: 'queued', attempts: 0, fence: 0 }); expect((await store.events(foreign)).map(event => event.action)).toEqual(['enqueued']);
});
it('returns null for another tenant, missing targets and future work without falling back to due work', async () => {
  const other = makeTask(); const future = makeTask({ tenantId: other.tenantId, availableAt: new Date('2099-01-01') }); await store.enqueue(other); await store.enqueue(future);
  const worker = new DurableWorker(store); const handler = vi.fn(async () => null); worker.register({ name: 'test', version: 1, run: handler });
  for (const key of [{ tenantId: randomUUID(), taskId: other.taskId }, { tenantId: other.tenantId, taskId: randomUUID() }, future]) expect(await worker.runTask(key, 'target-worker')).toBeNull();
  expect(handler).not.toHaveBeenCalled(); expect(await store.get(other)).toMatchObject({ status: 'queued', attempts: 0 }); expect(await store.get(future)).toMatchObject({ status: 'queued', attempts: 0 });
});
it('atomically grants one lease to competing exact claims without touching other tasks', async () => {
  const target = makeTask(); const other = makeTask({ tenantId: target.tenantId }); await store.enqueue(target); await store.enqueue(other);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => store.claimTask(target, `worker-${index}`, 30_000)));
  expect(results.filter(Boolean)).toHaveLength(1); expect(await store.get(target)).toMatchObject({ status: 'running', attempts: 1, fence: 1 }); expect(await store.get(other)).toMatchObject({ status: 'queued', attempts: 0 });
});
it('turns only the expired target external step into reconciling and does not sweep another expired task', async () => {
  const target = makeTask(); const other = makeTask({ tenantId: target.tenantId }); await store.enqueue(target); await store.enqueue(other);
  const claimed = (await store.claimTask(target, 'lost-worker', 30_000))!; const untouched = (await store.claimTask(other, 'other-worker', 30_000))!;
  const spec = { key: 'external', position: 0, kind: 'external' as const, input: null, fingerprint: 'a'.repeat(64), idempotencyKey: 'target-external' }; await store.openStep(claimed.lease, spec);
  await store.openStep(untouched.lease, { ...spec, idempotencyKey: 'other-external' });
  await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=ANY($2::text[])", [target.tenantId, [target.taskId, other.taskId]]);
  expect(await store.claimTask(target, 'recovery', 30_000)).toBeNull(); expect(await store.get(target)).toMatchObject({ status: 'reconciling' }); expect((await store.steps(target))[0]?.status).toBe('unknown');
  expect(await store.get(other)).toMatchObject({ status: 'running', owner: 'other-worker', attempts: 1 }); expect((await store.steps(other))[0]?.status).toBe('running');
  expect((await store.events(other)).some(event => event.action === 'reconciliation_required')).toBe(false);
});
it('exhausts only the target failure budget after a replayable worker lease expires', async () => {
  const target = makeTask({ maxAttempts: 1 }); const other = makeTask({ tenantId: target.tenantId }); await store.enqueue(target); await store.enqueue(other);
  const claimed = (await store.claimTask(target, 'lost-worker', 30_000))!;
  await store.openStep(claimed.lease, { key: 'local', position: 0, kind: 'replayable', input: null, fingerprint: 'a'.repeat(64), idempotencyKey: 'target-local' });
  await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2", [target.tenantId, target.taskId]);
  expect(await store.claimTask(target, 'recovery', 30_000)).toBeNull(); expect(await store.get(target)).toMatchObject({ status: 'failed' }); expect(await store.get(other)).toMatchObject({ status: 'queued', attempts: 0 });
});
it('reclaims a recoverable local target with a higher fence and rejects stale writes', async () => {
  const target = makeTask(); const other = makeTask({ tenantId: target.tenantId }); await store.enqueue(target); await store.enqueue(other);
  const old = (await store.claimTask(target, 'lost-worker', 30_000))!; const spec = { key: 'local', position: 0, kind: 'replayable' as const, input: null, fingerprint: 'a'.repeat(64), idempotencyKey: 'stable-target-local' };
  await store.openStep(old.lease, spec); await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2", [target.tenantId, target.taskId]);
  const current = (await store.claimTask(target, 'recovery-worker', 30_000))!; expect(current.task).toMatchObject({ status: 'running', attempts: 2, fence: old.task.fence + 1 });
  await expect(store.heartbeat(old.lease, 30_000)).rejects.toMatchObject({ code: 'LEASE_LOST' }); await expect(store.completeStep(old.lease, spec.key, { stale: true })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  expect(await store.openStep(current.lease, spec)).toEqual({ state: 'execute' }); expect(await store.get(other)).toMatchObject({ status: 'queued', attempts: 0 });
});
it('resumes only a due target timer without consuming its failure budget', async () => {
  const target = makeTask({ maxAttempts: 1 }); const other = makeTask({ tenantId: target.tenantId }); await store.enqueue(target); await store.enqueue(other);
  const first = (await store.claimTask(target, 'timer-worker', 30_000))!; const at = new Date('2099-01-01');
  await store.openStep(first.lease, { key: 'due', position: 0, kind: 'timer', input: at.toISOString(), fingerprint: 'a'.repeat(64), idempotencyKey: 'target-due' }, at);
  expect(await store.claimTask(target, 'too-early', 30_000)).toBeNull();
  // Seed a due deadline in this random task only, avoiding a timing-sensitive wall-clock sleep.
  await pool.query("UPDATE camery_durable.steps SET due_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2 AND step_key='due'", [target.tenantId, target.taskId]);
  await pool.query("UPDATE camery_durable.tasks SET available_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2", [target.tenantId, target.taskId]);
  expect((await store.claimTask(target, 'due-worker', 30_000))?.task).toMatchObject({ status: 'running', attempts: 2, fence: 2 }); expect((await store.steps(target))[0]).toMatchObject({ status: 'completed', output: null });
  expect(await store.get(other)).toMatchObject({ status: 'queued', attempts: 0 });
});
it.each(['target-then-queue', 'queue-then-target'] as const)('shares persisted gate recovery between worker entry points: %s', async order => {
  const target = makeTask({ maxAttempts: 1 }); await store.enqueue(target); const effect = vi.fn(async () => ({ retained: true })); const worker = new DurableWorker(store);
  worker.register({ name: 'test', version: 1, async run(_input, ctx) { const saved = await ctx.step('saved', { kind: 'external', input: null }, effect); await ctx.waitForSignal('review', saved); return saved; } });
  const first = order === 'target-then-queue' ? await worker.runTask(target, 'first-worker') : await worker.runOne(target.tenantId, 'first-worker'); expect(first?.status).toBe('waiting');
  await store.signal({ tenantId: target.tenantId, taskId: target.taskId, gateKey: 'review', signalId: 'answer', actorId: 'host-human', value: { accepted: true } });
  const resumed = order === 'target-then-queue' ? await worker.runOne(target.tenantId, 'resume-worker') : await worker.runTask(target, 'resume-worker');
  expect(resumed).toMatchObject({ status: 'succeeded', output: { retained: true }, attempts: 2 }); expect(effect).toHaveBeenCalledOnce();
});

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { migrateDurable } from '../src/migrate.js';
import { PostgresDurableStore } from '../src/store.js';
import type { ClaimedTask, StepSpec } from '../src/types.js';
import { makeTask, testPool } from './support.js';

const pool = testPool();
const store = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); });
afterAll(async () => { await pool.end(); });
const step = (key = 'one', position = 0, kind: StepSpec['kind'] = 'replayable'): StepSpec => ({ key, position, kind, input: { key }, fingerprint: createHash('sha256').update(key).digest('hex'), idempotencyKey: `idempotent-${key}` });
async function claimed(maxAttempts = 3): Promise<ClaimedTask> {
  const task = makeTask({ maxAttempts });
  await store.enqueue(task);
  return (await store.claim(task.tenantId, 'worker', 30000))!;
}
async function expire(claim: ClaimedTask) {
  await pool.query('UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval \'1 second\' WHERE tenant_id=$1 AND task_id=$2', [claim.lease.tenantId, claim.lease.taskId]);
}

describe('PostgreSQL durable journal', () => {
  it('migration can run concurrently and repeatedly without losing data', async () => {
    const claim = await claimed();
    await Promise.all([migrateDurable(pool), migrateDurable(pool)]);
    expect((await store.get(claim.lease))?.status).toBe('running');
  });
  it('enqueue is idempotent, rejects divergent identity, isolates tenants', async () => {
    const task = makeTask();
    expect(await store.enqueue(task)).toEqual(await store.enqueue(task));
    await expect(store.enqueue({ ...task, input: { changed: true } })).rejects.toMatchObject({ code: 'TASK_CONFLICT' });
    expect(await store.get({ ...task, tenantId: randomUUID() })).toBeNull();
    expect(await store.steps({ ...task, tenantId: randomUUID() })).toEqual([]);
    expect(await store.events({ ...task, tenantId: randomUUID() })).toEqual([]);
    expect(await store.enqueue({ ...task, tenantId: randomUUID() })).toMatchObject({ taskId: task.taskId });
  });
  it('concurrent claims have one winner and future work remains scheduled', async () => {
    const task = makeTask(); await store.enqueue(task);
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => store.claim(task.tenantId, `worker-${i}`, 30000)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const future = makeTask({ availableAt: new Date(Date.now() + 60000) }); await store.enqueue(future);
    expect(await store.claim(future.tenantId, 'worker', 30000)).toBeNull();
  });
  it('expired replayable work is fenced and resumes completed journal results', async () => {
    const claim = await claimed();
    expect(await store.openStep(claim.lease, step())).toEqual({ state: 'execute' });
    await store.completeStep(claim.lease, 'one', { committed: true });
    await store.openStep(claim.lease, step('two', 1));
    await expire(claim);
    await expect(store.heartbeat(claim.lease, 30000)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const next = (await store.claim(claim.task.tenantId, 'new-worker', 30000))!;
    expect(next.lease.fence).toBeGreaterThan(claim.lease.fence);
    await expect(store.completeStep(claim.lease, 'two', null)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await store.openStep(next.lease, step())).toEqual({ state: 'cached', output: { committed: true } });
    expect(await store.openStep(next.lease, step('two', 1))).toEqual({ state: 'execute' });
    await store.completeStep(next.lease, 'two', 42);
    await store.finish(next.lease, { result: 42 }, 2);
    expect(await store.get(next.lease)).toMatchObject({ status: 'succeeded', output: { result: 42 }, attempts: 2 });
  });
  it('heartbeat extends a live lease but never revives an expired one', async () => {
    const claim = await claimed();
    const before = (await store.get(claim.lease))!.leaseUntil!;
    await store.heartbeat(claim.lease, 60000);
    expect((await store.get(claim.lease))!.leaseUntil!.getTime()).toBeGreaterThan(before.getTime());
    await expire(claim);
    await expect(store.finish(claim.lease, null, 0)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it('unknown external outcomes suspend recovery until explicit reconciliation', async () => {
    const claim = await claimed();
    await store.openStep(claim.lease, step('paid', 0, 'external'));
    await expire(claim);
    expect(await store.claim(claim.task.tenantId, 'other', 30000)).toBeNull();
    expect(await store.get(claim.lease)).toMatchObject({ status: 'reconciling' });
    expect(await store.steps(claim.lease)).toMatchObject([{ status: 'unknown' }]);
    await store.reconcile({ ...claim.lease, actorId: 'operator', stepKey: 'paid', resolution: { kind: 'completed', output: { remoteId: 'paid-1' } } });
    const next = (await store.claim(claim.task.tenantId, 'other', 30000))!;
    expect(await store.openStep(next.lease, step('paid', 0, 'external'))).toEqual({ state: 'cached', output: { remoteId: 'paid-1' } });
    await store.finish(next.lease, null, 1);
  });
  it('failed external requests stay uncertain, explicit retry cannot resurrect cancellation', async () => {
    const claim = await claimed(); await store.openStep(claim.lease, step('paid', 0, 'external'));
    await store.failStep(claim.lease, 'paid', 'timeout', true);
    expect((await store.get(claim.lease))?.status).toBe('reconciling');
    await store.cancel(claim.lease, 'operator');
    await store.reconcile({ ...claim.lease, actorId: 'operator', stepKey: 'paid', resolution: { kind: 'retry', reason: 'remote provider confirmed no operation exists' } });
    expect((await store.get(claim.lease))?.status).toBe('cancelled');
    expect(await store.claim(claim.task.tenantId, 'other', 30000)).toBeNull();
  });
  it('retry delay and exhaustion persist across independent workers', async () => {
    const claim = await claimed(2);
    await store.openStep(claim.lease, step());
    await store.failStep(claim.lease, 'one', 'transient', false);
    await store.fail(claim.lease, 'transient', 60000);
    expect(await store.claim(claim.task.tenantId, 'other', 30000)).toBeNull();
    await pool.query('UPDATE camery_durable.tasks SET available_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2', [claim.task.tenantId, claim.task.taskId]);
    const next = (await store.claim(claim.task.tenantId, 'other', 30000))!;
    await store.openStep(next.lease, step()); await store.failStep(next.lease, 'one', 'permanent', false);
    await store.fail(next.lease, 'permanent', 0);
    expect((await store.get(next.lease))?.status).toBe('failed');
    expect(await store.claim(claim.task.tenantId, 'last', 30000)).toBeNull();
  });
  it('repeated worker deaths exhaust the same failure budget', async () => {
    const claim = await claimed(1); await store.openStep(claim.lease, step()); await expire(claim);
    expect(await store.claim(claim.task.tenantId, 'other', 30000)).toBeNull();
    expect((await store.get(claim.lease))?.status).toBe('failed');
  });
  it('gate signals are scoped, idempotent and do not burn failure budget', async () => {
    const claim = await claimed(1);
    expect(await store.openStep(claim.lease, step('approve', 0, 'gate'))).toEqual({ state: 'suspended' });
    expect(await store.claim(claim.task.tenantId, 'other', 30000)).toBeNull();
    const signal = { ...claim.lease, actorId: 'human', gateKey: 'approve', signalId: 'signal-1', value: { approved: true } };
    await expect(store.signal({ ...signal, tenantId: randomUUID() })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
    await store.signal(signal); await store.signal(signal);
    await expect(store.signal({ ...signal, value: false })).rejects.toMatchObject({ code: 'SIGNAL_CONFLICT' });
    await expect(store.signal({ ...signal, signalId: 'different' })).rejects.toMatchObject({ code: 'GATE_NOT_WAITING' });
    const next = (await store.claim(claim.task.tenantId, 'other', 30000))!;
    expect(await store.openStep(next.lease, step('approve', 0, 'gate'))).toEqual({ state: 'cached', output: { approved: true } });
    await store.finish(next.lease, true, 1);
  });
  it('timers survive release and resume only after database time is due', async () => {
    const claim = await claimed(1);
    expect(await store.openStep(claim.lease, step('sleep', 0, 'timer'), new Date(Date.now() + 60000))).toEqual({ state: 'suspended' });
    expect(await store.claim(claim.task.tenantId, 'other', 30000)).toBeNull();
    await pool.query('UPDATE camery_durable.steps SET due_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2', [claim.task.tenantId, claim.task.taskId]);
    await pool.query('UPDATE camery_durable.tasks SET available_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2', [claim.task.tenantId, claim.task.taskId]);
    const next = (await store.claim(claim.task.tenantId, 'other', 30000))!;
    expect(await store.openStep(next.lease, step('sleep', 0, 'timer'), new Date(0))).toEqual({ state: 'cached', output: null });
    expect(await store.openStep(next.lease, step('already-due', 1, 'timer'), new Date(0))).toEqual({ state: 'cached', output: null });
    await store.finish(next.lease, null, 2);
  });
  it('cancellation revokes active leases and preserves external uncertainty', async () => {
    const claim = await claimed(); await store.openStep(claim.lease, step('paid', 0, 'external'));
    await store.cancel(claim.lease, 'human'); await store.cancel(claim.lease, 'human');
    await expect(store.completeStep(claim.lease, 'paid', 'late')).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await store.steps(claim.lease)).toMatchObject([{ status: 'unknown' }]);
    expect((await store.events(claim.lease)).filter(event => event.action === 'cancelled')).toHaveLength(1);
  });
  it('journal rejects changed inputs, reordered steps and incomplete workflow success', async () => {
    const claim = await claimed(); await store.openStep(claim.lease, step());
    await expect(store.openStep(claim.lease, { ...step(), fingerprint: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    await expect(store.openStep(claim.lease, step('other'))).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    await expect(store.finish(claim.lease, null, 1)).rejects.toMatchObject({ code: 'JOURNAL_INCOMPLETE' });
    await store.completeStep(claim.lease, 'one', null);
    await expect(store.finish(claim.lease, null, 0)).rejects.toMatchObject({ code: 'JOURNAL_INCOMPLETE' });
  });
  it('invalid write requests fail before mutating the journal', async () => {
    const claim = await claimed();
    await expect(store.openStep(claim.lease, step('timer', 0, 'timer'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.openStep(claim.lease, step('timer', 0, 'timer'), new Date(NaN))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.openStep(claim.lease, step(), new Date())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.finish(claim.lease, null, -1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.fail(claim.lease, 'failure', -1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.fail(claim.lease, 'failure', 86400001)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.fail(claim.lease, '', 0)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.failStep(claim.lease, 'one', 'failure', undefined as unknown as boolean)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(store.completeStep(claim.lease, 'missing', null)).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    await expect(store.failStep(claim.lease, 'missing', 'failure', false)).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    expect(await store.steps(claim.lease)).toEqual([]);
  });
  it('a live step cannot execute twice or hide an uncertain external request in task failure', async () => {
    const claim = await claimed();
    await store.openStep(claim.lease, step());
    await expect(store.openStep(claim.lease, step())).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    await expect(store.openStep(claim.lease, step('next', 1))).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    await expect(store.failStep(claim.lease, 'one', 'uncertain', true)).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    await store.completeStep(claim.lease, 'one', null);
    await store.openStep(claim.lease, step('paid', 1, 'external'));
    await store.fail(claim.lease, 'handler threw before persisting paid result', 0);
    expect((await store.get(claim.lease))?.status).toBe('reconciling');
    expect((await store.steps(claim.lease))[1]?.status).toBe('unknown');
    await expect(store.reconcile({ ...claim.lease, actorId: 'operator', stepKey: 'one', resolution: { kind: 'completed', output: null } })).rejects.toMatchObject({ code: 'NOT_UNCERTAIN' });
  });
  it('known absent external operations retry only after explicit evidence', async () => {
    const claim = await claimed(); await store.openStep(claim.lease, step('paid', 0, 'external'));
    await store.failStep(claim.lease, 'paid', 'timeout', true);
    await store.reconcile({ ...claim.lease, actorId: 'operator', stepKey: 'paid', resolution: { kind: 'retry', reason: 'provider lookup confirmed absence' } });
    const next = (await store.claim(claim.task.tenantId, 'other', 30000))!;
    expect(await store.openStep(next.lease, step('paid', 0, 'external'))).toEqual({ state: 'execute' });
    await store.completeStep(next.lease, 'paid', 'remote-result'); await store.finish(next.lease, null, 1);
    expect((await store.events(next.lease)).find(item => item.action === 'reconciled')?.detail).toEqual({ actorId: 'operator', key: 'paid', resolution: { kind: 'retry', reason: 'provider lookup confirmed absence' } });
    await expect(store.cancel(next.lease, 'human')).rejects.toMatchObject({ code: 'TERMINAL_TASK' });
  });
  it('external uncertainty cannot be bypassed with failStep uncertain=false', async () => {
    const claim = await claimed(); await store.openStep(claim.lease, step('paid', 0, 'external'));
    await expect(store.failStep(claim.lease, 'paid', 'provider timeout', false)).rejects.toMatchObject({ code: 'STEP_CONFLICT' });
    await store.fail(claim.lease, 'provider timeout', 0);
    expect((await store.get(claim.lease))?.status).toBe('reconciling');
    expect(await store.claim(claim.task.tenantId, 'other', 30000)).toBeNull();
    expect((await store.steps(claim.lease))[0]?.status).toBe('unknown');
  });
  it('independent tenants cannot signal or reconcile each other through the same task identifier', async () => {
    const claim = await claimed(); await store.openStep(claim.lease, step('paid', 0, 'external'));
    await store.failStep(claim.lease, 'paid', 'timeout', true);
    const other = makeTask({ taskId: claim.task.taskId }); await store.enqueue(other);
    await expect(store.reconcile({ ...other, actorId: 'operator', stepKey: 'paid', resolution: { kind: 'completed', output: 'forged' } })).rejects.toMatchObject({ code: 'NOT_UNCERTAIN' });
    expect((await store.get(claim.lease))?.status).toBe('reconciling');
    expect((await store.events(other)).map(item => item.action)).toEqual(['enqueued']);
  });
  it('migration refuses changed or future history and rolls back safely', async () => {
    for (const version of [1, 2]) {
      const connection = { query: vi.fn(async (query: string) => ({ rows: query.startsWith('SELECT version') ? [{ version, checksum: 'modified' }] : [] })), release: vi.fn() };
      const fake = { connect: async () => connection } as unknown as Pool;
      await expect(migrateDurable(fake)).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' });
      expect(connection.query).toHaveBeenCalledWith('ROLLBACK'); expect(connection.release).toHaveBeenCalledOnce();
    }
  });
  it('fresh migration commits DDL and its checksum together', async () => {
    const connection = { query: vi.fn(async (_query: string, _parameters?: unknown[]) => ({ rows: [] })), release: vi.fn() };
    await migrateDurable({ connect: async () => connection } as unknown as Pool);
    const statements = connection.query.mock.calls.map(call => String(call[0]));
    expect(statements.some(query => query.includes('CREATE TABLE camery_durable.tasks'))).toBe(true);
    expect(statements.some(query => query.includes('INSERT INTO camery_durable.migrations'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT'); expect(connection.release).toHaveBeenCalledOnce();
  });
});

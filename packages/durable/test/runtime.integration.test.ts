import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker } from '../src/runtime.js';
import { PostgresDurableStore } from '../src/store.js';
import { migrateDurable } from '../src/migrate.js';
import type { Json } from '../src/types.js';
import { makeTask, testPool } from './support.js';
const pool = testPool(); const store = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); });
afterAll(async () => { await pool.end(); });

function child(tenantId: string, kind: 'replayable' | 'external', phase: 'crash' | 'resume' | 'floating') {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...globalThis.process.env, CAMERY_FAULT_TENANT: tenantId, CAMERY_FAULT_KIND: kind, CAMERY_FAULT_PHASE: phase },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const messages: { event: string; status?: string }[] = [];
  const listeners = new Map<string, () => void>();
  process.on('message', message => {
    if (message && typeof message === 'object' && 'event' in message) {
      const item = message as { event: string; status?: string }; messages.push(item); listeners.get(item.event)?.();
    }
  });
  const exit = once(process, 'exit');
  async function wait(event: string): Promise<void> {
    if (messages.some(item => item.event === event)) return;
    let timeout: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([new Promise<void>(resolve => { listeners.set(event, resolve); }),
        exit.then(() => { if (!messages.some(item => item.event === event)) throw new Error(`Fault worker exited before ${event}`); }),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(`Fault worker did not reach ${event}`)), 30_000); })]);
    } finally { clearTimeout(timeout!); listeners.delete(event); }
  }
  return { process, messages, exit, wait };
}
async function expire(tenantId: string, taskId: string) {
  await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2", [tenantId, taskId]);
}
it('kills a real worker after a committed external result, restarts another process and never repeats the paid step', async () => {
  const task = makeTask({ workflow: 'crash' }); await store.enqueue(task);
  const first = child(task.tenantId, 'replayable', 'crash');
  try {
    await first.wait('blocked'); expect((await store.steps(task))[0]?.status).toBe('completed');
    first.process.kill('SIGKILL'); await first.exit; await expire(task.tenantId, task.taskId);
    const resumed = child(task.tenantId, 'replayable', 'resume');
    try { await resumed.wait('done'); await resumed.exit; expect(resumed.messages.filter(item => item.event === 'paid')).toHaveLength(0); }
    finally { resumed.process.kill(); }
    expect(first.messages.filter(item => item.event === 'paid')).toHaveLength(1);
    expect((await store.get(task))?.status).toBe('succeeded'); expect((await store.get(task))?.output).toEqual({ providerId: 'paid-once' });
    expect((await store.events(task)).some(event => event.action === 'lease_expired')).toBe(true);
  } finally { first.process.kill(); }
});
it('kills a worker during an external step and requires reconciliation before replay', async () => {
  const task = makeTask({ workflow: 'crash' }); await store.enqueue(task);
  const first = child(task.tenantId, 'external', 'crash');
  try {
    await first.wait('blocked'); first.process.kill('SIGKILL'); await first.exit; await expire(task.tenantId, task.taskId);
    expect(await store.claim(task.tenantId, 'recovery', 1000)).toBeNull(); expect((await store.get(task))?.status).toBe('reconciling');
    expect((await store.steps(task))[1]?.status).toBe('unknown');
    await store.reconcile({ ...task, stepKey: 'interrupted', actorId: 'trusted-operator', resolution: { kind: 'completed', output: { receipt: 'confirmed-at-provider' } } });
    const resumed = child(task.tenantId, 'external', 'resume');
    try { await resumed.wait('done'); await resumed.exit; expect(resumed.messages.filter(item => ['paid', 'blocked'].includes(item.event))).toHaveLength(0); }
    finally { resumed.process.kill(); }
    expect((await store.get(task))?.status).toBe('succeeded');
  } finally { first.process.kill(); }
});
it('releases a gate and timer durably without consuming the failure budget or rerunning saved effects', async () => {
  let at = new Date('2099-01-01'); const task = makeTask({ maxAttempts: 1 }); await store.enqueue(task);
  const effect = vi.fn(async () => ({ saved: true }));
  const worker = new DurableWorker(store);
  worker.register({ name: 'test', version: 1, async run(_input, ctx) {
    await ctx.step('saved', { kind: 'replayable', input: null }, effect);
    const approved = await ctx.waitForSignal('review', { question: 'approve?' });
    await ctx.sleepUntil('due', at); return approved;
  } });
  expect((await worker.runOne(task.tenantId, 'w1'))?.status).toBe('waiting');
  expect(await worker.runOne(task.tenantId, 'w2')).toBeNull();
  await store.signal({ ...task, gateKey: 'review', signalId: 's1', actorId: 'human', value: { approved: true } });
  at = new Date(Date.now() + 1000);
  let completed = await worker.runOne(task.tenantId, 'w2');
  if (completed?.status === 'waiting') {
    await new Promise(resolve => setTimeout(resolve, Math.max(1, at.getTime() - Date.now() + 10)));
    completed = await worker.runOne(task.tenantId, 'w3'); expect(completed?.attempts).toBe(3);
  } else { expect(Date.now()).toBeGreaterThanOrEqual(at.getTime()); expect(completed?.attempts).toBe(2); }
  expect(completed?.status).toBe('succeeded');
  expect(completed?.output).toEqual({ approved: true }); expect(effect).toHaveBeenCalledTimes(1);
});
it('cancellation during an external call fences its late result and retains unknown outcome for audit', async () => {
  const task = makeTask(); await store.enqueue(task); const worker = new DurableWorker(store);
  let release: (value: Json) => void = () => {}; let started: () => void = () => {};
  const start = new Promise<void>(resolve => { started = resolve; });
  worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('remote', { kind: 'external', input: null }, async () => { started(); return new Promise<Json>(resolve => { release = resolve; }); }) });
  const running = worker.runOne(task.tenantId, 'w'); await start; await store.cancel(task, 'human'); release('too late');
  expect((await running)?.status).toBe('cancelled'); expect((await store.steps(task))[0]?.status).toBe('unknown');
  await store.reconcile({ ...task, stepKey: 'remote', actorId: 'human', resolution: { kind: 'completed', output: 'provider confirmed completed despite cancellation' } });
  expect((await store.get(task))?.status).toBe('cancelled'); expect(await store.claim(task.tenantId, 'other', 1000)).toBeNull();
});
it('times out an external provider, preserves the same idempotency key and resumes only after evidence permits retry', async () => {
  const task = makeTask(); await store.enqueue(task); const calls: string[] = []; let retry = false;
  const worker = new DurableWorker(store);
  worker.register({ name: 'test', version: 1, run: async (_input, ctx) => ctx.step('remote', { kind: 'external', input: { request: 1 }, timeoutMs: 10 }, async ({ idempotencyKey }) => { calls.push(idempotencyKey); return retry ? 'ok' : new Promise<Json>(() => {}); }) });
  expect((await worker.runOne(task.tenantId, 'w'))?.status).toBe('reconciling'); expect(await worker.runOne(task.tenantId, 'w')).toBeNull();
  await store.reconcile({ ...task, stepKey: 'remote', actorId: 'operator', resolution: { kind: 'retry', reason: 'Provider request log confirms no submission was accepted' } });
  retry = true; expect((await worker.runOne(task.tenantId, 'w2'))?.status).toBe('succeeded'); expect(calls).toHaveLength(2); expect(calls[0]).toBe(calls[1]);
});
it('bounds invalid workflow results by failure budget and replays already completed steps', async () => {
  const task = makeTask({ maxAttempts: 2 }); await store.enqueue(task); const saved = vi.fn(async () => 1);
  const worker = new DurableWorker(store, { retryDelayMs: 1 });
  worker.register({ name: 'test', version: 1, async run(_input, ctx) { await ctx.step('saved', { kind: 'replayable', input: null }, saved); return NaN; } });
  expect((await worker.runOne(task.tenantId, 'w1'))?.status).toBe('queued');
  await pool.query('UPDATE camery_durable.tasks SET available_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2', [task.tenantId, task.taskId]);
  expect((await worker.runOne(task.tenantId, 'w2'))?.status).toBe('failed'); expect(saved).toHaveBeenCalledTimes(1);
  expect(await worker.runOne(task.tenantId, 'w3')).toBeNull();
});
it('bounds a forgotten await without starting the external effect or crashing the worker process', async () => {
  const task = makeTask({ workflow: 'crash' }); await store.enqueue(task);
  const floating = child(task.tenantId, 'external', 'floating');
  try {
    await floating.wait('done'); const [code] = await floating.exit;
    expect(code).toBe(0); expect(floating.messages.some(item => item.event === 'blocked')).toBe(false);
    expect((await store.get(task))?.status).toBe('reconciling');
  } finally { floating.process.kill(); }
});

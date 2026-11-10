import { Pool } from 'pg';
import { DurableWorker } from '../../src/runtime.js';
import { PostgresDurableStore } from '../../src/store.js';
const pool = new Pool({ connectionString: process.env['CAMERY_TEST_DATABASE_URL'], max: 2 });
const worker = new DurableWorker(new PostgresDurableStore(pool), { leaseMs: 30_000, runTimeoutMs: 60_000 });
process.send?.({ event: 'ready' });
worker.register({ name: 'crash', version: 1, async run(_input, ctx) {
  if (process.env['CAMERY_FAULT_PHASE'] === 'floating') {
    void ctx.step('floating', { kind: 'external', input: null }, async () => { process.send?.({ event: 'blocked' }); return new Promise(() => {}); });
    return null;
  }
  const paid = await ctx.step('paid', { kind: 'external', input: { request: 'same' } }, async () => { process.send?.({ event: 'paid' }); return { providerId: 'paid-once' }; });
  await ctx.step('interrupted', { kind: process.env['CAMERY_FAULT_KIND'] === 'external' ? 'external' : 'replayable', input: null }, async () => {
    process.send?.({ event: 'blocked' });
    if (process.env['CAMERY_FAULT_PHASE'] === 'resume') return 'resumed';
    return new Promise(() => {});
  });
  return paid;
} });
try {
  const result = await worker.runOne(process.env['CAMERY_FAULT_TENANT']!, `child-${process.pid}`);
  process.send?.({ event: 'done', status: result?.status ?? 'idle' });
} catch {
  process.send?.({ event: 'error' }); process.exitCode = 1;
} finally { await pool.end(); process.disconnect?.(); }

import { Pool } from 'pg';
import { DurableWorker, PostgresDurableStore } from '@camery/durable';
import { inboxSetup } from './inbox-support.js';
const tenantId = process.env['CAMERY_INBOX_TENANT']; const phase = process.env['CAMERY_INBOX_PHASE'];
if (!tenantId || !['crash', 'resume'].includes(phase ?? '') || !process.env['CAMERY_TEST_DATABASE_URL']) throw new Error('Missing local inbox fault-test identity');
const pool = new Pool({ connectionString: process.env['CAMERY_TEST_DATABASE_URL'], max: 3 });
try {
  const setup = inboxSetup(pool, { decision: () => { process.send?.({ event: 'decision' }); }, ...(phase === 'crash' ? { opened: async () => { process.send?.({ event: 'opened' }); await new Promise<void>(() => {}); } } : {}) });
  const worker = new DurableWorker(new PostgresDurableStore(pool), { leaseMs: 1000, runTimeoutMs: 30000 }); worker.register(setup.workflow);
  const result = await worker.runOne(tenantId, `inbox-${phase}`); process.send?.({ event: 'done', status: result?.status });
} finally { await pool.end(); process.disconnect?.(); }

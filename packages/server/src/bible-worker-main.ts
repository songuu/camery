import { Pool } from 'pg';
import { DurableWorker, PostgresDurableStore } from '@camery/durable';
import { createBibleChunkWorkflow, PostgresBibleCatalog, PostgresBibleStore, verifyBibleRuntimeRole } from '@camery/bible/node';
import { PostgresBudgetLedger } from '@camery/agents/node';
import { readBibleConfig } from './bible-config.js';
import { createBibleModelRuntime } from './bible-runtime.js';
import { createBibleHost } from './bible-host.js';
import { verifyBibleTaskRuntimeRole } from './bible-task-role.js';
import { releaseResources } from './shutdown.js';

const stop = new AbortController(); const requestStop = () => stop.abort();
process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop);
let biblePool: Pool | undefined; let taskPool: Pool | undefined;
try {
  const config = await readBibleConfig(process.env);
  if (!config?.text) throw new Error('Bible text model not configured');
  const model = createBibleModelRuntime(config);
  biblePool = new Pool({ connectionString: config.bibleDatabaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  taskPool = new Pool({ connectionString: config.taskDatabaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  biblePool.on('error', () => { console.error('Bible source connection unavailable'); });
  taskPool.on('error', () => { console.error('Bible task connection unavailable'); });
  await verifyBibleRuntimeRole(biblePool); await verifyBibleTaskRuntimeRole(taskPool);
  const store = new PostgresBibleStore(biblePool); const catalog = new PostgresBibleCatalog(biblePool);
  const durable = new PostgresDurableStore(taskPool);
  const worker = new DurableWorker(durable, { leaseMs: 15000, runTimeoutMs: config.text.timeoutMs + 20000, maxSteps: 16 });
  worker.register(createBibleChunkWorkflow({ store, ledger: new PostgresBudgetLedger(taskPool), sessionFor: model.sessionFor }));
  const result = await createBibleHost({ scope: { tenantId: config.tenantId, projectId: config.projectId }, workerId: config.workerId,
    store, catalog, durable, worker, pollMs: config.pollMs, runsPerRound: config.runsPerRound }).run(stop.signal);
  console.log(`Bible worker stopped; failed run rounds: ${result.errors}`);
} catch {
  console.error('Bible worker unavailable; check scoped text configuration and restricted runtime roles'); process.exitCode = 1;
} finally {
  // The active run is bounded and awaited by host.run, before any database pool is closed.
  if (!await releaseResources([() => biblePool?.end(), () => taskPool?.end()])) { console.error('Bible worker shutdown failed'); process.exitCode = 1; }
  process.removeListener('SIGINT', requestStop); process.removeListener('SIGTERM', requestStop);
}

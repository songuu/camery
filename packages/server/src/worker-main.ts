import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { DurableWorker, PostgresDurableStore } from '@camery/durable';
import { instrumentAgentWorkflow } from '@camery/agents';
import { PostgresBudgetLedger, PostgresCollaborationStore, createLocalWorkflowTracing } from '@camery/agents/node';
import type { LocalWorkflowTracing } from '@camery/agents/node';
import { readWorkerConfig } from './worker-config.js';
import { verifyWorkerRuntimeRole } from './worker-role.js';
import { loadChapterWorkerContent } from './worker-content.js';
import { createChapterWorkerWorkflow } from './chapter-worker.js';
import { createChapterWorkerHost } from './worker-host.js';
import { releaseResources } from './shutdown.js';

const stop = new AbortController();
const requestStop = () => stop.abort();
process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop);
let pool: Pool | undefined; let tracing: LocalWorkflowTracing | undefined;
try {
  const config = await readWorkerConfig(process.env);
  pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  pool.on('error', () => { console.error('Worker database connection unavailable'); });
  await verifyWorkerRuntimeRole(pool);
  const content = await loadChapterWorkerContent(config.contentDirectory ?? fileURLToPath(new URL('./content/', import.meta.url)));
  const scope = { tenantId: config.tenantId, projectId: config.projectId, treeId: config.treeId };
  const collaboration = new PostgresCollaborationStore(pool, content.agents); const durable = new PostgresDurableStore(pool);
  const workflow = createChapterWorkerWorkflow({ scope, ...content, collaboration, ledger: new PostgresBudgetLedger(pool) });
  const traceScope = { tenantId: config.tenantId, projectId: config.projectId };
  tracing = createLocalWorkflowTracing(traceScope);
  const worker = new DurableWorker(durable, { leaseMs: 5000, runTimeoutMs: 20000 });
  worker.register(instrumentAgentWorkflow(workflow, { ...traceScope, tracer: tracing.tracer }));
  const result = await createChapterWorkerHost({ scope, workerId: config.workerId, producer: content.producer, collaboration, durable, worker }).run(stop.signal);
  console.log(`Worker stopped: ${result.reason}`);
  // A terminal blocked tree is a persisted business outcome, not a crashed process to restart.
} catch {
  console.error('Worker startup failed or execution stopped; check scope, runtime role and pinned content');
  process.exitCode = 1;
} finally {
  const released = await releaseResources([() => tracing?.forceFlush(), () => tracing?.shutdown(), () => pool?.end()]);
  if (!released) { console.error('Worker resource shutdown failed'); process.exitCode = 1; }
  process.removeListener('SIGINT', requestStop); process.removeListener('SIGTERM', requestStop);
}

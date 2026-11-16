import { Pool } from 'pg';
import { PostgresSessionStore, verifyRuntimeRole } from '@camery/access/node';
import { createApplication } from './app.js';
import { readRuntimeConfig } from './secret-config.js';
import { closeServer } from './shutdown.js';
import { loadApplicationFeatures } from './features.js';
import { PostgresDocumentStore, PostgresScriptStore, verifyIngestRuntimeRole } from '@camery/ingest/node';

// Migration and token issuance require a separate trusted installation identity.
let pool: Pool | undefined;
let app: Awaited<ReturnType<typeof createApplication>> | undefined;
try {
  const features = loadApplicationFeatures(process.env);
  const config = await readRuntimeConfig(process.env);
  pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  pool.on('error', () => { console.error('API database connection unavailable'); });
  await verifyRuntimeRole(pool);
  if (features.sourceImports) await verifyIngestRuntimeRole(pool);
  app = await createApplication({ tenantId: config.tenantId, store: new PostgresSessionStore(pool),
    ...(features.sourceImports ? { sources: { novels: new PostgresDocumentStore(pool), scripts: new PostgresScriptStore(pool) } } : {}),
    ...(features.frontendDirectory === undefined ? {} : { frontendDirectory: features.frontendDirectory }) });
  await app.listen(config.port, config.host);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (!await closeServer(app, pool)) { console.error('API shutdown failed'); process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  console.log(`Camery API listening on ${config.host}:${config.port}`);
} catch {
  console.error('API startup failed; check tenant, database and restricted runtime role');
  await closeServer(app, pool);
  process.exitCode = 1;
}

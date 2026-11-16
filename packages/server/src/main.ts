import { Pool } from 'pg';
import { PostgresSessionStore, verifyRuntimeRole } from '@camery/access/node';
import { createApplication } from './app.js';
import { readRuntimeConfig } from './secret-config.js';
import { releaseResources } from './shutdown.js';
import { PostgresBibleStore,PostgresBibleCatalog,verifyBibleRuntimeRole } from '@camery/bible/node';
import { PostgresDurableStore } from '@camery/durable';
import { readBibleConfig } from './bible-config.js';
import { createBibleModelRuntime } from './bible-runtime.js';
import { verifyBibleTaskRuntimeRole } from './bible-task-role.js';
import type { BibleApiOptions } from './bible-options.js';
import { loadApplicationFeatures } from './features.js';
import { PostgresDocumentStore, PostgresScriptStore, verifyIngestRuntimeRole } from '@camery/ingest/node';

// Migration and token issuance require a separate trusted installation identity.
let pool: Pool | undefined;
let biblePool:Pool|undefined;let taskPool:Pool|undefined;
let app: Awaited<ReturnType<typeof createApplication>> | undefined;
const close=()=>releaseResources([()=>app?.close(),()=>pool?.end(),()=>biblePool?.end(),()=>taskPool?.end()]);
try {
  const features = loadApplicationFeatures(process.env);
  const [config,bibleConfig] = await Promise.all([readRuntimeConfig(process.env),readBibleConfig(process.env)]);
  pool = new Pool({ connectionString: config.databaseUrl, max: 4, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  pool.on('error', () => { console.error('API database connection unavailable'); });
  await verifyRuntimeRole(pool);
  if (features.sourceImports) await verifyIngestRuntimeRole(pool);
  let bibles:BibleApiOptions|undefined;
  if(bibleConfig){
    if(bibleConfig.tenantId!==config.tenantId)throw new Error('Bible tenant mismatch');
    biblePool=new Pool({connectionString:bibleConfig.bibleDatabaseUrl,max:4,connectionTimeoutMillis:5000,query_timeout:5000});
    taskPool=new Pool({connectionString:bibleConfig.taskDatabaseUrl,max:4,connectionTimeoutMillis:5000,query_timeout:5000});
    biblePool.on('error',()=>console.error('Bible source connection unavailable'));
    taskPool.on('error',()=>console.error('Bible task connection unavailable'));
    await verifyBibleRuntimeRole(biblePool);await verifyBibleTaskRuntimeRole(taskPool);
    bibles={store:new PostgresBibleStore(biblePool),catalog:new PostgresBibleCatalog(biblePool),tasks:new PostgresDurableStore(taskPool),presetFor:createBibleModelRuntime(bibleConfig).presetFor};
  }
  app = await createApplication({ tenantId: config.tenantId, store: new PostgresSessionStore(pool),
    ...(features.sourceImports ? { sources: { novels: new PostgresDocumentStore(pool), scripts: new PostgresScriptStore(pool) } } : {}),
    ...(bibles?{bibles}:{}),
    ...(features.frontendDirectory === undefined ? {} : { frontendDirectory: features.frontendDirectory }) });
  await app.listen(config.port, config.host);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (!await close()) { console.error('API shutdown failed'); process.exitCode = 1; }
  };
  process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
  console.log(`Camery API listening on ${config.host}:${config.port}`);
} catch {
  console.error('API startup failed; check tenant, database and restricted runtime role');
  await close();
  process.exitCode = 1;
}

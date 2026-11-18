import { Pool } from 'pg';
import { DurableWorker,PostgresDurableStore } from '@camery/durable';
import { PostgresBudgetLedger } from '@camery/agents/node';
import { createOutlineWorkflow,PostgresOutlineCatalog,PostgresOutlineStore,verifyOutlineRuntimeRole } from '@camery/script/outline/node';
import { readOutlineConfig } from './outline-config.js';
import { createOutlineModelRuntime } from './outline-runtime.js';
import { createOutlineHost } from './outline-host.js';
import { verifyOutlineTaskRuntimeRole } from './outline-task-role.js';
import { releaseResources } from './shutdown.js';

const stop=new AbortController(),requestStop=()=>stop.abort();process.once('SIGINT',requestStop);process.once('SIGTERM',requestStop);
let outlinePool:Pool|undefined,taskPool:Pool|undefined;
try{
  const config=await readOutlineConfig(process.env);if(!config)throw new Error('Outline worker not configured');
  const model=createOutlineModelRuntime(config);
  outlinePool=new Pool({connectionString:config.outlineDatabaseUrl,max:4,connectionTimeoutMillis:5000,query_timeout:5000});
  taskPool=new Pool({connectionString:config.taskDatabaseUrl,max:4,connectionTimeoutMillis:5000,query_timeout:5000});
  outlinePool.on('error',()=>console.error('Outline storage connection unavailable'));taskPool.on('error',()=>console.error('Outline task connection unavailable'));
  await verifyOutlineRuntimeRole(outlinePool);await verifyOutlineTaskRuntimeRole(taskPool);
  const store=new PostgresOutlineStore(outlinePool),catalog=new PostgresOutlineCatalog(outlinePool),durable=new PostgresDurableStore(taskPool);
  // Cached decisions need no provider configuration. A new uncached decision still fails closed in sessionFor.
  const worker=new DurableWorker(durable,{leaseMs:15000,runTimeoutMs:(config.text?.timeoutMs??40000)+20000,maxSteps:16});
  worker.register(createOutlineWorkflow({store,ledger:new PostgresBudgetLedger(taskPool),sessionFor:model.sessionFor}));
  const result=await createOutlineHost({scope:{tenantId:config.tenantId,projectId:config.projectId},workerId:config.workerId,store,catalog,durable,worker,pollMs:config.pollMs,runsPerRound:config.runsPerRound}).run(stop.signal);
  console.log(`Outline worker stopped; failed run rounds: ${result.errors}`);
}catch{console.error('Outline worker unavailable; check scoped configuration and restricted runtime roles');process.exitCode=1;}
finally{
  if(!await releaseResources([()=>outlinePool?.end(),()=>taskPool?.end()])){console.error('Outline worker shutdown failed');process.exitCode=1;}
  process.removeListener('SIGINT',requestStop);process.removeListener('SIGTERM',requestStop);
}

import { Pool } from 'pg';
import { DurableWorker,PostgresDurableStore } from '@camery/durable';
import { createDevelopmentStageWorkflow,PostgresDevelopmentCatalog,PostgresDevelopmentStore,verifyDevelopmentRuntimeRole } from '@camery/script/node';
import { PostgresBudgetLedger } from '@camery/agents/node';
import { readDevelopmentConfig } from './development-config.js';
import { createDevelopmentModelRuntime } from './development-runtime.js';
import { createDevelopmentHost } from './development-host.js';
import { verifyDevelopmentTaskRuntimeRole } from './development-task-role.js';
import { releaseResources } from './shutdown.js';

const stop=new AbortController();const requestStop=()=>stop.abort();process.once('SIGINT',requestStop);process.once('SIGTERM',requestStop);
let developmentPool:Pool|undefined;let taskPool:Pool|undefined;
try{
  const config=await readDevelopmentConfig(process.env);if(!config?.text)throw new Error('Development text model not configured');
  const model=createDevelopmentModelRuntime(config);
  developmentPool=new Pool({connectionString:config.developmentDatabaseUrl,max:4,connectionTimeoutMillis:5000,query_timeout:5000});
  taskPool=new Pool({connectionString:config.taskDatabaseUrl,max:4,connectionTimeoutMillis:5000,query_timeout:5000});
  developmentPool.on('error',()=>console.error('Development source connection unavailable'));taskPool.on('error',()=>console.error('Development task connection unavailable'));
  await verifyDevelopmentRuntimeRole(developmentPool);await verifyDevelopmentTaskRuntimeRole(taskPool);
  const store=new PostgresDevelopmentStore(developmentPool);const catalog=new PostgresDevelopmentCatalog(developmentPool);const durable=new PostgresDurableStore(taskPool);
  const worker=new DurableWorker(durable,{leaseMs:15000,runTimeoutMs:config.text.timeoutMs+20000,maxSteps:16});
  worker.register(createDevelopmentStageWorkflow({store,ledger:new PostgresBudgetLedger(taskPool),sessionFor:model.sessionFor}));
  const result=await createDevelopmentHost({scope:{tenantId:config.tenantId,projectId:config.projectId},workerId:config.workerId,store,catalog,durable,worker,pollMs:config.pollMs,runsPerRound:config.runsPerRound}).run(stop.signal);
  console.log(`Development worker stopped; failed run rounds: ${result.errors}`);
}catch{console.error('Development worker unavailable; check scoped text configuration and restricted runtime roles');process.exitCode=1;}
finally{
  if(!await releaseResources([()=>developmentPool?.end(),()=>taskPool?.end()])){console.error('Development worker shutdown failed');process.exitCode=1;}
  process.removeListener('SIGINT',requestStop);process.removeListener('SIGTERM',requestStop);
}

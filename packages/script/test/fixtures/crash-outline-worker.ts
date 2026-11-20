import { Pool } from 'pg';
import { DurableWorker,PostgresDurableStore } from '@camery/durable';
import type { Json,Lease } from '@camery/durable';
import { PostgresBudgetLedger } from '@camery/agents/node';
// Load only the worker's runtime modules so cold installer/barrel discovery cannot consume the crash checkpoint window.
import { PostgresOutlineStore } from '../../src/outline/node/store.js';
import { createOutlineWorkflow } from '../../src/outline/node/workflow.js';
import { outlineProtocolTransport,outlineSessionFactory } from '../outline-workflow-pg-support.js';

const pool=new Pool({connectionString:process.env['CAMERY_TEST_DATABASE_URL']});let calls=0;process.send?.({event:'fixture-loaded'});
class CrashAfterOutlineDecision extends PostgresDurableStore{
  override async completeStep(lease:Lease,key:string,output:Json):Promise<void>{
    await super.completeStep(lease,key,output);
    if(key==='agent.0.decision'){
      process.send?.({event:'decision-saved',calls});
      // Parent kills only this owned child, after the actual model journal commit and before candidate persistence.
      await new Promise<void>(()=>{});
    }
  }
}
const tenantId=process.env['CAMERY_OUTLINE_CRASH_TENANT'],taskId=process.env['CAMERY_OUTLINE_CRASH_TASK'];
if(!tenantId||!taskId)throw new Error('Missing owned outline crash identity');
// Use the normal 30s lease: the parent forces expiry after the committed-decision SIGKILL.
try{
  const worker=new DurableWorker(new CrashAfterOutlineDecision(pool),{runTimeoutMs:180000});
  worker.register(createOutlineWorkflow({store:new PostgresOutlineStore(pool),ledger:new PostgresBudgetLedger(pool),sessionFor:outlineSessionFactory(outlineProtocolTransport(()=>{calls++;process.send?.({event:'provider-called'});}))}));
  process.send?.({event:'dispatching'});const result=await worker.runTask({tenantId,taskId},'owned-outline-crash');process.send?.({event:'task-finished',status:result?.status??'not-claimed'});
}finally{await pool.end();}

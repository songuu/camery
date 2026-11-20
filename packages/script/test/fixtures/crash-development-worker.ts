import { Pool } from 'pg';
import { DurableWorker,PostgresDurableStore } from '@camery/durable';
import type { Json,Lease,StepSpec } from '@camery/durable';
import { PostgresBudgetLedger } from '@camery/agents/node';
import { PostgresDevelopmentStore } from '../../src/node/store.js';
import { createDevelopmentStageWorkflow,createDevelopmentRedoWorkflow } from '../../src/node/workflow.js';
import { protocolTransport,sessionFactory } from '../workflow-pg-support.js';

// Use the normal lease; the parent explicitly expires it after the committed-decision SIGKILL.
const pool=new Pool({connectionString:process.env['CAMERY_TEST_DATABASE_URL']});let calls=0;
process.send?.({event:'fixture-loaded'});
class CrashAfterCommittedDecision extends PostgresDurableStore{
  override async openStep(lease:Lease,spec:StepSpec,at?:Date){process.send?.({event:'step-open',key:spec.key});return super.openStep(lease,spec,at);}
  override async completeStep(lease:Lease,key:string,output:Json):Promise<void>{
    await super.completeStep(lease,key,output);
    if(key==='agent.0.decision'){
      process.send?.({event:'decision-saved',calls});
      // The parent kills only this owned child, after the real SQL commit and before candidate persistence.
      await new Promise<void>(()=>{});
    }
  }
}
const tenantId=process.env['CAMERY_DEVELOPMENT_CRASH_TENANT'];const taskId=process.env['CAMERY_DEVELOPMENT_CRASH_TASK'];
if(!tenantId||!taskId)throw new Error('Missing owned development crash fixture identity');
try{
  const worker=new DurableWorker(new CrashAfterCommittedDecision(pool),{runTimeoutMs:180000});
  const options={store:new PostgresDevelopmentStore(pool),ledger:new PostgresBudgetLedger(pool),sessionFor:sessionFactory(protocolTransport(()=>{calls++;process.send?.({event:'provider-called'});}))};
  worker.register(createDevelopmentStageWorkflow(options));worker.register(createDevelopmentRedoWorkflow(options));
  process.send?.({event:'dispatching'});const result=await worker.runTask({tenantId,taskId},'owned-development-crash-worker');process.send?.({event:'task-finished',status:result?.status??'not-claimed'});
}finally{await pool.end();}

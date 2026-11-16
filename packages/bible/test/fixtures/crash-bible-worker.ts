import { Pool } from 'pg';
import { DurableWorker, PostgresDurableStore } from '@camery/durable';
import type { Json, Lease } from '@camery/durable';
import { PostgresBudgetLedger } from '@camery/agents/node';
import { PostgresBibleStore } from '../../src/node/store.js';
import { createBibleChunkWorkflow } from '../../src/node/workflow.js';
import { protocolTransport, sessionFactory } from '../workflow-pg-support.js';
const pool=new Pool({connectionString:process.env['CAMERY_TEST_DATABASE_URL']});let calls=0;
class CrashAfterCommittedDecision extends PostgresDurableStore {
  override async completeStep(lease:Lease,key:string,output:Json):Promise<void>{
    await super.completeStep(lease,key,output);
    if(key==='agent.0.decision'){
      process.send?.({event:'decision-saved',calls});
      // The parent kills only this child after the actual PostgreSQL journal commit and before record persistence.
      await new Promise<void>(()=>{});
    }
  }
}
const tenantId=process.env['CAMERY_BIBLE_CRASH_TENANT'];const taskId=process.env['CAMERY_BIBLE_CRASH_TASK'];
if(!tenantId||!taskId)throw new Error('Missing owned Bible crash fixture identity');
try{
  const worker=new DurableWorker(new CrashAfterCommittedDecision(pool),{leaseMs:1000,runTimeoutMs:60000});
  worker.register(createBibleChunkWorkflow({store:new PostgresBibleStore(pool),ledger:new PostgresBudgetLedger(pool),sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
  await worker.runTask({tenantId,taskId},'owned-bible-crash-worker');
}finally{await pool.end();}

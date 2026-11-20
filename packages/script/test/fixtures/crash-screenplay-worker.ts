import {Pool} from 'pg';
import {DurableWorker,PostgresDurableStore} from '@camery/durable';
import type {Json,Lease} from '@camery/durable';
import {PostgresBudgetLedger} from '@camery/agents/node';
import {PostgresOutlineStore} from '../../src/outline/node/store.js';
import {PostgresScreenplayGenerationStore} from '../../src/screenplay/node/generation-store.js';
import {createScreenplayWorkflow} from '../../src/screenplay/node/workflow.js';
import {ScreenplayGenerationTaskReferenceSchema} from '../../src/screenplay/node/generation-contracts.js';
import {captureScreenplay} from '../../src/screenplay/boundary.js';
import {screenplayProtocolOutput,screenplayProtocolSession} from '../screenplay-workflow-pg-support.js';
const tenantId=process.env['CAMERY_SCREENPLAY_CRASH_TENANT'],taskId=process.env['CAMERY_SCREENPLAY_CRASH_TASK'];if(!tenantId||!taskId)throw new Error('Missing owned screenplay crash identity');
// Use the normal lease; the parent explicitly expires it after the committed-decision SIGKILL.
const pool=new Pool({connectionString:process.env['CAMERY_TEST_DATABASE_URL']});let calls=0;process.send?.({event:'fixture-loaded'});
class CrashAfterDecision extends PostgresDurableStore{override async completeStep(lease:Lease,key:string,output:Json){await super.completeStep(lease,key,output);if(key==='agent.0.decision'){process.send?.({event:'decision-saved',calls});await new Promise<void>(()=>{});}}}
try{
  const durable=new CrashAfterDecision(pool),task=await durable.get({tenantId,taskId});if(!task)throw new Error('Missing owned screenplay crash task');const ref=captureScreenplay(ScreenplayGenerationTaskReferenceSchema,task.input,'owned crash reference',8192),key={tenantId,projectId:ref.projectId,runId:ref.runId},host={scope:{tenantId,projectId:ref.projectId},actor:{kind:'human' as const,id:'editor'},at:'2026-11-19T05:00:00.000Z',authorize:()=>true},store=new PostgresScreenplayGenerationStore(pool,new PostgresOutlineStore(pool)),run=(await store.read(key,host)).run,worker=new DurableWorker(durable,{runTimeoutMs:180000});
  worker.register(createScreenplayWorkflow({store,ledger:new PostgresBudgetLedger(pool),hostFor:()=>host,sessionFor:screenplayProtocolSession(screenplayProtocolOutput(run.context),()=>{calls++;})}));process.send?.({event:'dispatching'});const result=await worker.runTask({tenantId,taskId},'owned-screenplay-crash');process.send?.({event:'task-finished',status:result?.status??'not-claimed'});
}finally{await pool.end();}

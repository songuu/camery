import {Pool} from 'pg';
import {DurableWorker,PostgresDurableStore} from '@camery/durable';
import type {Json,Lease} from '@camery/durable';
import {PostgresBudgetLedger} from '@camery/agents/node';
import {PostgresOutlineStore} from '../../src/outline/node/store.js';
import {PostgresScreenplayStore} from '../../src/screenplay/node/store.js';
import {PostgresPrecheckStore} from '../../../compliance/src/node/store.js';
import {createPrecheckWorkflow} from '../../../compliance/src/node/workflow.js';
import {BatchTaskReferenceSchema} from '../../../compliance/src/node/state.js';
import {precheckProtocolSession} from '../precheck-workflow-pg-support.js';
const tenantId=process.env['CAMERY_PRECHECK_CRASH_TENANT'],taskId=process.env['CAMERY_PRECHECK_CRASH_TASK'];if(!tenantId||!taskId)throw new Error('Missing owned precheck crash identity');
const pool=new Pool({connectionString:process.env['CAMERY_TEST_DATABASE_URL']});let calls=0;process.send?.({event:'fixture-loaded'});
class CrashAfterDecision extends PostgresDurableStore{override async completeStep(lease:Lease,key:string,output:Json){await super.completeStep(lease,key,output);if(key==='agent.0.decision'){process.send?.({event:'decision-saved',calls});await new Promise<void>(()=>{});}}}
try{const durable=new CrashAfterDecision(pool),task=await durable.get({tenantId,taskId});if(!task)throw new Error('Missing owned precheck task');const ref=BatchTaskReferenceSchema.parse(task.input),key={tenantId,projectId:ref.projectId,runId:ref.runId},host={scope:{tenantId,projectId:ref.projectId},actor:{kind:'human' as const,id:'editor'},at:'2026-11-19T05:00:00.000Z',authorize:()=>true},outline=new PostgresOutlineStore(pool),store=new PostgresPrecheckStore(pool,{scripts:new PostgresScreenplayStore(pool,outline),outline},()=>host),run=(await store.read(key,host)).run,worker=new DurableWorker(durable,{leaseMs:1000,runTimeoutMs:60000});worker.register(createPrecheckWorkflow({store,ledger:new PostgresBudgetLedger(pool),hostFor:()=>host,sessionFor:precheckProtocolSession(run,()=>{calls++;})}));process.send?.({event:'dispatching'});const result=await worker.runTask({tenantId,taskId},'owned-precheck-crash');process.send?.({event:'task-finished',status:result?.status??'not-claimed'});}finally{await pool.end();}

import {Pool} from 'pg';
import {DurableWorker,PostgresDurableStore} from '@camery/durable';
import type {Json,Lease} from '@camery/durable';
import {PostgresBudgetLedger} from '@camery/agents/node';
import {PostgresOutlineStore} from '../../src/outline/node/store.js';
import {PostgresScreenplayStore} from '../../src/screenplay/node/store.js';
import {PostgresScreenplayGenerationStore} from '../../src/screenplay/node/generation-store.js';
import {PostgresQualityStore} from '../../src/quality/node/store.js';
import {createQualityWorkflow} from '../../src/quality/node/workflow.js';
import {QualityBatchReferenceSchema} from '../../src/quality/node/state.js';
import {qualityProtocolSession} from '../quality-workflow-pg-support.js';
const tenantId=process.env['CAMERY_QUALITY_CRASH_TENANT'],taskId=process.env['CAMERY_QUALITY_CRASH_TASK'];if(!tenantId||!taskId)throw new Error('Missing owned quality crash identity');
// Use the normal 30s lease: the parent forces expiry after the committed-decision SIGKILL.
const pool=new Pool({connectionString:process.env['CAMERY_TEST_DATABASE_URL']});let calls=0;process.send?.({event:'fixture-loaded'});
class CrashAfterDecision extends PostgresDurableStore{override async completeStep(lease:Lease,key:string,output:Json){await super.completeStep(lease,key,output);if(key==='agent.0.decision'){process.send?.({event:'decision-saved',calls});await new Promise<void>(()=>{});}}}
try{const durable=new CrashAfterDecision(pool),task=await durable.get({tenantId,taskId});if(!task)throw new Error('Missing owned quality task');const ref=QualityBatchReferenceSchema.parse(task.input),key={tenantId,projectId:ref.projectId,runId:ref.runId},host={scope:{tenantId,projectId:ref.projectId},actor:{kind:'human' as const,id:'editor'},at:'2026-11-19T05:00:00.000Z',authorize:()=>true},outline=new PostgresOutlineStore(pool),quality=new PostgresQualityStore(pool,{outline,scripts:new PostgresScreenplayStore(pool,outline),generations:new PostgresScreenplayGenerationStore(pool,outline)}),progress=await quality.read(key,host),material=progress.cycles.find(cycle=>cycle.record.number===ref.cycle);if(!material?.plan)throw new Error('Missing owned quality plan');const worker=new DurableWorker(durable,{runTimeoutMs:180000});worker.register(createQualityWorkflow({store:quality,ledger:new PostgresBudgetLedger(pool),hostFor:()=>host,sessionFor:qualityProtocolSession(progress.run,material.plan,ref.cycle,()=>{calls++;})}));process.send?.({event:'dispatching'});const result=await worker.runTask({tenantId,taskId},'owned-quality-crash');process.send?.({event:'task-finished',status:result?.status??'not-claimed'});}finally{await pool.end();}

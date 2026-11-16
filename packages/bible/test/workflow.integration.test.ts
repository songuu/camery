import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore, stepIdempotencyKey } from '@camery/durable';
import type { Json, Task } from '@camery/durable';
import { migrateAgentBudgets, PostgresBudgetLedger } from '@camery/agents/node';
import { migrateIngest, PostgresDocumentStore } from '@camery/ingest/node';
import { MethodRegistry, prepareStructuredGenerationRequest } from '@camery/methods';
import { ModelError } from '@camery/model-modes';
import { PostgresBibleStore } from '../src/node/store.js';
import { migrateBible } from '../src/node/migrate.js';
import { createBibleChunkWorkflow, enqueueNextBibleTask } from '../src/node/workflow.js';
import { createStoryBibleMethodPack } from '../src/extraction.js';
import { canonical, hash } from '../src/data.js';
import { readChunk } from '../src/chunks.js';
import { fixtureOutput } from './extraction-support.js';
import { protocolTransport, sessionFactory } from './workflow-pg-support.js';
const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL is required for Bible task recovery');
const pool=new Pool({connectionString:url});const tenants:string[]=[];
beforeAll(async()=>{await migrateDurable(pool);await migrateAgentBudgets(pool);await migrateIngest(pool);await migrateBible(pool);});
afterAll(async()=>{
  for(const tenant of tenants){
    for(const table of ['reviews','candidates','chunks','runs'])await pool.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`,[tenant]);
    for(const table of ['budget_events','budget_allocations','budget_projects'])await pool.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`,[tenant]);
    for(const table of ['events','steps','tasks'])await pool.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`,[tenant]);
    await pool.query('DELETE FROM camery_ingest.documents WHERE tenant_id=$1',[tenant]);
  }await pool.end();
});
async function fixture(live=false){
  const tenantId='bible-task-'+randomUUID();tenants.push(tenantId);const key={tenantId,projectId:'project',runId:'research'};
  const documents=new PostgresDocumentStore(pool);const imported=await documents.append({tenantId,projectId:key.projectId,documentId:'book',batchId:'first',expectedRevision:0,text:'第一章 车站\n小林来到车站。\n第二章 来信\n小林收到来信。\n'});
  const registry=new MethodRegistry();const method=registry.register(createStoryBibleMethodPack());const store=new PostgresBibleStore(pool);const durable=new PostgresDurableStore(pool);const ledger=new PostgresBudgetLedger(pool);
  const run=await store.start({...key,documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:imported.document.sourceDigest,method,chunkLimits:{maxCharacters:22,maxBytes:88},
    execution:{connectionId:'fixture',modeDigest:hash('fixture-mode'),modelIdentity:'fixture/story-model',evidence:live?'live_model':'synthetic_replay',modelTier:'economy',currency:'CNY',reservation:{tokens:100,costMicros:live?10:0},limits:{steps:10,tokens:1000,costMicros:live?100:0}}});
  await ledger.createProject({tenantId,projectId:key.projectId,currency:'CNY',limits:run.execution.limits},'fixture-budget-owner');
  const ready=await enqueueNextBibleTask(store,durable,key);if(ready.state!=='task')throw new Error('Expected first Bible task');
  return {key,run,store,durable,ledger,task:ready.task};
}
async function available(task:Task){await pool.query('UPDATE camery_durable.tasks SET available_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2',[task.tenantId,task.taskId]);}
it('recovers a committed chunk whose save acknowledgement was lost without another model request or budget allocation',async()=>{
  const x=await fixture();let calls=0;const firstStore=new PostgresBibleStore(pool);const original=firstStore.saveChunk.bind(firstStore);let interrupted=false;
  vi.spyOn(firstStore,'saveChunk').mockImplementation(async(...args)=>{const record=await original(...args);if(!interrupted){interrupted=true;throw new Error('synthetic loss after record commit');}return record;});
  const first=new DurableWorker(x.durable,{retryDelayMs:1});first.register(createBibleChunkWorkflow({store:firstStore,ledger:x.ledger,sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
  expect((await first.runTask(x.task,'interrupted'))?.status).toBe('queued');expect(calls).toBe(1);expect((await x.store.read(x.key)).records).toHaveLength(1);
  const replacementPool=new Pool({connectionString:url});try{
    let replacementCalls=0;const next=new DurableWorker(new PostgresDurableStore(replacementPool));next.register(createBibleChunkWorkflow({store:new PostgresBibleStore(replacementPool),ledger:new PostgresBudgetLedger(replacementPool),sessionFor:sessionFactory(protocolTransport(()=>{replacementCalls++;}))}));
    await available(x.task);expect((await next.runTask(x.task,'replacement'))?.output).toMatchObject({state:'candidate',charged:{tokens:23,costMicros:0}});expect(replacementCalls).toBe(0);
  }finally{await replacementPool.end();}
  expect((await x.ledger.project({tenantId:x.key.tenantId,projectId:x.key.projectId})).used.tokens).toBe('100');
  const allocations=await pool.query('SELECT count(*)::int n FROM camery_agents.budget_allocations WHERE tenant_id=$1',[x.key.tenantId]);expect(allocations.rows[0].n).toBe(1);
  // The next block is enqueued only after the prior immutable record exists.
  const nextTask=await enqueueNextBibleTask(x.store,x.durable,x.key);expect(nextTask.state).toBe('task');if(nextTask.state!=='task')throw new Error('Expected second task');expect(nextTask.task.taskId).not.toBe(x.task.taskId);
  const nextWorker=new DurableWorker(x.durable);nextWorker.register(createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
  expect((await nextWorker.runTask(nextTask.task,'next-chunk'))?.status).toBe('succeeded');expect(calls).toBe(2);
  expect((await enqueueNextBibleTask(x.store,x.durable,x.key)).state).toBe('ready');expect((await x.store.read(x.key)).candidate?.records).toHaveLength(2);
});
it('holds unknown external work for explicit reconciliation and resumes the exact receipt without repeating it',async()=>{
  const x=await fixture(true);let calls=0;const worker=new DurableWorker(x.durable);
  worker.register(createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:sessionFactory({exchange:async()=>{calls++;throw new ModelError('NETWORK_FAILED','synthetic unknown','unknown');}})}));
  expect((await worker.runTask(x.task,'unknown'))?.status).toBe('reconciling');expect(calls).toBe(1);expect((await x.store.read(x.key)).records).toEqual([]);
  const replacement=new DurableWorker(x.durable);let replacementCalls=0;replacement.register(createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:sessionFactory(protocolTransport(()=>{replacementCalls++;}))}));
  expect(await replacement.runTask(x.task,'must-not-resend')).toBeNull();expect(replacementCalls).toBe(0);
  const {chunk,text}=readChunk(x.run.source,x.run.plan,x.run.plan.chunks[0]!.id);const output=fixtureOutput(text);
  const request=prepareStructuredGenerationRequest(createStoryBibleMethodPack(),{source:x.run.source.source,planDigest:x.run.plan.digest,chunk,text});
  const modelCall={tenantId:x.key.tenantId,connectionId:x.run.execution.connectionId,modeDigest:x.run.execution.modeDigest,modelIdentity:x.run.execution.modelIdentity,evidence:'live_model',callId:stepIdempotencyKey(x.task,'agent.0.decision'),
    providerRequestId:'synthetic-operator-verified',inputDigest:hash({messages:request.messages,outputSchema:request.outputSchema}),outputDigest:hash(output),usage:{inputTokens:15,outputTokens:8}};
  const recovered={kind:'result',output:{kind:'finish',output},usage:{tokens:23,costMicros:null},outcome:'completed',modelCall};
  await new PostgresDocumentStore(pool).append({tenantId:x.key.tenantId,projectId:x.key.projectId,documentId:'book',batchId:'later',expectedRevision:1,text:'第三章 新内容\n原文已经追加。\n'});
  // This is a trusted synthetic operator record, not a remote signature or a production reconciliation API.
  await x.durable.reconcile({...x.task,stepKey:'agent.0.decision',actorId:'fixture-operator',resolution:{kind:'completed',output:JSON.parse(canonical(recovered)) as Json}});
  expect((await replacement.runTask(x.task,'reconciled'))?.output).toMatchObject({state:'candidate',usageUnknown:true,charged:{costMicros:10}});expect(replacementCalls).toBe(0);
  expect((await x.store.read(x.key)).records[0]?.model.providerRequestId).toBe('synthetic-operator-verified');
  expect((await enqueueNextBibleTask(x.store,x.durable,x.key)).state).toBe('stale');
});
it('survives actual SIGKILL after the model decision journal commit and resumes through new pools without provider replay',async()=>{
  const x=await fixture();const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),fileURLToPath(new URL('./fixtures/crash-bible-worker.ts',import.meta.url))],
    {cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,CAMERY_BIBLE_CRASH_TENANT:x.key.tenantId,CAMERY_BIBLE_CRASH_TASK:x.task.taskId},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const exited=once(child,'exit');let resolve:((value:number)=>void)|undefined;const ready=new Promise<number>(done=>{resolve=done;});
  child.on('message',message=>{if(message&&typeof message==='object'&&'event' in message&&message.event==='decision-saved'&&'calls' in message)resolve?.(message.calls as number);});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    expect(await Promise.race([ready,exited.then(()=>{throw new Error('Owned crash worker exited before model journal commit');}),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('Owned crash worker did not reach journal checkpoint')),20000);})])).toBe(1);
    child.kill('SIGKILL');const exit=await exited;expect(exit[1]==='SIGKILL'||exit[0]!==0).toBe(true);
    const steps=await x.durable.steps(x.task);expect(steps.find(step=>step.key==='agent.0.decision')?.status).toBe('completed');expect((await x.store.read(x.key)).records).toEqual([]);
    await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2",[x.task.tenantId,x.task.taskId]);
    const replacementPool=new Pool({connectionString:url});try{
      let calls=0;const durable=new PostgresDurableStore(replacementPool);const replacement=new DurableWorker(durable);replacement.register(createBibleChunkWorkflow({store:new PostgresBibleStore(replacementPool),ledger:new PostgresBudgetLedger(replacementPool),sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
      expect((await replacement.runTask(x.task,'after-sigkill'))?.status).toBe('succeeded');expect(calls).toBe(0);expect((await x.store.read(x.key)).records).toHaveLength(1);
    }finally{await replacementPool.end();}
  }finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
});

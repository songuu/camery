import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { beforeAll,afterAll,expect,it,vi } from 'vitest';
import { DurableWorker,PostgresDurableStore,migrateDurable } from '@camery/durable';
import type { Json,Lease,Task } from '@camery/durable';
import { PostgresBudgetLedger,migrateAgentBudgets } from '@camery/agents/node';
import { migrateIngest } from '../../ingest/src/node/index.js';
import { migrateBible } from '@camery/bible/node';
import { migrateDevelopment } from '../src/node/index.js';
import { PostgresOutlineStore,createOutlineWorkflow,enqueueOutlineTask,migrateOutline,prepareOutline,captureOutlineProgress } from '../src/outline/node/index.js';
import { createDevelopmentSourceFixture,createBibleSourceFixture } from './outline-source-pg-support.js';
import { outlineProtocolTransport,outlineSessionFactory } from './outline-workflow-pg-support.js';
import { largeBibleFixture,progressBibleFixture } from './outline-capacity-support.js';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL is required for outline workflow recovery');
const pool=new Pool({connectionString:url,max:6,connectionTimeoutMillis:5000});const tenants:string[]=[];
beforeAll(async()=>{await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateDurable(pool);await migrateAgentBudgets(pool);});
afterAll(async()=>{
  let failed=false;
  try{for(const tenant of tenants)for(const [schema,tables] of [['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']],['camery_agents',['budget_events','budget_allocations','budget_projects']],['camery_durable',['events','signals','steps','tasks']]] as const)
    for(const table of tables)try{await pool.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
  }finally{await pool.end();}if(failed)throw new Error('Outline workflow fixture cleanup failed');
});
async function fixture(options:{live?:boolean;large?:boolean;aggregate?:boolean;tokens?:number}={}){
  const target={tenantId:'outline-workflow-'+randomUUID(),projectId:'project'};tenants.push(target.tenantId);const key={...target,runId:'outline'};
  const source=options.large||options.aggregate?await createBibleSourceFixture(pool,target,options.aggregate?progressBibleFixture(8):largeBibleFixture()):await createDevelopmentSourceFixture(pool,target);
  const store=new PostgresOutlineStore(pool),durable=new PostgresDurableStore(pool),ledger=new PostgresBudgetLedger(pool);
  const put={...target,briefId:'adaptation',expectedRevision:0,actorId:'fixture-editor',notes:'保留已审阅港城故事的冲突。',episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']};
  const brief=(await store.putBrief(put)).brief;
  const execution={connectionId:'outline-workflow-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline',evidence:options.live?'live_model':'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros:options.live?10:0},limits:{steps:1,tokens:300,costMicros:options.live?10:0},...(options.live?{pricing:{inputMicrosPerMillionTokens:10000,outputMicrosPerMillionTokens:10000}}:{})};
  const run=await store.start({...key,briefId:brief.briefId,expectedRevision:1,expectedBriefDigest:brief.digest,source:source.descriptor,execution});
  await ledger.createProject({...target,currency:'CNY',limits:{steps:1,tokens:options.tokens??300,costMicros:options.live?10:0}},'fixture-budget-owner');
  const dispatched=await enqueueOutlineTask(store,durable,key);if(dispatched.state!=='task')throw new Error('Expected outline task');
  const host={...target,actor:{kind:'human' as const,id:'fixture-editor'},at:'2026-11-17T12:30:00.000Z',authorize:()=>true};
  return {target,key,source,store,durable,ledger,put,run,task:dispatched.task,host};
}
async function available(task:Task){await pool.query('UPDATE camery_durable.tasks SET available_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2',[task.tenantId,task.taskId]);}
function decision(candidate:NonNullable<Awaited<ReturnType<PostgresOutlineStore['read']>>['candidate']>){return {candidateDigest:candidate.digest,output:candidate.output,ablations:[{genre:'suspense',judgment:'participates',reason:'测试宿主核对查证改变主线反击。'}],waivers:[]};}
async function allocationCount(tenantId:string){return Number((await pool.query<{n:number}>('SELECT count(*)::int n FROM camery_agents.budget_allocations WHERE tenant_id=$1',[tenantId])).rows[0]!.n);}

// Actual PG/task/budget/child-process recovery, with explicit synthetic protocol transport and human-host fixtures only.
it('recovers a candidate commit ACK loss through the original paid journal after review and source staleness',async()=>{
  const f=await fixture({live:true});let calls=0,lost=false;const save=f.store.saveCandidate.bind(f.store);
  vi.spyOn(f.store,'saveCandidate').mockImplementation(async(...args)=>{const saved=await save(...args);if(!lost){lost=true;throw new Error('fixture after candidate commit');}return saved;});
  const worker=new DurableWorker(f.durable,{retryDelayMs:1});worker.register(createOutlineWorkflow({store:f.store,ledger:f.ledger,sessionFor:outlineSessionFactory(outlineProtocolTransport(()=>{calls++;}))}));
  expect((await worker.runTask(f.task,'outline-first'))?.status).toBe('queued');expect(calls).toBe(1);const candidate=(await f.store.read(f.key)).candidate!;
  await f.store.review(f.key,decision(candidate),f.host);await f.store.putBrief({...f.put,expectedRevision:1,notes:'日志收尾前修改的目标。'});
  const recovery=await enqueueOutlineTask(f.store,f.durable,f.key);if(recovery.state!=='task')throw new Error('Expected original outline journal tail');expect(recovery.task.taskId).toBe(f.task.taskId);
  const replacement=new Pool({connectionString:url,max:2});try{
    let sessions=0;const durable=new PostgresDurableStore(replacement),store=new PostgresOutlineStore(replacement),retry=new DurableWorker(durable,{retryDelayMs:1});
    retry.register(createOutlineWorkflow({store,ledger:new PostgresBudgetLedger(replacement),sessionFor:async()=>{sessions++;throw new Error('Recovery must not require a provider configuration');}}));
    await available(recovery.task);expect((await retry.runTask(recovery.task,'outline-recovery'))?.status).toBe('succeeded');expect(sessions).toBe(0);expect(calls).toBe(1);
    expect((await durable.steps(f.task)).map(step=>[step.key,step.status])).toEqual([['budget.allocate','completed'],['agent.bind','completed'],['agent.0.decision','completed'],['outline.persist-candidate','completed']]);
    expect(await enqueueOutlineTask(store,durable,f.key)).toEqual({state:'reviewed',status:'reviewed'});
  }finally{await replacement.end();}
  expect(await allocationCount(f.key.tenantId)).toBe(1);expect((await f.ledger.project(f.target)).used.tokens).toBe('300');
});
it('holds an unknown paid result until a human supplies the original full envelope, then replays without another session',async()=>{
  const f=await fixture({live:true});let captured:Json|undefined,calls=0;
  class LostDecisionCommit extends PostgresDurableStore{
    override async completeStep(lease:Lease,key:string,output:Json){if(key==='agent.0.decision'){captured=structuredClone(output);throw new Error('fixture paid decision write failure');}return super.completeStep(lease,key,output);}
  }
  const first=new DurableWorker(new LostDecisionCommit(pool));first.register(createOutlineWorkflow({store:f.store,ledger:f.ledger,sessionFor:outlineSessionFactory(outlineProtocolTransport(()=>{calls++;}))}));
  expect((await first.runTask(f.task,'outline-uncertain'))?.status).toBe('reconciling');expect(calls).toBe(1);expect(captured).toBeDefined();expect((await f.store.read(f.key)).candidate).toBeNull();
  const pending=await enqueueOutlineTask(f.store,f.durable,f.key);if(pending.state!=='task')throw new Error('Expected original unknown task');expect(pending.task.status).toBe('reconciling');expect(await first.runTask(pending.task,'no-auto-retry')).toBeNull();expect(calls).toBe(1);
  const allocation=(await pool.query<{allocation_id:string}>('SELECT allocation_id FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3',[f.key.tenantId,f.key.projectId,f.task.taskId])).rows[0]!;
  const settlement={...f.target,taskId:f.task.taskId,allocationId:allocation.allocation_id,actorId:'fixture-billing-owner',receiptId:'fixture-known-bill',reference:'synthetic protocol usage, not a real invoice',actual:{steps:1,tokens:230,costMicros:3}};
  await expect(f.ledger.settleConfirmed(settlement)).rejects.toMatchObject({code:'TASK_NOT_TERMINAL'});
  await f.store.putBrief({...f.put,expectedRevision:1,notes:'对账期间更新的目标。'});
  await f.durable.reconcile({tenantId:f.key.tenantId,taskId:f.task.taskId,stepKey:'agent.0.decision',actorId:'fixture-reconciler',resolution:{kind:'completed',output:captured!}});
  const replacement=new Pool({connectionString:url,max:2});try{
    const durable=new PostgresDurableStore(replacement),store=new PostgresOutlineStore(replacement),retry=new DurableWorker(durable);let sessions=0;
    retry.register(createOutlineWorkflow({store,ledger:new PostgresBudgetLedger(replacement),sessionFor:async()=>{sessions++;throw new Error('Reconciled journal must not call provider');}}));
    expect((await retry.runTask(f.task,'after-human-reconciliation'))?.status).toBe('succeeded');expect(sessions).toBe(0);expect((await store.read(f.key)).candidate?.model.providerRequestId).toBe('fixture-outline-workflow');
  }finally{await replacement.end();}
  expect(calls).toBe(1);expect(await allocationCount(f.key.tenantId)).toBe(1);expect((await f.ledger.settleConfirmed(settlement)).state).toBe('settled');expect((await f.ledger.project(f.target)).used.tokens).toBe('230');
});
it.each(['budget','stale'] as const)('blocks %s before any provider session and never replaces the original task',async kind=>{
  const f=await fixture({tokens:kind==='budget'?100:300});let calls=0,sessions=0;
  if(kind==='stale'){if(!('put' in f.source))throw new Error('Expected Development source');await f.source.store.putBrief({...f.source.put,expectedRevision:1,idea:'排队期间修改的原始创意。'});}
  const make=outlineSessionFactory(outlineProtocolTransport(()=>{calls++;})),worker=new DurableWorker(f.durable);worker.register(createOutlineWorkflow({store:f.store,ledger:f.ledger,sessionFor:async(...args)=>{sessions++;return make(...args);}}));
  const result=await worker.runTask(f.task,'outline-blocked');expect(result?.status).toBe(kind==='budget'?'queued':'succeeded');expect(calls).toBe(0);expect(sessions).toBe(0);expect((await f.store.read(f.key)).candidate).toBeNull();
  if(kind==='stale')expect(result?.output).toMatchObject({state:'blocked',reason:'OUTLINE_SOURCE_CHANGED'});
  const existing=await enqueueOutlineTask(f.store,f.durable,f.key);if(existing.state!=='task')throw new Error('Expected authoritative original blocked task');expect(existing.task.taskId).toBe(f.task.taskId);expect(await allocationCount(f.key.tenantId)).toBe(kind==='budget'?0:1);
});
it('processes a legal large Bible input and full outline through the existing Worker byte gates',async()=>{
  const f=await fixture({large:true});expect(Buffer.byteLength(JSON.stringify(prepareOutline(f.run.brief,f.run.source).input))).toBeGreaterThan(131072);let calls=0;
  const worker=new DurableWorker(f.durable);worker.register(createOutlineWorkflow({store:f.store,ledger:f.ledger,sessionFor:outlineSessionFactory(outlineProtocolTransport(()=>{calls++;},true))}));
  const result=await worker.runTask(f.task,'large-outline');expect(result?.status).toBe('succeeded');expect(calls).toBe(1);const progress=await f.store.read(f.key);
  expect(Buffer.byteLength(JSON.stringify(progress.candidate!.output))).toBeGreaterThan(262144);expect(progress.candidate?.output.assets).toHaveLength(128);expect(progress.candidate?.source).toEqual(f.run.source);
  const steps=await f.durable.steps(f.task);expect(steps.every(step=>Buffer.byteLength(JSON.stringify(step.input))<=131072)).toBe(true);expect(steps.every(step=>Buffer.byteLength(JSON.stringify(step.output))<=1048576)).toBe(true);expect(Buffer.byteLength(JSON.stringify(result!.output))).toBeLessThan(1024);
});
it('restores reviewed progress over two MiB from a new pool without truncation or duplicate calls',async()=>{
  const f=await fixture({aggregate:true});let calls=0,lost=false;const save=f.store.saveCandidate.bind(f.store);
  vi.spyOn(f.store,'saveCandidate').mockImplementation(async(...args)=>{const saved=await save(...args);if(!lost){lost=true;throw new Error('fixture large candidate ACK loss');}return saved;});
  const worker=new DurableWorker(f.durable,{retryDelayMs:1});worker.register(createOutlineWorkflow({store:f.store,ledger:f.ledger,sessionFor:outlineSessionFactory(outlineProtocolTransport(()=>{calls++;},true))}));
  expect((await worker.runTask(f.task,'large-progress-first'))?.status).toBe('queued');
  const candidate=(await f.store.read(f.key)).candidate!;expect(Buffer.byteLength(JSON.stringify(candidate.output))).toBeGreaterThan(262144);
  await f.store.review(f.key,decision(candidate),f.host);const progress=await f.store.read(f.key);
  expect(Buffer.byteLength(JSON.stringify(progress))).toBeGreaterThan(2097152);
  for(const envelope of [progress.run,progress.candidate,progress.review])expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(2097152);
  expect(captureOutlineProgress(f.key,progress)).toEqual(progress);expect(progress.candidate?.output).toEqual(candidate.output);expect(progress.review?.source).toEqual(f.run.source);
  const replacement=new Pool({connectionString:url,max:2});try{
    const durable=new PostgresDurableStore(replacement),store=new PostgresOutlineStore(replacement),retry=new DurableWorker(durable);let sessions=0;
    retry.register(createOutlineWorkflow({store,ledger:new PostgresBudgetLedger(replacement),sessionFor:async()=>{sessions++;throw new Error('Large cached journal must not require a model session');}}));
    await available(f.task);const recovered=await retry.runTask(f.task,'large-progress-recovery');expect(recovered?.status).toBe('succeeded');
    expect(recovered?.output).toMatchObject({state:'candidate',candidateDigest:candidate.digest});expect(await store.read(f.key)).toEqual(progress);expect(sessions).toBe(0);
  }finally{await replacement.end();}
  expect(calls).toBe(1);expect(await allocationCount(f.key.tenantId)).toBe(1);
});
it('restores a SIGKILLed outline decision from a new pool without model credentials or duplicated allocation',async()=>{
  const f=await fixture({live:true});const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',"process.send?.({event:'child-started'});await import(process.argv[1]);",new URL('./fixtures/crash-outline-worker.ts',import.meta.url).href],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,CAMERY_OUTLINE_CRASH_TENANT:f.key.tenantId,CAMERY_OUTLINE_CRASH_TASK:f.task.taskId},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const exited=once(child,'exit');let resolve!:(calls:number)=>void;const observed:string[]=[];const checkpoint=new Promise<number>(done=>{resolve=done;});let timer:ReturnType<typeof setTimeout>|undefined;
  child.on('message',message=>{if(message&&typeof message==='object'&&'event' in message){observed.push(String(message.event));if(message.event==='decision-saved'&&'calls' in message)resolve(message.calls as number);}});
  try{
    expect(await Promise.race([checkpoint,exited.then(()=>{throw new Error('Owned outline child exited before commit ('+observed.join(' > ')+')');}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Owned outline child did not reach committed decision ('+observed.join(' > ')+')')),20000);})])).toBe(1);
    child.kill('SIGKILL');const exit=await exited;expect(exit[1]==='SIGKILL'||exit[0]!==0).toBe(true);expect((await f.durable.steps(f.task)).find(step=>step.key==='agent.0.decision')?.status).toBe('completed');expect((await f.store.read(f.key)).candidate).toBeNull();
    await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2",[f.task.tenantId,f.task.taskId]);
    if(!('put' in f.source))throw new Error('Expected Development source');await f.source.store.putBrief({...f.source.put,expectedRevision:1,idea:'强杀恢复前修改的来源。'});
    const replacement=new Pool({connectionString:url,max:2});try{
      let sessions=0;const durable=new PostgresDurableStore(replacement),store=new PostgresOutlineStore(replacement),worker=new DurableWorker(durable);
      worker.register(createOutlineWorkflow({store,ledger:new PostgresBudgetLedger(replacement),sessionFor:async()=>{sessions++;throw new Error('Cached result must not require a provider session');}}));
      const pending=await enqueueOutlineTask(store,durable,f.key);if(pending.state!=='task')throw new Error('Expected original crashed task');expect(pending.task.taskId).toBe(f.task.taskId);
      expect((await worker.runTask(pending.task,'after-outline-sigkill'))?.status).toBe('succeeded');expect(sessions).toBe(0);expect((await store.read(f.key)).candidate?.model.providerRequestId).toBe('fixture-outline-workflow');expect(await store.isCurrent(f.key)).toBe(false);
    }finally{await replacement.end();}
    expect(await allocationCount(f.key.tenantId)).toBe(1);
  }finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
});

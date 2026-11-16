import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { DurableWorker,PostgresDurableStore,migrateDurable } from '@camery/durable';
import type { Json,Task } from '@camery/durable';
import { migrateAgentBudgets,PostgresBudgetLedger } from '@camery/agents/node';
import { ModelError } from '@camery/model-modes';
import { PostgresDevelopmentStore } from '../src/node/store.js';
import { migrateDevelopment } from '../src/node/migrate.js';
import { developmentMethodPins,developmentStageCallId } from '../src/node/contracts.js';
import { createDevelopmentStageWorkflow,enqueueNextDevelopmentTask } from '../src/node/workflow.js';
import { prepareDevelopmentStage } from '../src/development.js';
import { canonical,hash } from '../src/data.js';
import { foundationFixture } from './foundation-fixture.js';
import { protocolTransport,sessionFactory } from './workflow-pg-support.js';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL is required for original-development task recovery');
const pool=new Pool({connectionString:url});const tenants:string[]=[];
beforeAll(async()=>{await migrateDurable(pool);await migrateAgentBudgets(pool);await migrateDevelopment(pool);});
afterAll(async()=>{
  try{for(const tenant of tenants){
    for(const table of ['reviews','candidates','runs','briefs'])await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenant]);
    for(const table of ['budget_events','budget_allocations','budget_projects'])await pool.query(`DELETE FROM camery_agents.${table} WHERE tenant_id=$1`,[tenant]);
    for(const table of ['events','signals','steps','tasks'])await pool.query(`DELETE FROM camery_durable.${table} WHERE tenant_id=$1`,[tenant]);
  }}finally{await pool.end();}
});
async function fixture(live=false){
  const tenantId='development-task-'+randomUUID();tenants.push(tenantId);const key={tenantId,projectId:'project',runId:'develop'};const store=new PostgresDevelopmentStore(pool);const durable=new PostgresDurableStore(pool);const ledger=new PostgresBudgetLedger(pool);
  const briefInput={tenantId,projectId:key.projectId,briefId:'idea',expectedRevision:0,actorId:'fixture-author',idea:'港城学徒收到未来写来的潮汐信，必须决定是否公开时刻表。',episodeCount:10,targetSeconds:120};
  const brief=await store.putBrief(briefInput);const run=await store.start({...key,briefId:brief.brief.briefId,expectedRevision:brief.brief.revision,expectedBriefDigest:brief.brief.digest,methods:developmentMethodPins(),
    execution:{connectionId:'fixture',modeDigest:hash('fixture-original-mode'),modelIdentity:'fixture/original',evidence:live?'live_model':'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:100,costMicros:live?10:0},limits:{steps:2,tokens:200,costMicros:live?20:0}}});
  await ledger.createProject({tenantId,projectId:key.projectId,currency:'CNY',limits:run.execution.limits},'fixture-budget-owner');
  const ready=await enqueueNextDevelopmentTask(store,durable,key);if(ready.state!=='task')throw new Error('Expected first development task');
  const host={tenantId,projectId:key.projectId,actor:{kind:'human' as const,id:'fixture-human'},at:'2026-11-16T12:00:00.000Z',authorize:()=>true};
  return {key,run,store,durable,ledger,task:ready.task,host,briefInput};
}
async function available(task:Task){await pool.query('UPDATE camery_durable.tasks SET available_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2',[task.tenantId,task.taskId]);}
it('recovers a committed candidate acknowledgement loss through the full existing journal without a second provider or allocation',async()=>{
  const f=await fixture();let calls=0;const firstStore=new PostgresDevelopmentStore(pool);const save=firstStore.saveCandidate.bind(firstStore);let interrupted=false;
  vi.spyOn(firstStore,'saveCandidate').mockImplementation(async(...args)=>{const candidate=await save(...args);if(!interrupted){interrupted=true;throw new Error('synthetic after candidate commit');}return candidate;});
  const firstWorker=new DurableWorker(f.durable,{retryDelayMs:1});firstWorker.register(createDevelopmentStageWorkflow({store:firstStore,ledger:f.ledger,sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
  expect((await firstWorker.runTask(f.task,'interrupted'))?.status).toBe('queued');expect(calls).toBe(1);expect((await f.store.read(f.key)).foundation.candidate).not.toBeNull();
  const originalSteps=await f.durable.steps(f.task);expect(originalSteps.map(step=>step.key)).toEqual(['budget.allocate','agent.bind','agent.0.decision','original.persist-stage']);expect(originalSteps.at(-1)?.status).toBe('failed');
  const replacementPool=new Pool({connectionString:url});try{
    let replacementCalls=0;let sessions=0;let episodeAckLost=false;const durable=new PostgresDurableStore(replacementPool);const store=new PostgresDevelopmentStore(replacementPool);const worker=new DurableWorker(durable,{retryDelayMs:1});const makeSession=sessionFactory(protocolTransport(()=>{replacementCalls++;}));
    const saveEpisode=store.saveCandidate.bind(store);vi.spyOn(store,'saveCandidate').mockImplementation(async(...args)=>{const candidate=await saveEpisode(...args);if(candidate.stage==='episodes'&&!episodeAckLost){episodeAckLost=true;throw new Error('synthetic episode commit acknowledgement loss');}return candidate;});
    worker.register(createDevelopmentStageWorkflow({store,ledger:new PostgresBudgetLedger(replacementPool),sessionFor:async(...args)=>{sessions++;return makeSession(...args);}}));
    const recovery=await enqueueNextDevelopmentTask(store,durable,f.key);if(recovery.state!=='task')throw new Error('Expected committed foundation task recovery');expect(recovery.task.taskId).toBe(f.task.taskId);
    await available(recovery.task);expect((await worker.runTask(recovery.task,'replacement'))?.status).toBe('succeeded');expect(replacementCalls).toBe(0);expect(sessions).toBe(0);
    const steps=await durable.steps(f.task);expect(steps.map(step=>step.key)).toEqual(originalSteps.map(step=>step.key));expect(steps.every(step=>step.status==='completed')).toBe(true);
    expect((await enqueueNextDevelopmentTask(store,durable,f.key)).state).toBe('awaiting_review');
    const candidate=(await store.read(f.key)).foundation.candidate!;const edited=structuredClone(candidate.output);edited.title='人类修改后的港城设定';await store.review(f.key,'foundation',{candidateDigest:candidate.digest,output:edited},f.host);
    const next=await enqueueNextDevelopmentTask(store,durable,f.key);if(next.state!=='task')throw new Error('Expected reviewed episode task');expect(next.task.taskId).not.toBe(f.task.taskId);
    expect((await worker.runTask(next.task,'episode-worker'))?.status).toBe('queued');expect(replacementCalls).toBe(1);const episode=(await store.read(f.key)).episodes.candidate!;expect(episode.output.episodes).toHaveLength(10);
    await store.review(f.key,'episodes',{candidateDigest:episode.digest,output:episode.output},f.host);await store.putBrief({...f.briefInput,expectedRevision:1,idea:'任务收尾前更新的创意，不应丢失已付费的原结果。'});
    const episodeRecovery=await enqueueNextDevelopmentTask(store,durable,f.key);if(episodeRecovery.state!=='task')throw new Error('Expected episode tail before reviewed/stale state');expect(episodeRecovery.task.taskId).toBe(next.task.taskId);
    await available(episodeRecovery.task);expect((await worker.runTask(episodeRecovery.task,'episode-tail'))?.status).toBe('succeeded');expect(replacementCalls).toBe(1);expect(sessions).toBe(1);expect((await durable.steps(next.task)).every(step=>step.status==='completed')).toBe(true);
    expect(await enqueueNextDevelopmentTask(store,durable,f.key)).toEqual({state:'reviewed',stage:'episodes',status:'reviewed'});
  }finally{await replacementPool.end();}
  expect((await f.ledger.project({tenantId:f.key.tenantId,projectId:f.key.projectId})).used.tokens).toBe('200');
  expect((await pool.query('SELECT count(*)::int n FROM camery_agents.budget_allocations WHERE tenant_id=$1',[f.key.tenantId])).rows[0].n).toBe(2);
});
it('holds an unknown external result for explicit full-receipt reconciliation and preserves a paid old brief after revision',async()=>{
  const f=await fixture(true);let calls=0;const worker=new DurableWorker(f.durable);worker.register(createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:sessionFactory({exchange:async()=>{calls++;throw new ModelError('NETWORK_FAILED','synthetic unknown','unknown');}})}));
  expect((await worker.runTask(f.task,'unknown'))?.status).toBe('reconciling');expect(calls).toBe(1);expect((await f.store.read(f.key)).foundation.candidate).toBeNull();
  let replacementCalls=0;const replacement=new DurableWorker(f.durable);replacement.register(createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:sessionFactory(protocolTransport(()=>{replacementCalls++;}))}));
  expect(await replacement.runTask(f.task,'must-not-resend')).toBeNull();expect(replacementCalls).toBe(0);const repeated=await enqueueNextDevelopmentTask(f.store,f.durable,f.key);expect(repeated.state).toBe('task');if(repeated.state!=='task')throw new Error();expect(repeated.task.status).toBe('reconciling');expect(repeated.task.taskId).toBe(f.task.taskId);
  await f.store.putBrief({...f.briefInput,expectedRevision:1,idea:'用户已经改写了创意，旧调用仍待对账。'});
  const output=foundationFixture();const prepared=prepareDevelopmentStage(f.run.brief,'foundation');const execution=f.run.execution;
  const modelCall={tenantId:f.key.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:'live_model',callId:developmentStageCallId(f.key,'foundation'),providerRequestId:'synthetic-operator-verified',inputDigest:prepared.inputDigest,outputDigest:hash(output),usage:{inputTokens:50,outputTokens:30}};
  const recovered={kind:'result',output:{kind:'finish',output},usage:{tokens:80,costMicros:null},outcome:'completed',modelCall};
  // Trusted synthetic operator evidence for this test, not a provider signature or an HTTP reconciliation API.
  await f.durable.reconcile({...f.task,stepKey:'agent.0.decision',actorId:'fixture-operator',resolution:{kind:'completed',output:JSON.parse(canonical(recovered)) as Json}});
  const reconciled=await enqueueNextDevelopmentTask(f.store,f.durable,f.key);if(reconciled.state!=='task')throw new Error('Expected paid old-brief reconciliation task');expect(reconciled.task.status).toBe('queued');expect(reconciled.task.taskId).toBe(f.task.taskId);
  expect((await replacement.runTask(reconciled.task,'reconciled'))?.status).toBe('succeeded');expect(replacementCalls).toBe(0);const progress=await f.store.read(f.key);expect(progress.foundation.candidate?.model).toEqual(modelCall);expect(progress.run.brief.revision).toBe(1);
  expect(await enqueueNextDevelopmentTask(f.store,f.durable,f.key)).toEqual({state:'stale'});expect((await f.ledger.project({tenantId:f.key.tenantId,projectId:f.key.projectId})).used.tokens).toBe('100');
});
it('survives actual SIGKILL after the external decision SQL commit and resumes with new pools without provider replay',async()=>{
  const f=await fixture(true);const child=spawn(process.execPath,['--import',import.meta.resolve('tsx'),'--input-type=module','-e',"process.send?.({event:'child-started'});await import(process.argv[1]);",new URL('./fixtures/crash-development-worker.ts',import.meta.url).href],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,CAMERY_DEVELOPMENT_CRASH_TENANT:f.key.tenantId,CAMERY_DEVELOPMENT_CRASH_TASK:f.task.taskId},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  const exited=once(child,'exit');let resolve:((calls:number)=>void)|undefined;const observed:string[]=[];const checkpoint=new Promise<number>(done=>{resolve=done;});child.on('message',message=>{if(message&&typeof message==='object'&&'event' in message){observed.push(String(message.event)+('key' in message?':'+String(message.key):'status' in message?':'+String(message.status):''));if(message.event==='decision-saved'&&'calls' in message)resolve?.(message.calls as number);}});let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    expect(await Promise.race([checkpoint,exited.then(()=>{throw new Error('Owned crash child exited before decision commit ('+observed.join(' > ')+')');}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Owned crash child did not reach decision checkpoint ('+observed.join(' > ')+')')),20000);})])).toBe(1);
    child.kill('SIGKILL');const exit=await exited;expect(exit[1]==='SIGKILL'||exit[0]!==0).toBe(true);expect((await f.durable.steps(f.task)).find(step=>step.key==='agent.0.decision')?.status).toBe('completed');expect((await f.store.read(f.key)).foundation.candidate).toBeNull();
    await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2",[f.task.tenantId,f.task.taskId]);
    const replacementPool=new Pool({connectionString:url});try{
      let calls=0;const durable=new PostgresDurableStore(replacementPool);const store=new PostgresDevelopmentStore(replacementPool);const worker=new DurableWorker(durable);worker.register(createDevelopmentStageWorkflow({store,ledger:new PostgresBudgetLedger(replacementPool),sessionFor:sessionFactory(protocolTransport(()=>{calls++;}))}));
      const recovery=await enqueueNextDevelopmentTask(store,durable,f.key);if(recovery.state!=='task')throw new Error('Expected crashed original task');expect(recovery.task.taskId).toBe(f.task.taskId);
      expect((await worker.runTask(recovery.task,'after-sigkill'))?.status).toBe('succeeded');expect(calls).toBe(0);expect((await store.read(f.key)).foundation.candidate?.model.providerRequestId).toBe('fixture-foundation');
      expect((await pool.query('SELECT count(*)::int n FROM camery_agents.budget_allocations WHERE tenant_id=$1',[f.key.tenantId])).rows[0].n).toBe(1);
    }finally{await replacementPool.end();}
  }finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
});

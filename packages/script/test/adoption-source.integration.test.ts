import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import type {VersionProjectKey} from '@camery/versioning/node';
import {generateFoundation,generateEpisodes} from '../src/development.js';
import type {DevelopmentReviewHost} from '../src/contracts.js';
import {validateReviewedFoundation} from '../src/reviewed.js';
import {createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack} from '../src/method-assets.js';
import {migrateDevelopment} from '../src/node/migrate.js';
import {PostgresDevelopmentStore} from '../src/node/store.js';
import {createDevelopmentSourceGuard} from '../src/node/adoption-source.js';
import {developmentStageCallId,episodeExecutionFromFull} from '../src/node/contracts.js';
import type {DevelopmentRun} from '../src/node/contracts.js';
import {protocolTransport} from './workflow-pg-support.js';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for reviewed development adoption tests');
const pool=new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5000});
const owned:{tenantId:string;ir:VersionProjectKey}[]=[];
const registry=new MethodRegistry();
const methods={foundation:registry.register(createOriginalFoundationMethodPack()),episodes:registry.register(createOriginalEpisodesMethodPack())};
const execution={connectionId:'fixture-source',modeDigest:'a'.repeat(64),modelIdentity:'fixture-original',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};

// Actual PG source/audit and formal transactions; transport responses and host reviews remain explicit synthetic test fixtures.
beforeAll(async()=>{await migrateDevelopment(pool);await migrateVersioning(pool);});
afterAll(async()=>{
  let failed=false;
  for(const entry of owned){
    for(const table of ['run_origins','reviews','candidates','runs','briefs']){
      try{await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[entry.tenantId]);}catch{failed=true;}
    }
    const client=await pool.connect();
    try{
      await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');
      for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[entry.ir.tenantId,entry.ir.projectId]);
      await client.query('COMMIT');
    }catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}
  }
  await pool.end();if(failed)throw new Error('Reviewed development adoption fixture cleanup failed');
});

function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function context(run:DevelopmentRun,stage:'foundation'|'episodes'){
  return {tenantId:run.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,idempotencyKey:developmentStageCallId({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},stage),signal:new AbortController().signal};
}
function runner(run:DevelopmentRun,onCall:()=>void){
  const model=new ModelSession(new OpenAiCompatibleLlm(protocolTransport(onCall),{model:run.execution.modelIdentity,structuredOutput:'json_schema'}),{tenantId:run.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,modelIdentity:run.execution.modelIdentity,evidence:run.execution.evidence,maxCalls:1,timeoutMs:2000});
  return new MethodRunner(registry,[createStructuredGenerationExecutor(model)]);
}
async function formalCounts(key:VersionProjectKey){
  return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{total:string}>(`SELECT count(*)::text total FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.total)));
}
async function fixture(review:'reviewed'|'unreviewed'|'rejected'='reviewed'){
  const tenantId='development-adoption-'+randomUUID();const scope={tenantId,projectId:'project'};const key={...scope,runId:'source'};const ir={tenantId:id(tenantId),projectId:id('prj_demo')};owned.push({tenantId,ir});
  const store=new PostgresDevelopmentStore(pool);const versions=new PostgresVersionStore(pool);let calls=0;const onCall=()=>{calls++;};
  const put={...scope,briefId:'idea',expectedRevision:0,actorId:'author',idea:'修钟学徒收到未来的潮汐来信。',episodeCount:10,targetSeconds:120};const saved=await store.putBrief(put);
  const run=await store.start({...key,briefId:put.briefId,expectedRevision:1,expectedBriefDigest:saved.brief.digest,methods,execution});
  const host:DevelopmentReviewHost={...scope,actor:{kind:'human',id:'source-reviewer'},at:'2026-11-17T04:00:00.000Z',authorize:()=>true};
  const foundation=await generateFoundation({brief:run.brief,runner:runner(run,onCall),method:run.methods.foundation,context:context(run,'foundation')});await store.saveCandidate(key,foundation);
  const foundationReview=validateReviewedFoundation(run.brief,await store.review(key,'foundation',{candidateDigest:foundation.digest,output:{...foundation.output,title:'共同核验后的港城设定'}},host));
  const episodes=await generateEpisodes({brief:run.brief,foundation:foundationReview,runner:runner(run,onCall),method:run.methods.episodes,context:context(run,'episodes')});await store.saveCandidate(key,episodes);
  const episodesReview=review==='reviewed'?await store.review(key,'episodes',{candidateDigest:episodes.digest,output:episodes.output},host):review==='rejected'?await store.reject(key,'episodes','明确不采用这份分集。',host):null;
  const source={...key,runDigest:run.digest,briefDigest:run.brief.digest,foundationReviewDigest:foundationReview.digest,episodesReviewDigest:episodesReview?.digest??'f'.repeat(64)};
  await versions.initialize(ir,makePackage());
  // This existing IR edit isolates source/transaction composition. Persistent identity and complete development mapping are separate tests.
  const request=changeSet([{op:'update',op_id:id('op-source-guard'),collection:'shots',target:id('sh_1'),set:{action:foundationReview.output.title}}],{id:id('source-guard-change'),base_revisions:[{id:id('sh_1'),version:1}]});
  expect((await versions.submit(ir,request)).status).toBe('candidate');
  const approval={actor:{kind:'user' as const,id:id('user_1')},scope:{kind:'project' as const,id:ir.projectId},at:'2026-11-17T05:00:00.000Z',authorize:()=>true};
  return {tenantId,scope,key,ir,store,versions,put,run,host,foundationReview,source,request,approval,onCall,calls:()=>calls};
}

it('uses the adopter connection for actual reviewed source reconstruction without another source connection or new model call',async()=>{
  const f=await fixture();const original=await f.store.read(f.key);const forbidden=vi.fn(async()=>{throw new Error('Source guard opened a second connection');});
  const sameConnectionStore=new PostgresDevelopmentStore({connect:forbidden,query:forbidden} as unknown as Pool);
  const result=await f.versions.adoptGuarded(f.ir,f.request.id,f.approval,createDevelopmentSourceGuard(sameConnectionStore,f.source));
  expect(result.status).toBe('adopted');expect(forbidden).not.toHaveBeenCalled();expect(f.calls()).toBe(2);expect(await f.store.read(f.key)).toEqual(original);expect(result.state.adoptions).toHaveLength(1);
});

it('holds the real brief lock until formal commit so a source writer cannot cross the adoption boundary',async()=>{
  const f=await fixture();const entered=gate();const proceed=gate();let adopterPid=0;const guard=createDevelopmentSourceGuard(f.store,f.source);
  const adopting=f.versions.adoptGuarded(f.ir,f.request.id,f.approval,async client=>{await guard(client);adopterPid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;entered.resolve();await proceed.promise;});
  const applicationName='development-source-writer-'+randomUUID();const writerPool=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000,application_name:applicationName});let writing:ReturnType<PostgresDevelopmentStore['putBrief']>|undefined;
  try{
    await Promise.race([entered.promise,adopting.then(()=>{throw new Error('Formal adoption passed the held source checkpoint');})]);
    writing=new PostgresDevelopmentStore(writerPool).putBrief({...f.put,expectedRevision:1,idea:'采用提交后才允许发布的新创意。'});void writing.catch(()=>{});
    await vi.waitFor(async()=>{const activity=await pool.query<{blockers:number[]}>('SELECT pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1',[applicationName]);expect(activity.rows.some(row=>row.blockers.includes(adopterPid))).toBe(true);},{timeout:5000,interval:20});
    expect((await f.versions.read(f.ir))!.state.adoptions).toHaveLength(0);proceed.resolve();expect((await adopting).status).toBe('adopted');expect((await writing).brief.revision).toBe(2);expect((await f.versions.read(f.ir))!.state.adoptions).toHaveLength(1);expect(f.calls()).toBe(2);
  }finally{proceed.resolve();await Promise.allSettled([adopting,...(writing?[writing]:[])]);await writerPool.end();}
});

it('refuses a source already changed before adoption without changing a live formal candidate or any formal history',async()=>{
  const f=await fixture();const before=await f.versions.read(f.ir);const counts=await formalCounts(f.ir);await f.store.putBrief({...f.put,expectedRevision:1,idea:'正式采用之前已修改的创意。'});
  const guard=vi.fn(createDevelopmentSourceGuard(f.store,f.source));await expect(f.versions.adoptGuarded(f.ir,f.request.id,f.approval,guard)).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});expect(guard).toHaveBeenCalledOnce();expect(await f.versions.read(f.ir)).toEqual(before);expect(await formalCounts(f.ir)).toEqual(counts);expect(f.calls()).toBe(2);
});

it.each(['unreviewed','rejected','digest','scope','tenant','integrity'] as const)('refuses %s source evidence without a formal write or additional model call',async mode=>{
  const f=await fixture(mode==='unreviewed'||mode==='rejected'?mode:'reviewed');const before=await f.versions.read(f.ir);const counts=await formalCounts(f.ir);
  const source={...f.source,...(mode==='digest'?{foundationReviewDigest:'e'.repeat(64)}:{}),...(mode==='scope'?{projectId:'other'}:{}),...(mode==='tenant'?{tenantId:'other'}:{})};
  if(mode==='integrity')await pool.query("UPDATE camery_script.candidates SET record=jsonb_set(record,'{model,modelIdentity}','\"tampered-provider\"'::jsonb) WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 AND stage='foundation'",[f.tenantId,f.scope.projectId,f.key.runId]);
  const expected=mode==='unreviewed'||mode==='rejected'?'ADOPTION_SOURCE_UNREVIEWED':mode==='digest'?'ADOPTION_SOURCE_CHANGED':mode==='scope'||mode==='tenant'?'ADOPTION_SOURCE_MISSING':'DEVELOPMENT_SOURCE_UNAVAILABLE';
  await expect(f.versions.adoptGuarded(f.ir,f.request.id,f.approval,createDevelopmentSourceGuard(f.store,source))).rejects.toMatchObject({code:expected});expect(await f.versions.read(f.ir)).toEqual(before);expect(await formalCounts(f.ir)).toEqual(counts);expect(f.calls()).toBe(2);
});

it('accepts an actual episodes-only branch while retaining its real foundation owner and exact original receipt/audit',async()=>{
  const f=await fixture();const original=await f.store.read(f.key);const childKey={...f.scope,runId:'child'};
  const child=await f.store.fork({...childKey,sourceRunId:f.key.runId,expectedSourceRunDigest:f.run.digest,expectedRevision:1,expectedBriefDigest:f.run.brief.digest,actorId:'child-author',methods,stage:'episodes',expectedFoundationReviewDigest:f.foundationReview.digest,execution:{...episodeExecutionFromFull(f.run.execution),connectionId:'child-model',modeDigest:'d'.repeat(64),modelIdentity:'fixture-child'}});
  const candidate=await generateEpisodes({brief:child.brief,foundation:f.foundationReview,runner:runner(child,f.onCall),method:child.methods.episodes,context:context(child,'episodes')});await f.store.saveCandidate(childKey,candidate);const review=await f.store.review(childKey,'episodes',{candidateDigest:candidate.digest,output:candidate.output},f.host);
  const source={...f.source,...childKey,runDigest:child.digest,episodesReviewDigest:review.digest};
  expect((await f.versions.adoptGuarded(f.ir,f.request.id,f.approval,createDevelopmentSourceGuard(f.store,source))).status).toBe('adopted');
  const restored=await f.store.read(childKey);expect(restored.foundation).toEqual(original.foundation);expect(await f.store.read(f.key)).toEqual(original);expect(restored.episodes.candidate!.model).toMatchObject({connectionId:'child-model',modelIdentity:'fixture-child',callId:developmentStageCallId(childKey,'episodes')});expect(f.calls()).toBe(3);
  expect((await pool.query<{candidates:number;reviews:number}>("SELECT (SELECT count(*)::int FROM camery_script.candidates WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 AND stage='foundation') candidates,(SELECT count(*)::int FROM camery_script.reviews WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 AND stage='foundation') reviews",[f.tenantId,f.scope.projectId,childKey.runId])).rows[0]!).toEqual({candidates:0,reviews:0});
});

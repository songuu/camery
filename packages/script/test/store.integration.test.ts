import { randomBytes,randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import { migrateAccess } from '@camery/access/node';
import { migrateDurable } from '@camery/durable';
import { migrateAgentBudgets } from '@camery/agents/node';
import { createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack } from '../src/method-assets.js';
import { createFoundationCandidate,generateFoundation,generateEpisodes } from '../src/development.js';
import { hash } from '../src/data.js';
import type { DevelopmentCandidate,DevelopmentReviewHost,ReviewedDevelopment } from '../src/contracts.js';
import { developmentStageCallId,episodeExecutionFromFull } from '../src/node/contracts.js';
import type { DevelopmentRun,PutDevelopmentBrief,StartDevelopmentRun } from '../src/node/contracts.js';
import { PostgresDevelopmentStore } from '../src/node/store.js';
import { PostgresDevelopmentCatalog } from '../src/node/catalog.js';
import { migrateDevelopment } from '../src/node/migrate.js';
import { grantDevelopmentRuntimeRole,verifyDevelopmentRuntimeRole } from '../src/node/runtime-role.js';
import { episodeFixture } from './episode-fixture.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for development storage tests');
const pool=new Pool({connectionString:databaseUrl,max:6});const tenants:string[]=[];const story=episodeFixture();
const registry=new MethodRegistry();const methods={foundation:registry.register(createOriginalFoundationMethodPack()),episodes:registry.register(createOriginalEpisodesMethodPack())};
const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/original',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
// Permission probes must target real relations even on a fresh DB; do not depend on another suite's installation order.
beforeAll(async()=>{await migrateDurable(pool);await migrateAgentBudgets(pool);await migrateAccess(pool);await migrateDevelopment(pool);});
afterAll(async()=>{for(const tenantId of tenants)for(const table of ['run_origins','reviews','candidates','runs','briefs'])await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenantId]);await pool.end();});
async function fixture(){
  const tenantId='development-store-'+randomUUID();tenants.push(tenantId);const scope={tenantId,projectId:'project'};const key={...scope,runId:'run'};const store=new PostgresDevelopmentStore(pool);
  const put:PutDevelopmentBrief={...scope,briefId:'idea',expectedRevision:0,actorId:'author',idea:story.brief.idea,episodeCount:10,targetSeconds:120};
  const saved=await store.putBrief(put);const command:StartDevelopmentRun={...key,briefId:'idea',expectedRevision:1,expectedBriefDigest:saved.brief.digest,methods,execution};
  const host:DevelopmentReviewHost={...scope,actor:{kind:'human',id:'reviewer'},at:'2026-11-16T12:00:00.000Z',authorize:()=>true};
  return {tenantId,scope,key,store,put,saved,command,host};
}
function runnerFor(run:DevelopmentRun){
  const client=new OpenAiCompatibleLlm({exchange:async request=>{
    const body=request.body as {messages:{content:string}[]};const input=JSON.parse(body.messages.at(-1)!.content).untrustedSource;
    return {status:200,contentType:'application/json',body:{kind:'json',value:{id:input.foundation?'fixture-episodes':'fixture-foundation',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(input.foundation?story.output:story.foundation)}}],usage:{prompt_tokens:15,completion_tokens:8}}}};
  }},{model:'fixture-original',structuredOutput:'json_schema'});
  const session=new ModelSession(client,{tenantId:run.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,modelIdentity:run.execution.modelIdentity,evidence:run.execution.evidence,maxCalls:1,timeoutMs:2000});
  return new MethodRunner(registry,[createStructuredGenerationExecutor(session)]);
}
function context(run:DevelopmentRun,stage:'foundation'|'episodes'){
  const key={tenantId:run.tenantId,projectId:run.projectId,runId:run.runId};
  return {tenantId:run.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,idempotencyKey:developmentStageCallId(key,stage),signal:new AbortController().signal};
}
async function foundationFor(run:DevelopmentRun){return generateFoundation({brief:run.brief,runner:runnerFor(run),method:run.methods.foundation,context:context(run,'foundation')});}
async function episodesFor(run:DevelopmentRun,foundation:ReviewedDevelopment<'foundation'>){return generateEpisodes({brief:run.brief,foundation,runner:runnerFor(run),method:run.methods.episodes,context:context(run,'episodes')});}
function decision(candidate:DevelopmentCandidate){return {candidateDigest:candidate.digest,output:candidate.output};}

it('serializes brief/run/candidate/review races, binds retries to the original author and restores through a new pool',async()=>{
  const x=await fixture();const savedAgain=await x.store.putBrief(x.put);expect(savedAgain).toEqual(x.saved);
  await expect(x.store.putBrief({...x.put,actorId:'other'})).rejects.toMatchObject({code:'CONFLICT'});
  const [run,retry]=await Promise.all([x.store.start(x.command),x.store.start(x.command)]);expect(retry).toEqual(run);
  await expect(x.store.start({...x.command,execution:{...execution,modelIdentity:'other'}})).rejects.toMatchObject({code:'CONFLICT'});
  const foundation=await foundationFor(run);expect(await Promise.all([x.store.saveCandidate(x.key,foundation),x.store.saveCandidate(x.key,foundation)])).toEqual([foundation,foundation]);
  const altered=createFoundationCandidate(run.brief,foundation.output,{...foundation.model,providerRequestId:'different'});
  await expect(x.store.saveCandidate(x.key,altered)).rejects.toMatchObject({code:'CONFLICT'});
  const [review,repeated]=await Promise.all([x.store.review(x.key,'foundation',decision(foundation),x.host),x.store.review(x.key,'foundation',decision(foundation),{...x.host,at:'2026-11-17T12:00:00.000Z'})]);expect(repeated).toEqual(review);
  await expect(x.store.review(x.key,'foundation',decision(foundation),{...x.host,actor:{kind:'human',id:'other'}})).rejects.toMatchObject({code:'CONFLICT'});
  const episodes=await episodesFor(run,review as ReviewedDevelopment<'foundation'>);await x.store.saveCandidate(x.key,episodes);const final=await x.store.review(x.key,'episodes',decision(episodes),x.host);
  const replacement=new Pool({connectionString:databaseUrl});try{const restored=await new PostgresDevelopmentStore(replacement).read(x.key);expect(restored.run).toEqual(run);expect(restored.foundation).toEqual({candidate:foundation,review});expect(restored.episodes).toEqual({candidate:episodes,review:final});}finally{await replacement.end();}
  const count=await pool.query('SELECT (SELECT count(*)::int FROM camery_script.briefs WHERE tenant_id=$1) briefs,(SELECT count(*)::int FROM camery_script.runs WHERE tenant_id=$1) runs,(SELECT count(*)::int FROM camery_script.candidates WHERE tenant_id=$1) candidates,(SELECT count(*)::int FROM camery_script.reviews WHERE tenant_id=$1) reviews',[x.tenantId]);expect(count.rows[0]).toEqual({briefs:1,runs:1,candidates:2,reviews:2});
  for(const changed of [{tenantId:'other'},{projectId:'other'}])await expect(x.store.read({...x.key,...changed})).rejects.toMatchObject({code:'NOT_FOUND'});
});
it('appends immutable creative revisions, returns committed retries after later changes and blocks new stale use',async()=>{
  const x=await fixture();const run=await x.store.start(x.command);const foundation=await foundationFor(run);await x.store.saveCandidate(x.key,foundation);
  const review=await x.store.review(x.key,'foundation',decision(foundation),x.host);
  const edit={...x.put,expectedRevision:1,idea:'修钟人决定把尚未寄出的信公开给全城。'};const [second,retry]=await Promise.all([x.store.putBrief(edit),x.store.putBrief(edit)]);expect(retry).toEqual(second);expect(second.brief.revision).toBe(2);
  expect(await x.store.getBrief({...x.scope,briefId:'idea'})).toEqual(second);expect(await x.store.getBrief({...x.scope,briefId:'idea',revision:1})).toEqual(x.saved);expect(await x.store.putBrief(x.put)).toEqual(x.saved);
  await expect(x.store.putBrief({...edit,idea:'同基版本的另一个编辑'})).rejects.toMatchObject({code:'CONFLICT'});
  expect(await x.store.isCurrent(x.key)).toBe(false);expect(await x.store.start(x.command)).toEqual(run);
  await expect(x.store.start({...x.command,runId:'stale-new-run'})).rejects.toMatchObject({code:'CONFLICT'});
  expect(await x.store.review(x.key,'foundation',decision(foundation),{...x.host,at:'2026-11-18T12:00:00.000Z'})).toEqual(review);
  await expect(x.store.review(x.key,'foundation',decision(foundation),{...x.host,authorize:()=>false})).rejects.toMatchObject({code:'FORBIDDEN'});
  const episodes=await episodesFor(run,review as ReviewedDevelopment<'foundation'>);await x.store.saveCandidate(x.key,episodes);expect((await x.store.read(x.key)).episodes.candidate).toEqual(episodes);
  await expect(x.store.review(x.key,'episodes',decision(episodes),x.host)).rejects.toMatchObject({code:'CONFLICT'});
  const rejected=await x.store.reject(x.key,'episodes','创意已修改，请重新开发。',x.host);expect(rejected.status).toBe('rejected');expect(await x.store.reject(x.key,'episodes','创意已修改，请重新开发。',{...x.host,at:'2026-11-18T12:00:00.000Z'})).toEqual(rejected);
  await expect(x.store.review(x.key,'episodes',decision(episodes),x.host)).rejects.toMatchObject({code:'CONFLICT'});
});
it('rejects missing stages and foreign model identities, and enforces a first-write rejection over later approvals',async()=>{
  const x=await fixture();const run=await x.store.start(x.command);
  await expect(x.store.review(x.key,'foundation',{candidateDigest:'a'.repeat(64),output:story.foundation},x.host)).rejects.toMatchObject({code:'INCOMPLETE'});
  const candidate=await foundationFor(run);
  for(const change of [{modelIdentity:'other'},{connectionId:'other'},{modeDigest:'b'.repeat(64)},{evidence:'live_model' as const},{callId:'not-the-durable-stage-call'}]){
    const forged=createFoundationCandidate(run.brief,candidate.output,{...candidate.model,...change});await expect(x.store.saveCandidate(x.key,forged)).rejects.toMatchObject({code:'INVALID_EVIDENCE'});
  }
  await x.store.saveCandidate(x.key,candidate);const rejected=await x.store.reject(x.key,'foundation','主线不成立。',x.host);expect(rejected.status).toBe('rejected');
  await expect(x.store.review(x.key,'foundation',decision(candidate),x.host)).rejects.toMatchObject({code:'CONFLICT'});
  await expect(x.store.reject(x.key,'foundation','不同的原因',x.host)).rejects.toMatchObject({code:'CONFLICT'});
});
it('rolls back failed writes and recovers lost commit acknowledgements without duplicating an immutable record',async()=>{
  const x=await fixture();const run=await x.store.start(x.command);const candidate=await foundationFor(run);
  function fault(after:'insert'|'commit'){
    let once=true;return {connect:async()=>{const client=await pool.connect();return {query:async(sql:string,values?:unknown[])=>{const result=await client.query(sql,values);if(once&&(after==='insert'?sql.startsWith('INSERT INTO camery_script.candidates'):sql==='COMMIT')){once=false;throw new Error('private synthetic acknowledgement loss');}return result;},release:(destroy?:boolean)=>client.release(destroy)};}} as unknown as Pool;
  }
  await expect(new PostgresDevelopmentStore(fault('insert')).saveCandidate(x.key,candidate)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect((await x.store.read(x.key)).foundation.candidate).toBeNull();
  await expect(new PostgresDevelopmentStore(fault('commit')).saveCandidate(x.key,candidate)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect((await x.store.read(x.key)).foundation.candidate).toEqual(candidate);
  expect(await x.store.saveCandidate(x.key,candidate)).toEqual(candidate);
});
it('captures mutable brief and human decision data before a database wait',async()=>{
  const x=await fixture();
  function delayed(){let opened!:()=>void;let release!:()=>void;const entered=new Promise<void>(resolve=>{opened=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});let first=true;
    async function wait(){if(first){first=false;opened();await gate;}}
    const wrapper={connect:async()=>{await wait();return pool.connect();},query:async(sql:string,values?:unknown[])=>{await wait();return pool.query(sql,values);}} as unknown as Pool;
    return {store:new PostgresDevelopmentStore(wrapper),entered,release};
  }
  const briefGate=delayed();const edit={...x.put,expectedRevision:1,idea:'真正提交的创意'};const pending=briefGate.store.putBrief(edit);await briefGate.entered;edit.idea='等待期间被替换';edit.actorId='other';briefGate.release();const saved=await pending;expect(saved.brief.idea).toBe('真正提交的创意');expect(saved.actorId).toBe('author');
  const run=await x.store.start({...x.command,expectedRevision:2,expectedBriefDigest:saved.brief.digest});const candidate=await foundationFor(run);await x.store.saveCandidate(x.key,candidate);
  const reviewGate=delayed();const selected={candidateDigest:candidate.digest,output:structuredClone(candidate.output)};const host={...x.host,actor:{...x.host.actor}};const reviewing=reviewGate.store.review(x.key,'foundation',selected,host);await reviewGate.entered;
  selected.output.title='等待后替换的标题';host.actor.id='other';host.at='2026-11-18T12:00:00.000Z';host.authorize=()=>false;reviewGate.release();const review=await reviewing;expect(review.actorId).toBe('reviewer');expect(review.at).toBe(x.host.at);expect((review.output as {title:string}).title).toBe(candidate.output.title);
});
it('rebuilds persisted candidates and audit references instead of trusting saved digests',async()=>{
  const x=await fixture();const run=await x.store.start(x.command);const candidate=await foundationFor(run);await x.store.saveCandidate(x.key,candidate);
  const altered=createFoundationCandidate(run.brief,candidate.output,{...candidate.model,modelIdentity:'different-provider-model'});
  await pool.query("UPDATE camery_script.candidates SET record=$4::jsonb,digest=$5 WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 AND stage='foundation'",[x.tenantId,x.scope.projectId,x.key.runId,JSON.stringify(altered),altered.digest]);
  await expect(x.store.read(x.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  await pool.query("UPDATE camery_script.candidates SET record=$4::jsonb,digest=$5 WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 AND stage='foundation'",[x.tenantId,x.scope.projectId,x.key.runId,JSON.stringify(candidate),candidate.digest]);
  const review=await x.store.review(x.key,'foundation',decision(candidate),x.host);const {digest:_digest,...body}=review;const forged={...body,candidateDigest:'c'.repeat(64)};const record={...forged,digest:hash(forged)};
  await pool.query("UPDATE camery_script.reviews SET record=$4::jsonb,digest=$5 WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 AND stage='foundation'",[x.tenantId,x.scope.projectId,x.key.runId,JSON.stringify(record),record.digest]);await expect(x.store.read(x.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('uses a dedicated append-only LOGIN without access to authentication, budgets or other tenant scopes',async()=>{
  const x=await fixture();const role='development_data_'+randomBytes(8).toString('hex');const password=randomBytes(24).toString('hex');let runtime:Pool|undefined;let created=false;
  try{
    await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);created=true;await grantDevelopmentRuntimeRole(pool,role);
    const url=new URL(databaseUrl!);url.username=role;url.password=password;runtime=new Pool({connectionString:url.toString()});await verifyDevelopmentRuntimeRole(runtime);
    const store=new PostgresDevelopmentStore(runtime);const run=await store.start(x.command);const candidate=await foundationFor(run);await store.saveCandidate(x.key,candidate);const review=await store.review(x.key,'foundation',decision(candidate),x.host);
    const child=await store.fork({...x.scope,runId:'child',sourceRunId:run.runId,expectedSourceRunDigest:run.digest,expectedRevision:1,expectedBriefDigest:run.brief.digest,actorId:'reviewer',methods:run.methods,stage:'episodes',expectedFoundationReviewDigest:review.digest,execution:episodeExecutionFromFull(run.execution)});
    expect((await store.read({...x.scope,runId:child.runId})).foundation).toEqual({candidate,review});
    expect((await store.read(x.key)).foundation.review?.status).toBe('reviewed');await expect(store.read({...x.key,tenantId:'other'})).rejects.toMatchObject({code:'NOT_FOUND'});
    for(const sql of ['SELECT * FROM camery_access.users','SELECT * FROM camery_agents.budget_projects','UPDATE camery_script.briefs SET actor_id=actor_id','DELETE FROM camery_script.reviews','UPDATE camery_script.run_origins SET actor_id=actor_id','DELETE FROM camery_script.run_origins','SELECT * FROM camery_script.migrations'])await expect(runtime.query(sql)).rejects.toMatchObject({code:'42501'});
  }finally{await runtime?.end();if(created){await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`);}}
});

it('atomically forks immutable original evidence under concurrent retries and restores flattened origins through a new pool',async()=>{
  const x=await fixture();const source=await x.store.start(x.command);const candidate=await foundationFor(source);await x.store.saveCandidate(x.key,candidate);const review=await x.store.review(x.key,'foundation',decision(candidate),x.host);
  const command={...x.scope,runId:'child',sourceRunId:source.runId,expectedSourceRunDigest:source.digest,expectedRevision:1,expectedBriefDigest:source.brief.digest,actorId:'new-author',methods:source.methods,stage:'episodes' as const,expectedFoundationReviewDigest:review.digest,execution:episodeExecutionFromFull(source.execution)};
  const [child,retry]=await Promise.all([x.store.fork(command),x.store.fork(command)]);expect(retry).toEqual(child);const key={...x.scope,runId:child.runId};
  await expect(x.store.review(key,'foundation',decision(candidate),x.host)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(x.store.reject(key,'foundation','不可改写继承审核',x.host)).rejects.toMatchObject({code:'FORBIDDEN'});await expect(x.store.saveCandidate(key,candidate)).rejects.toMatchObject({code:'FORBIDDEN'});
  const episodes=await episodesFor(child,review as ReviewedDevelopment<'foundation'>);await x.store.saveCandidate(key,episodes);const approved=await x.store.review(key,'episodes',decision(episodes),x.host);
  const summary=await new PostgresDevelopmentCatalog(pool).summary(key);expect(summary).toMatchObject({foundationCandidateDigest:candidate.digest,foundationReviewStatus:'reviewed',episodesCandidateDigest:episodes.digest,episodesReviewStatus:'reviewed'});
  const next=await x.store.fork({...command,runId:'grandchild',sourceRunId:child.runId,expectedSourceRunDigest:child.digest});expect(next.origin).toMatchObject({sourceRunId:child.runId,foundation:{runId:source.runId}});
  const replacement=new Pool({connectionString:databaseUrl});try{expect(await new PostgresDevelopmentStore(replacement).read(key)).toEqual({run:child,foundation:{candidate,review},episodes:{candidate:episodes,review:approved}});}finally{await replacement.end();}
  const rows=await pool.query('SELECT run_id,stage FROM camery_script.candidates WHERE tenant_id=$1 ORDER BY run_id,stage',[x.tenantId]);expect(rows.rows).toEqual([{run_id:'child',stage:'episodes'},{run_id:'run',stage:'foundation'}]);
  await x.store.putBrief({...x.put,expectedRevision:1,idea:'更新后的创意只影响尚未创建的分支。'});expect(await x.store.fork(command)).toEqual(child);await expect(x.store.fork({...command,runId:'stale'})).rejects.toMatchObject({code:'CONFLICT'});
});

it('rolls back failed origin inserts and recovers a committed fork whose acknowledgement was lost',async()=>{
  const x=await fixture();const source=await x.store.start(x.command);const candidate=await foundationFor(source);await x.store.saveCandidate(x.key,candidate);const review=await x.store.review(x.key,'foundation',decision(candidate),x.host);
  const command={...x.scope,runId:'child',sourceRunId:source.runId,expectedSourceRunDigest:source.digest,expectedRevision:1,expectedBriefDigest:source.brief.digest,actorId:'author',methods:source.methods,stage:'episodes' as const,expectedFoundationReviewDigest:review.digest,execution:episodeExecutionFromFull(source.execution)};
  function fault(mode:'insert'|'commit'){return {query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();return {release:()=>client.release(),query:async(sql:string,values?:unknown[])=>{if(mode==='insert'&&sql.startsWith('INSERT INTO camery_script.run_origins'))throw new Error('origin insert failure');const result=await client.query(sql,values);if(mode==='commit'&&sql==='COMMIT')throw new Error('commit response lost');return result;}};}} as unknown as Pool;}
  await expect(new PostgresDevelopmentStore(fault('insert')).fork(command)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(x.store.read({...x.scope,runId:'child'})).rejects.toMatchObject({code:'NOT_FOUND'});
  await expect(new PostgresDevelopmentStore(fault('commit')).fork(command)).rejects.toMatchObject({code:'STORAGE_FAILED'});const recovered=await x.store.fork(command);expect(recovered.origin?.foundation?.reviewDigest).toBe(review.digest);expect((await pool.query('SELECT count(*)::int total FROM camery_script.run_origins WHERE tenant_id=$1',[x.tenantId])).rows).toEqual([{total:1}]);
});

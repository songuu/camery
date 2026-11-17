import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import { migrateBible,PostgresBibleStore } from '@camery/bible/node';
import { migrateIngest,PostgresDocumentStore } from '../../ingest/src/node/index.js';
import { reviewFixture } from '../../bible/test/review-support.js';
import { generateFoundation,generateEpisodes } from '../src/development.js';
import { createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack } from '../src/method-assets.js';
import { validateReviewedFoundation } from '../src/reviewed.js';
import { migrateDevelopment,PostgresDevelopmentStore,developmentMethodPins,developmentStageCallId } from '../src/node/index.js';
import { captureOutlineBrief,resolveOutlineSource,generateOutline,createOutlineMethodPack,reviewOutline } from '../src/outline/node/index.js';
import type { OutlineSourceSnapshot } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import { protocolTransport } from './workflow-pg-support.js';
import { outlineFixture } from './outline-support.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL is required for outline source integration tests');
const pool=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});const tenants:string[]=[];
beforeAll(async()=>{await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);});
afterAll(async()=>{
  let failed=false;
  try{for(const tenant of tenants){
    for(const table of ['run_origins','reviews','candidates','runs','briefs'])try{await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
    for(const table of ['reviews','candidates','chunks','runs'])try{await pool.query(`DELETE FROM camery_bible.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
    for(const table of ['reading_checkpoints','documents'])try{await pool.query(`DELETE FROM camery_ingest.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
  }}finally{await pool.end();}
  if(failed)throw new Error('Outline source fixture cleanup failed');
});
const execution={connectionId:'outline-source-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture-original',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
function scope(){const tenantId='outline-source-'+randomUUID();tenants.push(tenantId);return {tenantId,projectId:'project'};}
function host(target:ReturnType<typeof scope>){return {...target,actor:{kind:'human' as const,id:'fixture-editor'},at:'2026-11-17T10:45:00.000Z',authorize:()=>true};}
async function development(){
  const target=scope(),key={...target,runId:'development'};const store=new PostgresDevelopmentStore(pool);const put={...target,briefId:'idea',expectedRevision:0,actorId:'author',idea:'旧信让学徒重新决定港城的航期。',episodeCount:3,targetSeconds:90};const brief=(await store.putBrief(put)).brief;
  const run=await store.start({...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,methods:developmentMethodPins(),execution});
  const context=(stage:'foundation'|'episodes')=>({tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:developmentStageCallId(key,stage),signal:new AbortController().signal});
  const registry=new MethodRegistry();for(const pack of [createOriginalFoundationMethodPack(),createOriginalEpisodesMethodPack()])registry.register(pack);
  const session=new ModelSession(new OpenAiCompatibleLlm(protocolTransport(),{model:'fixture-original',structuredOutput:'json_schema'}),{tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:'synthetic_replay',maxCalls:2,timeoutMs:2000});
  const runner=new MethodRunner(registry,[createStructuredGenerationExecutor(session)]);
  const foundation=await generateFoundation({brief,runner,method:run.methods.foundation,context:context('foundation')});await store.saveCandidate(key,foundation);
  const reviewed=validateReviewedFoundation(brief,await store.review(key,'foundation',{candidateDigest:foundation.digest,output:{...foundation.output,title:'实际数据库中人工改名的港城'}},host(target)));
  const episodes=await generateEpisodes({brief,foundation:reviewed,runner,method:run.methods.episodes,context:context('episodes')});await store.saveCandidate(key,episodes);
  const episodesReview=await store.review(key,'episodes',{candidateDigest:episodes.digest,output:episodes.output},host(target));
  const descriptor={kind:'development' as const,...key,runDigest:run.digest,briefDigest:brief.digest,foundationReviewDigest:reviewed.digest,episodesReviewDigest:episodesReview.digest};
  return {target,key,store,put,descriptor};
}
async function bible(){
  const template=reviewFixture(),target=scope(),key={...target,runId:'bible'};const documents=new PostgresDocumentStore(pool);await documents.append({...target,documentId:'book',batchId:'first',expectedRevision:0,text:template.source.document.text});
  const model=template.candidate.records[0]!.model;
  const store=new PostgresBibleStore(pool);const run=await store.start({...key,documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:template.source.document.sourceDigest,method:template.candidate.method,chunkLimits:{maxCharacters:22,maxBytes:88},execution:{...execution,connectionId:model.connectionId,modeDigest:model.modeDigest,modelIdentity:model.modelIdentity,limits:{steps:10,tokens:1000,costMicros:0}}});
  for(const [index,entry] of template.candidate.records.entries()){
    const body={version:1 as const,planDigest:run.plan.digest,chunkId:run.plan.chunks[index]!.id,method:run.method,output:entry.output,model:{...entry.model,tenantId:target.tenantId}};await store.saveChunk(key,{...body,digest:hash(body)});
  }
  const candidate=await store.materialize(key);const confirmed=await store.confirm(key,{...template.decision,candidateDigest:candidate.digest},host(target));
  const descriptor={kind:'bible' as const,...key,runDigest:run.digest,documentId:'book',revision:confirmed.source.revision,sourceDigest:confirmed.source.sourceDigest,reviewDigest:confirmed.digest};
  return {target,key,store,documents,descriptor};
}
async function propose(source:OutlineSourceSnapshot){
  const sample=outlineFixture(),output=sample.output,reference=source.references[0]!.id;const {sourceRefIds:_refs,...selection}=sample.context;
  output.adaptation.decisions[0]!.sourceRefIds=[reference];for(const item of [...output.characters,...output.beats,...output.assets])item.origin.sourceRefIds=[reference];
  const target={tenantId:source.descriptor.tenantId,projectId:source.descriptor.projectId};const brief=captureOutlineBrief({...target,briefId:'adaptation',revision:1,notes:'保留人工确认的来源冲突。',...selection});
  let calls=0;const session=new ModelSession(new OpenAiCompatibleLlm({async exchange(){calls++;return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'outline-source-protocol',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:150,completion_tokens:80}}}};}},{model:'fixture-outline',structuredOutput:'json_schema'}),{tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:'fixture/outline',evidence:'synthetic_replay',maxCalls:1,timeoutMs:2000});
  const registry=new MethodRegistry(),method=registry.register(createOutlineMethodPack());const context={tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:'outline-proposal',signal:new AbortController().signal};
  const candidate=await generateOutline({brief,source,method,context,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(session)])});
  const reviewed=reviewOutline(brief,source,candidate,{candidateDigest:candidate.digest,output:candidate.output,ablations:[{genre:'suspense',judgment:'participates',reason:'模拟人工核对查证改变反击条件。'}],waivers:[]},host(target));
  expect(calls).toBe(1);expect(reviewed.source).toEqual(source);expect(reviewed.actorId).toBe('fixture-editor');return reviewed;
}

// Actual old PG source/audit reads + real adapter protocol; not outline persistence, a live model or a human quality grade.
it('loads stored edited Development audits with a new pool and passes that exact source through one outline call/review',async()=>{
  const f=await development();const source=await resolveOutlineSource(f.descriptor,{development:f.store});
  expect((source.material as {foundation:{title:string}}).foundation.title).toBe('实际数据库中人工改名的港城');
  const replacement=new Pool({connectionString:databaseUrl,max:1});try{expect(await resolveOutlineSource(f.descriptor,{development:new PostgresDevelopmentStore(replacement)})).toEqual(source);}finally{await replacement.end();}
  expect((await propose(source)).output.episodes).toHaveLength(3);
});
it('refuses a stored Development source after its actual brief revision advances',async()=>{
  const f=await development();await f.store.putBrief({...f.put,expectedRevision:1,idea:'已变更的新故事。'});await expect(resolveOutlineSource(f.descriptor,{development:f.store})).rejects.toMatchObject({code:'CONFLICT'});
});
it('loads actual confirmed Bible evidence through a new pool and preserves it in outline generation/review',async()=>{
  const f=await bible();const source=await resolveOutlineSource(f.descriptor,{bible:f.store});
  expect(source.references.some(reference=>reference.path==='/claims/0')).toBe(true);expect(source.material).not.toHaveProperty('document');
  const replacement=new Pool({connectionString:databaseUrl,max:1});try{expect(await resolveOutlineSource(f.descriptor,{bible:new PostgresBibleStore(replacement)})).toEqual(source);}finally{await replacement.end();}
  await propose(source);
});
it('refuses stale Bible documents and does not mistake a damaged original review for an approval',async()=>{
  const f=await bible();await f.documents.append({...f.target,documentId:'book',batchId:'next',expectedRevision:1,text:'新增后文。'});
  await expect(resolveOutlineSource(f.descriptor,{bible:f.store})).rejects.toMatchObject({code:'CONFLICT'});
  const g=await bible();await pool.query("UPDATE camery_bible.reviews SET record=jsonb_set(record,'{actorId}','\"tampered\"'::jsonb) WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3",[g.key.tenantId,g.key.projectId,g.key.runId]);
  await expect(resolveOutlineSource(g.descriptor,{bible:g.store})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

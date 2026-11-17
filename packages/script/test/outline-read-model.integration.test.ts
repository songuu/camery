import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll,afterAll,expect,it } from 'vitest';
import { MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import { migrateBible } from '@camery/bible/node';
import { migrateIngest } from '../../ingest/src/node/index.js';
import { generateEpisodes } from '../src/development.js';
import { createOriginalEpisodesMethodPack } from '../src/method-assets.js';
import { validateReviewedFoundation } from '../src/reviewed.js';
import { migrateDevelopment,episodeExecutionFromFull,developmentStageCallId } from '../src/node/index.js';
import { PostgresOutlineStore,PostgresOutlineCatalog,PostgresOutlineBriefCatalog,PostgresOutlineSourceCatalog,migrateOutline,outlineCallId,projectOutlineBrief,projectOutlineRun,projectOutlineStatus } from '../src/outline/node/index.js';
import { OutlineStartSchema,OutlineConfirmSchema,OutlineRunViewSchema } from '../src/outline/http.js';
import { createDevelopmentSourceFixture,createBibleSourceFixture,createOutlineProposal } from './outline-source-pg-support.js';
import { protocolTransport } from './workflow-pg-support.js';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL required for outline read models');
const pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:5000}),tenants:string[]=[];
const execution={connectionId:'outline-source-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline',evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros:0},limits:{steps:1,tokens:300,costMicros:0}};
beforeAll(async()=>{await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);});
afterAll(async()=>{
  let failed=false;try{for(const tenant of tenants)for(const [schema,tables] of [['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']]] as const)
    for(const table of tables)try{await pool.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}}
  finally{await pool.end();}if(failed)throw new Error('Outline read-model fixture cleanup failed');
});
function scope(){const target={tenantId:'outline-view-'+randomUUID(),projectId:'project'};tenants.push(target.tenantId);return target;}
function briefCommand(target:ReturnType<typeof scope>){return {...target,briefId:'adaptation',actorId:'fixture-author',expectedRevision:0,notes:'保持已确认港城故事的选择与冲突。',episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']};}
function publicSelection<T extends {tenantId:string;projectId:string}>(value:T){const {tenantId:_tenant,projectId:_project,...selection}=value;return selection;}

// Actual databases and original adapter protocol; human identities/decisions remain explicit synthetic test-host fixtures.
it.each(['development','bible'] as const)('discovers a reviewed %s source and restores full human-edited public data through a new pool',async kind=>{
  const target=scope(),source=kind==='development'?await createDevelopmentSourceFixture(pool,target):await createBibleSourceFixture(pool,target);
  const catalog=new PostgresOutlineSourceCatalog(pool),selected=await catalog.list({...target,kind});expect(selected.items.map(item=>item.source)).toEqual([publicSelection(source.descriptor)]);
  expect(selected.items[0]!.source).not.toHaveProperty('tenantId');expect(await catalog.list({...target,projectId:'other',kind})).toEqual({items:[],nextCursor:null});
  const store=new PostgresOutlineStore(pool),put=briefCommand(target);const saved=await store.putBrief(put);expect((await new PostgresOutlineBriefCatalog(pool).list(target)).items[0]).toMatchObject({briefId:put.briefId,revision:1});
  expect((await new PostgresOutlineCatalog(pool).list(target)).items).toEqual([]);expect(projectOutlineBrief(saved).brief.digest).toBe(saved.brief.digest);
  const command=OutlineStartSchema.parse({runId:'outline',briefId:put.briefId,expectedRevision:1,expectedBriefDigest:saved.brief.digest,source:selected.items[0]!.source});
  const key={...target,runId:command.runId},run=await store.start({...target,...command,source:{...command.source,...target},execution});
  expect(projectOutlineStatus(await store.read(key),await store.isCurrent(key),null).state).toBe('not_dispatched');
  const proposal=await createOutlineProposal(run.source,{brief:run.brief,callId:outlineCallId(key)});await store.saveCandidate(key,proposal.candidate);
  expect(projectOutlineStatus(await store.read(key),true,null).state).toBe('awaiting_review');
  const edited=structuredClone(proposal.output);edited.adaptation.title='数据库中的人工修订';
  const confirm=OutlineConfirmSchema.parse({candidateDigest:proposal.candidate.digest,output:edited,ablations:proposal.review.ablations,waivers:proposal.review.waivers});
  await expect(store.review(key,confirm,{...proposal.host,authorize:()=>false})).rejects.toMatchObject({code:'FORBIDDEN'});await store.review(key,confirm,proposal.host);
  const expected=projectOutlineRun(await store.read(key),true,null);expect(expected.candidate?.output).toEqual(proposal.output);expect(expected.review).toMatchObject({status:'reviewed',output:edited});
  expect((await new PostgresOutlineCatalog(pool).summary(key))).toMatchObject({runDigest:run.digest,candidateDigest:proposal.candidate.digest,reviewStatus:'reviewed'});
  const replacement=new Pool({connectionString:url,max:2});try{
    const restored=new PostgresOutlineStore(replacement);expect(OutlineRunViewSchema.parse(projectOutlineRun(await restored.read(key),await restored.isCurrent(key),null))).toEqual(expected);
    expect((await new PostgresOutlineSourceCatalog(replacement).list({...target,kind})).items).toEqual(selected.items);
  }finally{await replacement.end();}
  if('put' in source)await source.store.putBrief({...source.put,expectedRevision:1,idea:'审核之后追加的新创意。'});
  else await source.documents.append({...target,documentId:'book',batchId:'changed',expectedRevision:1,text:'第三章 新证据\n新的航期改变旧计划。\n'});
  expect(await store.isCurrent(key)).toBe(false);expect(projectOutlineRun(await store.read(key),false,null)).toMatchObject({state:'reviewed',sourceChanged:true});
  expect((await catalog.list({...target,kind})).items).toHaveLength(1);await expect(store.start({...target,...command,runId:'stale-new-run',source:{...command.source,...target},execution})).rejects.toMatchObject({code:'CONFLICT'});
});
it('pages actual run microseconds and stable latest briefs without omitting no-run briefs or crossing scope',async()=>{
  const target=scope(),source=await createDevelopmentSourceFixture(pool,target),store=new PostgresOutlineStore(pool),put=briefCommand(target),saved=await store.putBrief(put);
  for(let index=0;index<22;index++){
    const runId='run-'+String(index).padStart(2,'0');await store.start({...target,runId,briefId:put.briefId,expectedRevision:1,expectedBriefDigest:saved.brief.digest,source:source.descriptor,execution});
    await pool.query("UPDATE camery_outline.runs SET created_at=$4::timestamptz,record=jsonb_set(record,'{createdAt}',to_jsonb($5::text)) WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3",[target.tenantId,target.projectId,runId,`2026-11-17T12:00:00.00000${index%2+1}Z`,'2026-11-17T12:00:00.000Z']);
  }
  const catalog=new PostgresOutlineCatalog(pool),first=await catalog.list(target);expect(first.items).toHaveLength(20);expect(first.nextCursor).toBeTruthy();
  const second=await catalog.list({...target,cursor:first.nextCursor!});expect(second.items).toHaveLength(2);const expected=Array.from({length:22},(_,index)=>index).sort((a,b)=>b%2-a%2||b-a).map(index=>'run-'+String(index).padStart(2,'0'));
  expect([...first.items,...second.items].map(item=>item.runId)).toEqual(expected);expect(JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString('utf8')).at).toMatch(/\.000001Z$/);
  await expect(catalog.list({...target,projectId:'other',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(catalog.list({...target,briefId:'different',cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect((await catalog.list({...target,projectId:'other'})).items).toEqual([]);
  for(let index=0;index<21;index++)await store.putBrief({...put,briefId:'no-run-'+String(index).padStart(2,'0')});
  await store.putBrief({...put,expectedRevision:1,notes:' '.repeat(120)+'合法末尾。'});const briefs=new PostgresOutlineBriefCatalog(pool),briefPage=await briefs.list(target);
  expect(briefPage.items[0]).toMatchObject({briefId:'adaptation',revision:2,notesPreview:' '.repeat(120)});expect(briefPage.items).toHaveLength(20);
  expect((await briefs.list({...target,cursor:briefPage.nextCursor!})).items).toHaveLength(2);expect((await catalog.list(target)).items.every(item=>item.briefRevision===1)).toBe(true);
});
it('discovers an episodes-only Development branch using its actual foundation owner without inventing a child audit',async()=>{
  const target=scope(),source=await createDevelopmentSourceFixture(pool,target),parent=await source.store.read(source.key),foundation=validateReviewedFoundation(parent.run.brief,parent.foundation.review);
  const key={...target,runId:'episodes-redo'},run=await source.store.fork({...key,sourceRunId:parent.run.runId,expectedSourceRunDigest:parent.run.digest,expectedRevision:1,expectedBriefDigest:parent.run.brief.digest,actorId:'fixture-editor',methods:parent.run.methods,stage:'episodes',expectedFoundationReviewDigest:foundation.digest,execution:episodeExecutionFromFull(parent.run.execution)});
  const registry=new MethodRegistry();registry.register(createOriginalEpisodesMethodPack());const session=new ModelSession(new OpenAiCompatibleLlm(protocolTransport(),{model:'fixture-original',structuredOutput:'json_schema'}),{tenantId:target.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,modelIdentity:run.execution.modelIdentity,evidence:'synthetic_replay',maxCalls:1,timeoutMs:2000});
  const candidate=await generateEpisodes({brief:run.brief,foundation,method:run.methods.episodes,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(session)]),context:{tenantId:target.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,idempotencyKey:developmentStageCallId(key,'episodes'),signal:new AbortController().signal}});
  await source.store.saveCandidate(key,candidate);const review=await source.store.review(key,'episodes',{candidateDigest:candidate.digest,output:candidate.output},{...target,actor:{kind:'human',id:'fixture-editor'},at:'2026-11-17T12:45:00.000Z',authorize:()=>true});
  const page=await new PostgresOutlineSourceCatalog(pool).list({...target,kind:'development'});expect(page.items.find(item=>item.source.runId===key.runId)?.source).toEqual({kind:'development',runId:key.runId,runDigest:run.digest,briefDigest:run.brief.digest,foundationReviewDigest:foundation.digest,episodesReviewDigest:review.digest});
  expect((await pool.query("SELECT count(*)::int n FROM camery_script.reviews WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3 AND stage='foundation'",[target.tenantId,target.projectId,key.runId])).rows[0]).toEqual({n:0});
});

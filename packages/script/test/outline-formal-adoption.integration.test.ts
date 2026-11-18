import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient,QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {upgradeV05Package,upgradeV06Package,validatePackage} from '@camery/ir';
import {migrateBible} from '@camery/bible/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import type {PersistedAdoptOptions,VersionProjectKey} from '@camery/versioning/node';
import {migrateIngest,PostgresDocumentStore} from '../../ingest/src/node/index.js';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {migrateDevelopment,PostgresDevelopmentStore} from '../src/node/index.js';
import {migrateOutline,outlineCallId,PostgresOutlineStore} from '../src/outline/node/index.js';
import {createOutlineSourceGuard,outlineAdoptionSource} from '../src/outline/node/formal-source.js';
import {finalizeOutlineChangeSet,prepareOutlineMappingDraft} from '../src/outline/node/formal-mapping.js';
import type {OutlineFormalIdentities} from '../src/outline/node/formal-contracts.js';
import {readOutlineFormalProjection} from '../src/outline/node/formal-projection.js';
import {selectedOutlineProjection} from './outline-formal-mapping-support.js';
import {createBibleSourceFixture,createDevelopmentSourceFixture,createOutlineProposal} from './outline-source-pg-support.js';

const url=process.env['CAMERY_TEST_DATABASE_URL'];
if(!url)throw new Error('CAMERY_TEST_DATABASE_URL is required for outline formal adoption tests');
const pool=new Pool({connectionString:url,max:8,connectionTimeoutMillis:5000});
const versionStore=new PostgresVersionStore(pool),tenants:string[]=[],projects:VersionProjectKey[]=[];
type SourceChange='outline'|'development'|'bible';

beforeAll(async()=>{
  await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateVersioning(pool);
});
afterAll(async()=>{
  let failed=false;
  try{
    for(const key of projects){
      const client=await pool.connect();
      try{
        await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');
        for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);
        await client.query('COMMIT');
      }catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}
    }
    for(const tenant of tenants)for(const [schema,tables] of [['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']]] as const)
      for(const table of tables)try{await pool.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
  }finally{await pool.end();}
  if(failed)throw new Error('Outline formal adoption fixture cleanup failed');
});

function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(kind:'development'|'bible'='development'){
  const target={tenantId:'outline-formal-'+randomUUID(),projectId:'project'};tenants.push(target.tenantId);
  const upstream=kind==='development'?await createDevelopmentSourceFixture(pool,target):await createBibleSourceFixture(pool,target);
  const store=new PostgresOutlineStore(pool),key={...target,runId:'outline'};
  const put={...target,briefId:'adaptation',expectedRevision:0,actorId:'fixture-editor',notes:'保持已审阅港城故事。',episodeCount:3,targetSeconds:90,paidEpisodeNumbers:[3],mainGenre:'rebirth-revenge',auxiliaryGenres:['suspense']};
  const brief=(await store.putBrief(put)).brief;
  const execution={connectionId:'outline-source-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline',evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros:0},limits:{steps:1,tokens:300,costMicros:0}};
  const run=await store.start({...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:upstream.descriptor,execution});
  const proposal=await createOutlineProposal(run.source,{brief:run.brief,callId:outlineCallId(key)});
  await store.saveCandidate(key,proposal.candidate);
  const review=await store.review(key,{candidateDigest:proposal.candidate.digest,output:proposal.output,ablations:proposal.review.ablations,waivers:proposal.review.waivers},proposal.host);
  const progress=await store.read(key),source=outlineAdoptionSource(key,progress);
  const head=upgradeV06Package(upgradeV05Package(makePackage()));
  for(const [field,value] of Object.entries(head))if(Array.isArray(value))(head as unknown as Record<string,unknown>)[field]=[];
  head.project.source_ids=[];head.project.rights_status='unknown';head.project.scope={label:'大纲正式采用',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};
  const formalKey={tenantId:id(randomUUID()),projectId:head.project.id};projects.push(formalKey);
  // These fixed bindings belong only to this synthetic host; a production identity registry is a separate boundary.
  const locals=(group:string,rows:readonly {id:string}[])=>rows.map(row=>({localId:row.id,id:id(`outline-formal-${group}-${row.id}`)}));
  const identities:OutlineFormalIdentities={tenantId:run.tenantId,projectId:run.projectId,target:formalKey,owner:{runId:run.runId,runDigest:run.digest},planId:id('outline-formal-plan'),characters:locals('character',review.output.characters),beats:locals('beat',review.output.beats),episodes:review.output.episodes.map(row=>({number:row.number,episodeId:id(`outline-formal-episode-${row.number}`),planId:id(`outline-formal-episode-plan-${row.number}`)})),assets:locals('asset',review.output.assets),plotUnits:locals('unit',review.output.plotUnits),decisions:locals('decision',review.output.adaptation.decisions)};
  const draft=prepareOutlineMappingDraft({progress,source,identities,reviewer:{key:review.actorId,id:id('outline-formal-reviewer')},head});
  const request=finalizeOutlineChangeSet({draft,changeSetId:id('outline-formal-change'),author:{kind:'user',id:id('outline-formal-adopter')},operationIds:draft.operations.map(row=>({slot:row.slot,id:id(`outline-formal-op:${row.slot}`)}))});
  await versionStore.initialize(formalKey,head);const pending=await versionStore.submit(formalKey,request);
  expect(pending.status).toBe('candidate');expect(pending.issues).toEqual([]);
  const approval:PersistedAdoptOptions={actor:request.author,scope:{kind:'project',id:formalKey.projectId},at:'2026-11-18T10:00:00.000Z',authorize:()=>true,expectation:{expectedSnapshotRevision:head.revision.number,expectedWriteVersion:pending.writeVersion}};
  return {target,key,upstream,store,put,progress,source,review,identities,formalKey,request,approval,calls:proposal.calls};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function changeSource(f:Fixture,kind:SourceChange,writerPool=pool){
  if(kind==='outline')return new PostgresOutlineStore(writerPool).putBrief({...f.put,expectedRevision:1,notes:'新的大纲创作要求。'});
  if('put' in f.upstream)return new PostgresDevelopmentStore(writerPool).putBrief({...f.upstream.put,expectedRevision:1,idea:'新的上游原创开发目标。'});
  return new PostgresDocumentStore(writerPool).append({...f.target,documentId:'book',batchId:'later',expectedRevision:1,text:'上游文档后续追加内容。'});
}
async function counts(key:VersionProjectKey){
  return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{total:string}>(`SELECT count(*)::text total FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.total)));
}
function observedPool(observe:(client:PoolClient,text:string)=>Promise<void>,afterCommit?:()=>void):Pool{
  const connect=async()=>{
    const client=await pool.connect();
    return new Proxy(client,{get(target,property){
      if(property==='query')return async(input:string|QueryConfig,values?:unknown[])=>{
        const text=typeof input==='string'?input:input.text;await observe(target,text);
        const result=await target.query(input,values);if(text.trim().toUpperCase()==='COMMIT')afterCommit?.();return result;
      };
      const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
    }});
  };
  return new Proxy(pool,{get(target,property){if(property==='connect')return connect;const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
}

it.each(['outline','development','bible'] as const)('holds the actual %s source lock on the formal adoption backend until COMMIT',async kind=>{
  const f=await fixture(kind==='bible'?'bible':'development'),entered=gate(),proceed=gate();
  const locations:{phase:string;pid:number;txid:string}[]=[];
  const guarded=new PostgresVersionStore(observedPool(async(client,text)=>{
    if(text.includes('FOR UPDATE')||text.startsWith('INSERT INTO camery_versioning.adoptions')){
      const at=(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!;
      locations.push({phase:text.includes('FOR UPDATE')?'version-lock':'adoption-write',...at});
    }
  }));
  const guard=createOutlineSourceGuard(f.store,f.source);
  const adopting=guarded.adoptGuarded(f.formalKey,f.request.id,f.approval,async client=>{
    await guard(client);const at=(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!;
    locations.push({phase:'source-guard',...at});entered.resolve();await proceed.promise;
  });
  void adopting.catch(()=>{});
  const name='outline_formal_writer_'+randomUUID(),writerPool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,application_name:name});
  let writing:ReturnType<typeof changeSource>|undefined;
  try{
    await Promise.race([entered.promise,adopting.then(()=>{throw new Error('Formal adoption finished before its source checkpoint');})]);
    writing=changeSource(f,kind,writerPool);void writing.catch(()=>{});
    await vi.waitFor(async()=>{
      const activity=await pool.query<{blockers:number[]}>('SELECT pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1',[name]);
      expect(activity.rows.some(row=>row.blockers.includes(locations[0]!.pid))).toBe(true);
    },{timeout:5000,interval:20});
    expect(locations.map(row=>row.phase)).toEqual(['source-guard']);
    proceed.resolve();const adopted=await adopting;expect(adopted.status).toBe('adopted');expect(adopted.issues).toEqual([]);await writing;
    expect(locations.map(row=>row.phase)).toEqual(['source-guard','version-lock','adoption-write']);
    expect(new Set(locations.map(row=>row.pid)).size).toBe(1);expect(new Set(locations.map(row=>row.txid)).size).toBe(1);
    const head=adopted.state.head;if(head.schema_version!=='0.7.0-draft')throw new Error('Expected adopted v07 outline head');
    expect(validatePackage(head).valid).toBe(true);
    const {projection,binding}=selectedOutlineProjection(head,f.identities);expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review.output);
    expect(await f.store.isCurrent(f.key)).toBe(false);expect(f.calls).toBe(1);
  }finally{proceed.resolve();await Promise.allSettled([adopting,...(writing?[writing]:[])]);await writerPool.end();}
});

it.each(['outline','development','bible'] as const)('refuses first formal adoption after the latest %s source changes without formal writes',async kind=>{
  const f=await fixture(kind==='bible'?'bible':'development'),before=await versionStore.read(f.formalKey),beforeCounts=await counts(f.formalKey);
  await changeSource(f,kind);
  await expect(versionStore.adoptGuarded(f.formalKey,f.request.id,f.approval,createOutlineSourceGuard(f.store,f.source))).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});
  expect(await versionStore.read(f.formalKey)).toEqual(before);expect(await counts(f.formalKey)).toEqual(beforeCounts);expect(f.calls).toBe(1);
});

it('restores the complete adopted outline from another pool after actual COMMIT ACK loss and retries with current authorization',async()=>{
  const f=await fixture();let lose=true;
  const guarded=new PostgresVersionStore(observedPool(async()=>{},()=>{if(lose){lose=false;throw new Error('Synthetic committed formal adoption acknowledgement lost');}}));
  const guard=vi.fn(createOutlineSourceGuard(f.store,f.source));
  await expect(guarded.adoptGuarded(f.formalKey,f.request.id,f.approval,guard)).rejects.toMatchObject({code:'DATABASE_ERROR'});
  const replacement=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000});
  try{
    const restoredStore=new PostgresVersionStore(replacement),restored=(await restoredStore.read(f.formalKey))!;
    expect(restored.state.changes[0]!.request).toEqual(f.request);expect(restored.state.changes[0]!.status).toBe('adopted');expect(restored.state.adoptions).toHaveLength(1);
    const head=restored.state.head;if(head.schema_version!=='0.7.0-draft')throw new Error('Expected persisted v07 outline head');
    const {projection,binding}=selectedOutlineProjection(head,f.identities);expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review.output);expect(validatePackage(head).valid).toBe(true);
    const beforeCounts=await counts(f.formalKey);await changeSource(f,'development');
    const staleGuard=vi.fn(createOutlineSourceGuard(new PostgresOutlineStore(replacement),f.source)),authorize=vi.fn(()=>true);
    const recovered=await restoredStore.adoptGuarded(f.formalKey,f.request.id,{...f.approval,authorize},staleGuard);
    expect(recovered.state).toEqual(restored.state);expect(recovered.writeVersion).toBe(restored.writeVersion);expect(authorize).toHaveBeenCalledWith(f.approval.actor,f.formalKey,f.approval.scope);
    expect(guard).toHaveBeenCalledOnce();expect(staleGuard).not.toHaveBeenCalled();
    const denied=await restoredStore.adoptGuarded(f.formalKey,f.request.id,{...f.approval,authorize:()=>false},staleGuard);
    expect(denied.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(await restoredStore.read(f.formalKey)).toEqual(restored);expect(await counts(f.formalKey)).toEqual(beforeCounts);expect(f.calls).toBe(1);
  }finally{await replacement.end();}
});

import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient,QueryConfig} from 'pg';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {AccessService,issueSession} from '@camery/access';
import {migrateAccess,PostgresSessionStore} from '@camery/access/node';
import {upgradeV05Package,upgradeV06Package} from '@camery/ir';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {migrateDevelopment,PostgresDevelopmentIrIdentities,prepareDevelopmentDraft,finalizeDevelopmentChangeSet,createDevelopmentSourceGuard} from '@camery/script/node';
import {identityPgFixture} from '../../script/test/ir-identities-pg-support.js';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {PostgresProjectIdentityStore,ProjectIdentityRegistrar} from '../src/projects/identity-map.js';
import {resolveProjectAuthority} from '../src/projects/authority.js';
import {PostgresProjectIntents,projectIntentDigest} from '../src/projects/intent-store.js';
import type {CandidateIntentBody,DecisionIntentBody} from '../src/projects/intent-contracts.js';
import {ProjectApplication} from '../src/projects/application.js';
import {PostgresProjectReadStore} from '../src/projects/read-store.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for immutable candidate intents integration');
const pool=new Pool({connectionString:databaseUrl,max:12,connectionTimeoutMillis:5000});const owned:string[]=[];
const extraVersionTenants:string[]=[];
const versions=new PostgresVersionStore(pool);const intents=new PostgresProjectIntents(pool);
const allocation=()=>id(randomUUID());
beforeAll(async()=>{await migrateAccess(pool);await migrateVersioning(pool);await migrateDevelopment(pool);await migrateProjectIdentities(pool);});
afterAll(async()=>{
  let failed=false;
  for(const tenantId of owned){
    for(const table of ['decision_receipts','decision_intents','candidate_receipts','candidate_intents','principals','projects','tenants'])try{await pool.query(`DELETE FROM camery_projects.${table} WHERE tenant_id=$1`,[tenantId]);}catch{failed=true;}
    for(const table of ['ir_identities','run_origins','reviews','candidates','runs','briefs'])try{await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenantId]);}catch{failed=true;}
    for(const table of ['sessions','memberships','users'])try{await pool.query(`DELETE FROM camery_access.${table} WHERE tenant_id=$1`,[tenantId]);}catch{failed=true;}
  }
  for(const tenantId of [...owned.map(id),...extraVersionTenants]){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1`,[tenantId]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}
  await pool.end();if(failed)throw new Error('Immutable candidate intent fixture cleanup failed');
});
async function fixture(v07=false){
  // Protocol source/audits are explicit synthetic fixtures; all below storage and formal mutations use actual PostgreSQL.
  const f=await identityPgFixture(pool,owned);const old=upgradeV05Package(makePackage()),baseline=v07?upgradeV06Package(old):old;for(const [name,value] of Object.entries(baseline))if(Array.isArray(value))(baseline as unknown as Record<string,unknown>)[name]=[];
  baseline.project.id=f.target.projectId;baseline.project.source_ids=[];baseline.project.rights_status='unknown';baseline.project.scope={label:'明确准备的开发基线',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};baseline.revision={number:1,status:'adopted',note:'Explicit synthetic fixture installation'};await versions.initialize(f.target,baseline);
  const register=new ProjectIdentityRegistrar(pool);await register.registerTenant({tenantId:f.scope.tenantId,irTenantId:f.target.tenantId});await register.registerProject({...f.scope,irProjectId:f.target.projectId});
  for(const key of ['editor','reviewer','source-reviewer'])await register.registerPrincipal({tenantId:f.scope.tenantId,kind:'user',key,irActorId:id(f.scope.tenantId+key)});
  const sessions=new PostgresSessionStore(pool);const access=new AccessService({tenantId:f.scope.tenantId,store:sessions});const tokens={editor:'',reviewer:''};for(const role of ['editor','reviewer'] as const){await sessions.provisionMember({...f.scope,userId:role,role});tokens[role]='Bearer '+(await issueSession({tenantId:f.scope.tenantId,userId:role,ttlSeconds:3600},sessions)).token;}
  const identities=new PostgresProjectIdentityStore(pool);const authority=async(role:'editor'|'reviewer')=>resolveProjectAuthority({identities,subject:await access.authenticate(tokens[role]),projectId:f.scope.projectId,permission:role==='editor'?'candidate:write':'candidate:review'});
  const prepared=await new PostgresDevelopmentIrIdentities(pool,f.store,allocation).prepare({source:f.source,target:f.target});const originalReviewer=id(f.scope.tenantId+'source-reviewer');const reviewers={foundation:{key:'source-reviewer',id:originalReviewer},episodes:{key:'source-reviewer',id:originalReviewer}};
  const head=(await versions.read(f.target))!.state.head;const draft=prepareDevelopmentDraft({...prepared,source:f.source,reviewers,head});const author=await authority('editor');const changeId=allocation();const request=finalizeDevelopmentChangeSet({draft,changeSetId:changeId,author:author.principal as {kind:'user';id:string},operationIds:draft.operations.map(op=>({slot:op.slot,id:allocation()}))});
  const proposed:CandidateIntentBody={version:1,scope:f.scope,applicationId:'application',actor:{...author.principal,key:'editor'},target:f.target,commandDigest:projectIntentDigest({source:f.source,expectation:{expectedSnapshotRevision:1,expectedWriteVersion:1}}),source:{kind:'development',mapperVersion:1,source:f.source,identities:prepared.identities,reviewers},expectation:{expectedSnapshotRevision:1,expectedWriteVersion:1},changeId,request};
  const candidate=await intents.putCandidate(proposed);
  const submit=()=>versions.submitWithReceipt(f.target,candidate.request,{expectation:candidate.expectation},intents.preparationReceiptWriter(candidate));
  async function decision(action:'adopt'|'reject'='adopt',requestId='decision'){
    const actor=await authority('reviewer');const body:DecisionIntentBody={version:1,scope:f.scope,requestId,actor:{...actor.principal,key:'reviewer'},changeId:candidate.changeId,action,adoptionScope:{kind:'project',id:f.target.projectId},expectation:{expectedSnapshotRevision:1,expectedWriteVersion:2},reason:action==='reject'?'明确拒绝本次开发候选':null,at:'2026-11-17T06:00:00.000Z'};
    const intent=await intents.putDecision(body);return {intent,options:{actor:actor.principal,scope:intent.adoptionScope,at:intent.at,authorize:actor.authorize,expectation:intent.expectation},receipt:intents.decisionReceiptWriter(intent,candidate),key:{scope:f.scope,actorKind:'user' as const,actorKey:'reviewer',requestId}};
  }
  return {...f,prepared,reviewers,candidate,proposed,submit,decision,authority,sessions};
}
async function counts(f:Awaited<ReturnType<typeof fixture>>){return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{count:string}>(`SELECT count(*)::text count FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[f.target.tenantId,f.target.projectId])).rows[0]!.count)));}
function observedPool(observe:(client:PoolClient,text:string)=>Promise<void>,afterCommit?:()=>void):Pool{return new Proxy(pool,{get(target,property){if(property==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(connection,field){if(field==='query')return async(input:string|QueryConfig,values?:unknown[])=>{const text=typeof input==='string'?input:input.text;const result=await connection.query(input,values);await observe(connection,text);if(text.trim().toUpperCase()==='COMMIT')afterCommit?.();return result;};const value:unknown=Reflect.get(connection,field);return typeof value==='function'?value.bind(connection):value;}});};const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});}
function applicationFor(f:Awaited<ReturnType<typeof fixture>>,database=pool,versionDatabase=database){return new ProjectApplication({tenantId:f.scope.tenantId,identities:new PostgresProjectIdentityStore(database),versions:new PostgresVersionStore(versionDatabase),reads:new PostgresProjectReadStore(database),intents:new PostgresProjectIntents(database),development:{store:f.store,identities:new PostgresDevelopmentIrIdentities(database,f.store,allocation)},newId:allocation,now:()=> '2026-11-20T07:00:00.000Z'});}
async function applicationSubject(f:Awaited<ReturnType<typeof fixture>>,userId:'editor'|'reviewer'){
  const token=(await issueSession({tenantId:f.scope.tenantId,userId,ttlSeconds:3600},f.sessions)).token;
  return new AccessService({tenantId:f.scope.tenantId,store:f.sessions}).authenticate('Bearer '+token);
}
it('recovers a partial candidate after actual COMMIT ACK loss and new pool, adopting only selected content through the shared host',async()=>{
  const f=await fixture(),application=applicationFor(f),editor=await applicationSubject(f,'editor'),reviewer=await applicationSubject(f,'reviewer'),actor=await f.authority('editor');
  const firstProp=allocation(),secondProp=allocation(),change=changeSet([firstProp,secondProp].map((prop,index)=>({op:'add' as const,op_id:allocation(),collection:'props' as const,value:{id:prop,version:1,name:'方案'+index,description:'独立候选内容'}})),{schema_version:'0.6.0-draft',id:allocation(),author:actor.principal,base_revision:1,base_revisions:[]});
  const original=await application.submitCandidate({subject:editor,projectId:f.scope.projectId,command:{applicationId:'manual-original',change,expectedSnapshotRevision:1,expectedWriteVersion:1}});expect(original.status).toBe('candidate');
  const selection={applicationId:'selected-original',changeId:allocation(),operationIds:[change.ops[0]!.op_id],expectedSnapshotRevision:1,expectedWriteVersion:2},input={subject:editor,projectId:f.scope.projectId,candidateId:change.id,command:selection};
  const before=await counts(f);expect((await application.previewSelection(input)).status).toBe('candidate');expect(await counts(f)).toEqual(before);
  // The host reads through separate read-only transactions before submitting; inject only after this receipt is written.
  let receiptWritten=false,lost=false;const lossy=applicationFor(f,pool,observedPool(async(_client,text)=>{if(text.startsWith('INSERT INTO camery_projects.candidate_receipts'))receiptWritten=true;},()=>{if(receiptWritten&&!lost){lost=true;throw new Error('Injected selection COMMIT ACK loss');}}));
  await expect(lossy.prepareSelection(input)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(lost).toBe(true);
  const committed=await intents.findCandidate({scope:f.scope,applicationId:selection.applicationId});expect(committed?.changeId).toBe(selection.changeId);
  expect((await versions.read(f.target))!.state.changes.find(row=>row.request.id===selection.changeId)?.status).toBe('candidate');
  expect((await intents.readPreparationReceipt({scope:f.scope,applicationId:selection.applicationId}))?.status).toBe('candidate');
  const reopened=new Pool({connectionString:databaseUrl,max:2});try{
    const committedCounts=await counts(f),host=applicationFor(f,reopened),partial=await host.prepareSelection(input);expect(await counts(f)).toEqual(committedCounts);expect(partial.derivation).toMatchObject({sourceChangeId:change.id,operationIds:selection.operationIds});expect(partial.differences.map(row=>row.id)).toEqual([firstProp]);
    const comparison=await host.compareCandidates({subject:reviewer,projectId:f.scope.projectId,command:{left:{kind:'candidate',candidateId:change.id},right:{kind:'candidate',candidateId:partial.candidateId},expectedSnapshotRevision:1,expectedWriteVersion:3}});expect(comparison.differences.map(row=>row.id)).toEqual([secondProp]);
    const decision={subject:reviewer,projectId:f.scope.projectId,candidateId:partial.candidateId,requestId:'adopt-selection',command:{scope:partial.scope,expectedSnapshotRevision:1,expectedWriteVersion:3}};
    const receipt=await host.adoptCandidate(decision);expect(receipt.status).toBe('adopted');const state=(await versions.read(f.target))!;expect(state.state.head.props.map(row=>row.id)).toEqual([firstProp]);expect(state.state.changes.find(row=>row.request.id===change.id)!.status).toBe('candidate');
    const stable=await counts(f);expect(await host.adoptCandidate(decision)).toEqual(receipt);expect(await counts(f)).toEqual(stable);expect((await host.prepareSelection(input)).preparation).toEqual(partial.preparation);
    await f.sessions.provisionMember({...f.scope,userId:'reviewer',role:'viewer'});await expect(host.adoptCandidate({...decision,subject:await applicationSubject(f,'reviewer')})).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.calls()).toBe(2);
  }finally{await reopened.end();}
});
it('inherits real development source authority for selected operations and refuses stale source adoption atomically',async()=>{
  const f=await fixture();await f.submit();const host=applicationFor(f),editor=await applicationSubject(f,'editor'),reviewer=await applicationSubject(f,'reviewer');
  const command={applicationId:'development-selection',changeId:allocation(),operationIds:f.candidate.request!.ops.map(op=>op.op_id),expectedSnapshotRevision:1,expectedWriteVersion:2};
  const partial=await host.prepareSelection({subject:editor,projectId:f.scope.projectId,candidateId:f.candidate.changeId,command});expect(partial.status).toBe('candidate');expect(partial.source).toMatchObject({kind:'development',state:'current'});
  const saved=await intents.findCandidate({scope:f.scope,applicationId:command.applicationId});expect(saved?.source).toEqual(f.candidate.source);expect(saved?.derivation?.requestDigest).toBe(projectIntentDigest(f.candidate.request));
  await f.store.putBrief({...f.put,expectedRevision:1,idea:'已经变更的真实来源'});const before=await counts(f);
  const decision={subject:reviewer,projectId:f.scope.projectId,candidateId:partial.candidateId,requestId:'stale-partial',command:{scope:partial.scope,expectedSnapshotRevision:1,expectedWriteVersion:3}};
  await expect(host.adoptCandidate(decision)).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});expect(await counts(f)).toEqual(before);expect(await intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId:decision.requestId})).toBeNull();
  expect((await host.prepareSelection({subject:editor,projectId:f.scope.projectId,candidateId:f.candidate.changeId,command})).source).toMatchObject({state:'stale'});
  await expect(host.prepareSelection({subject:editor,projectId:f.scope.projectId,candidateId:f.candidate.changeId,command:{...command,applicationId:'new-stale-selection',changeId:allocation(),expectedWriteVersion:3}})).rejects.toMatchObject({code:'CONFLICT'});
  expect((await host.rejectCandidate({...decision,requestId:'reject-stale-partial',command:{...decision.command,reason:'来源已变更，明确拒绝'}})).status).toBe('rejected');expect(f.calls()).toBe(2);
});
it.each([false,true])('adopts the complete reviewed development into typed IR with v07=%s and atomically persists actual preparation and adoption receipts',async v07=>{
  const f=await fixture(v07);expect((await f.submit()).status).toBe('candidate');const decision=await f.decision();const adopted=await versions.adoptGuarded(f.target,f.candidate.changeId,decision.options,createDevelopmentSourceGuard(f.store,f.source),decision.receipt);expect(adopted.status).toBe('adopted');
  const head=adopted.state.head;expect(head.schema_version).toBe(v07?'0.7.0-draft':'0.6.0-draft');if(head.schema_version==='0.5.0-draft')throw new Error('Expected complete development schema');expect(head.worlds).toHaveLength(1);expect(head.development_plans).toHaveLength(1);expect(head.episode_plans).toHaveLength(10);expect(head.episodes).toHaveLength(10);expect(head.scenes).toEqual([]);expect(head.shots).toEqual([]);expect(head.assets).toEqual([]);
  expect(head.development_plans[0]!.source.reviewer_id).toBe(f.reviewers.foundation.id);expect(head.development_plans[0]!.source.reviewer_id).not.toBe(decision.intent.actor.id);expect(head.episode_plans[0]!.source.review_digest).toBe(f.source.episodesReviewDigest);expect(head.characters[0]!.development?.desire).toBe(f.prepared.progress.foundation.review!.status==='reviewed'?f.prepared.progress.foundation.review!.output.characters[0]!.desire:undefined);
  expect((await intents.readPreparationReceipt({scope:f.scope,applicationId:'application'}))?.status).toBe('candidate');const receipt=await intents.readDecisionReceipt(decision.key);expect(receipt?.status).toBe('adopted');expect(receipt?.adoption).toEqual(adopted.state.adoptions[0]);expect(f.calls()).toBe(2);
});
it('keeps one first intent and all IDs under eight concurrent equivalent producers and rejects changed commands',async()=>{
  const f=await fixture();const producers=Array.from({length:8},()=>{const body=structuredClone(f.proposed);body.changeId=allocation();body.request!.id=body.changeId;body.request!.ops.forEach(op=>{op.op_id=allocation();});return intents.putCandidate(body);});const results=await Promise.all(producers);expect(results.every(result=>result.digest===f.candidate.digest)).toBe(true);
  await expect(intents.putCandidate({...f.proposed,commandDigest:'f'.repeat(64)})).rejects.toMatchObject({code:'CONFLICT'});expect((await pool.query<{count:string}>('SELECT count(*)::text count FROM camery_projects.candidate_intents WHERE tenant_id=$1',[f.scope.tenantId])).rows[0]!.count).toBe('1');
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{expect(await new PostgresProjectIntents(reopened).findCandidate({scope:f.scope,applicationId:'application'})).toEqual(f.candidate);}finally{await reopened.end();}
});
it('rolls back formal writes and the preparation receipt together while retaining the independently committed intent',async()=>{
  const f=await fixture();const before=await counts(f);await expect(versions.submitWithReceipt(f.target,f.candidate.request,{expectation:f.candidate.expectation},async(client,result,context)=>{await intents.preparationReceiptWriter(f.candidate)(client,result,context);throw new Error('Injected post-receipt failure');})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(await counts(f)).toEqual(before);expect(await intents.readPreparationReceipt({scope:f.scope,applicationId:'application'})).toBeNull();expect(await intents.findCandidate({scope:f.scope,applicationId:'application'})).toEqual(f.candidate);expect((await f.submit()).status).toBe('candidate');
});
it('recovers a real rejection receipt after COMMIT acknowledgement loss and refuses a newly revoked reviewer',async()=>{
  const f=await fixture();await f.submit();const decision=await f.decision('reject');let lost=false;const lossy=new PostgresVersionStore(observedPool(async()=>{},()=>{if(!lost){lost=true;throw new Error('Injected committed rejection ACK loss');}}));
  await expect(lossy.rejectWithReceipt(f.target,f.candidate.changeId,decision.options,decision.intent.reason!,decision.receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(lost).toBe(true);await f.authority('reviewer');const receipt=await intents.readDecisionReceipt(decision.key);expect(receipt?.rejection).toMatchObject({actor_id:decision.intent.actor.id,reason:decision.intent.reason,at:decision.intent.at});
  const old=decision.intent;const retry=await intents.putDecision({version:1,scope:old.scope,requestId:old.requestId,actor:old.actor,changeId:old.changeId,action:old.action,adoptionScope:old.adoptionScope,expectation:old.expectation,reason:old.reason,at:'2026-11-17T06:00:01.000Z'});expect(retry).toEqual(old);
  const before=await counts(f);await f.sessions.provisionMember({...f.scope,userId:'reviewer',role:'viewer'});await expect(f.authority('reviewer')).rejects.toMatchObject({code:'FORBIDDEN'});expect(await counts(f)).toEqual(before);
});
it('does not commit an adoption or receipt after source changes, but permits explicit rejection of the stale candidate',async()=>{
  const f=await fixture();await f.submit();await f.store.putBrief({...f.put,expectedRevision:1,idea:'已经修改的当前创意'});const decision=await f.decision();const before=await counts(f);await expect(versions.adoptGuarded(f.target,f.candidate.changeId,decision.options,createDevelopmentSourceGuard(f.store,f.source),decision.receipt)).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});expect(await counts(f)).toEqual(before);expect(await intents.readDecisionReceipt(decision.key)).toBeNull();
  const rejection=await f.decision('reject','stale-rejection');expect((await versions.rejectWithReceipt(f.target,f.candidate.changeId,rejection.options,rejection.intent.reason!,rejection.receipt)).status).toBe('rejected');expect((await intents.readDecisionReceipt(rejection.key))?.rejection?.reason).toBe(rejection.intent.reason);
});
it('rolls back both schemas after an actual backend terminates during the decision receipt, then retries the same immutable intent',async()=>{
  const f=await fixture();await f.submit();const decision=await f.decision();const before=await counts(f);let killed=false;const terminated=new PostgresVersionStore(observedPool(async(client,text)=>{if(text.startsWith('INSERT INTO camery_projects.decision_receipts')&&!killed){const pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;expect((await pool.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0]!.terminated).toBe(true);killed=true;await new Promise<void>(resolve=>{setImmediate(resolve);});}}));
  await expect(terminated.adoptGuarded(f.target,f.candidate.changeId,decision.options,createDevelopmentSourceGuard(f.store,f.source),decision.receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(killed).toBe(true);expect(await counts(f)).toEqual(before);expect(await intents.readDecisionReceipt(decision.key)).toBeNull();
  expect((await versions.adoptGuarded(f.target,f.candidate.changeId,decision.options,createDevelopmentSourceGuard(f.store,f.source),decision.receipt)).status).toBe('adopted');expect((await intents.readDecisionReceipt(decision.key))?.adoption?.change_set_id).toBe(f.candidate.changeId);
});
it('persists an unchanged intent and its original baseline receipt without an empty ChangeSet or another formal write',async()=>{
  const f=await fixture();await f.submit();const decision=await f.decision();await versions.adoptGuarded(f.target,f.candidate.changeId,decision.options,createDevelopmentSourceGuard(f.store,f.source),decision.receipt);const stored=(await versions.read(f.target))!;const draft=prepareDevelopmentDraft({...f.prepared,source:f.source,reviewers:f.reviewers,head:stored.state.head});expect(draft.operations).toEqual([]);const before=await counts(f);
  const noop=await intents.putCandidate({...f.proposed,applicationId:'unchanged',changeId:allocation(),commandDigest:'c'.repeat(64),request:null,expectation:{expectedSnapshotRevision:2,expectedWriteVersion:3}});expect((await intents.readPreparationReceipt({scope:f.scope,applicationId:'unchanged'}))?.status).toBe('unchanged');expect(await counts(f)).toEqual(before);
  const world=(stored.state.head as ReturnType<typeof upgradeV05Package>).worlds[0]!;const manual=changeSet([{op:'update',op_id:allocation(),collection:'worlds',target:world.id,set:{setting:'后来明确采用的世界改动'}}],{schema_version:'0.6.0-draft',id:allocation(),base_revision:2,base_revisions:[{id:world.id,version:world.version}],author:{kind:'user',id:decision.intent.actor.id}});await versions.submit(f.target,manual);await versions.adopt(f.target,manual.id,{...decision.options,expectation:{expectedSnapshotRevision:2,expectedWriteVersion:4}});
  expect(await intents.findCandidate({scope:f.scope,applicationId:'unchanged'})).toEqual(noop);expect((await intents.readPreparationReceipt({scope:f.scope,applicationId:'unchanged'}))?.snapshotRevision).toBe(2);expect((await versions.read(f.target))!.state.head.revision.number).toBe(3);
});
it('requires exact project and principal bindings in SQL and rejects stored authority-column disagreement with intact record digests',async()=>{
  const f=await fixture();await expect(intents.putCandidate({...f.proposed,applicationId:'forged-user',changeId:allocation(),actor:{...f.proposed.actor,key:'unregistered'},request:{...f.proposed.request!,id:allocation()}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const forged=structuredClone(f.proposed);forged.applicationId='unbound';forged.actor.key='unregistered';forged.changeId=allocation();forged.request!.id=forged.changeId;await expect(intents.putCandidate(forged)).rejects.toMatchObject({code:'CONFLICT'});
  await pool.query('UPDATE camery_projects.candidate_intents SET actor_key=$1,ir_actor_id=$2 WHERE tenant_id=$3 AND project_id=$4 AND application_id=$5',['reviewer',id(f.scope.tenantId+'reviewer'),f.scope.tenantId,f.scope.projectId,'application']);await expect(intents.findCandidate({scope:f.scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it.each(['action','actor','scope','reason','at'] as const)('rolls back both schemas when a trusted host miswires the frozen decision %s',async field=>{
  const f=await fixture();await f.submit();const decision=await f.decision('reject');const before=await versions.read(f.target);const beforeCounts=await counts(f);
  const options={...decision.options,authorize:()=>true};let reason=decision.intent.reason!;
  if(field==='actor')options.actor={kind:'user',id:allocation()};if(field==='scope')options.scope={kind:'episode',id:f.prepared.identities.episodes[0]!.episodeId};if(field==='at')options.at='2026-11-17T06:00:01.000Z';if(field==='reason')reason='与首次冻结意图不同的拒绝理由';
  const action=field==='action'?versions.adoptGuarded(f.target,f.candidate.changeId,options,createDevelopmentSourceGuard(f.store,f.source),decision.receipt):versions.rejectWithReceipt(f.target,f.candidate.changeId,options,reason,decision.receipt);
  await expect(action).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await versions.read(f.target)).toEqual(before);expect(await counts(f)).toEqual(beforeCounts);expect(await intents.readDecisionReceipt(decision.key)).toBeNull();
});
it('records a later authorized adopted acknowledgement with the original adoption evidence, not the later caller time',async()=>{
  const f=await fixture();await f.submit();const first=await f.decision();const adopted=await versions.adoptGuarded(f.target,f.candidate.changeId,first.options,createDevelopmentSourceGuard(f.store,f.source),first.receipt);const before=await counts(f);await f.store.putBrief({...f.put,expectedRevision:1,idea:'采用后新增的创意修订'});const authority=await f.authority('reviewer');
  const body:DecisionIntentBody={version:1,scope:f.scope,requestId:'later-ack',actor:{...authority.principal,key:'reviewer'},changeId:f.candidate.changeId,action:'adopt',adoptionScope:first.intent.adoptionScope,expectation:first.intent.expectation,reason:null,at:'2026-11-17T06:00:01.000Z'};const later=await intents.putDecision(body);let sourceCalls=0;
  await versions.adoptGuarded(f.target,f.candidate.changeId,{actor:authority.principal,scope:later.adoptionScope,at:later.at,authorize:authority.authorize,expectation:later.expectation},async()=>{sourceCalls++;throw new Error('Historical source must not be consulted');},intents.decisionReceiptWriter(later,f.candidate));
  const receipt=await intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId:'later-ack'});expect(receipt?.adoption).toEqual(adopted.state.adoptions[0]);expect(receipt?.adoption?.at).not.toBe(later.at);expect(sourceCalls).toBe(0);expect(await counts(f)).toEqual(before);
});
it('cannot persist an A-project receipt from the same project ULID executing in another version tenant',async()=>{
  const f=await fixture();const other={tenantId:allocation(),projectId:f.target.projectId};extraVersionTenants.push(other.tenantId);const baseline=(await versions.read(f.target))!.state.head;await versions.initialize(other,baseline);const before=await versions.read(other);
  await expect(versions.submitWithReceipt(other,f.candidate.request,{expectation:f.candidate.expectation},intents.preparationReceiptWriter(f.candidate))).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await versions.read(other)).toEqual(before);expect(await intents.readPreparationReceipt({scope:f.scope,applicationId:'application'})).toBeNull();
});
it('rejects a host that silently replaces the frozen decision CAS with a newer allowed write version',async()=>{
  const f=await fixture();await f.submit();const decision=await f.decision();const extra=changeSet([{op:'add',op_id:allocation(),collection:'props',value:{id:allocation(),version:1,name:'明确的并发候选',description:'只推进写版本'}}],{schema_version:'0.6.0-draft',id:allocation(),base_revision:1,base_revisions:[],author:{kind:'user',id:decision.intent.actor.id}});expect((await versions.submit(f.target,extra)).status).toBe('candidate');const before=await versions.read(f.target);
  await expect(versions.adoptGuarded(f.target,f.candidate.changeId,{...decision.options,expectation:{expectedSnapshotRevision:1,expectedWriteVersion:3}},createDevelopmentSourceGuard(f.store,f.source),decision.receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await versions.read(f.target)).toEqual(before);expect(await intents.readDecisionReceipt(decision.key)).toBeNull();
});
it('preserves a failed first decision and rolls back a later attempted success under the same intent',async()=>{
  const f=await fixture();await f.submit();const decision=await f.decision();const denied=await versions.adoptGuarded(f.target,f.candidate.changeId,{...decision.options,authorize:()=>false},createDevelopmentSourceGuard(f.store,f.source),decision.receipt);expect(denied.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');const first=await intents.readDecisionReceipt(decision.key);const before=await versions.read(f.target);
  await expect(versions.adoptGuarded(f.target,f.candidate.changeId,decision.options,createDevelopmentSourceGuard(f.store,f.source),decision.receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await versions.read(f.target)).toEqual(before);expect(await intents.readDecisionReceipt(decision.key)).toEqual(first);
  const fresh=await f.decision('adopt','fresh-approval');expect((await versions.adoptGuarded(f.target,f.candidate.changeId,fresh.options,createDevelopmentSourceGuard(f.store,f.source),fresh.receipt)).status).toBe('adopted');expect((await intents.readDecisionReceipt(fresh.key))?.status).toBe('adopted');expect(await intents.readDecisionReceipt(decision.key)).toEqual(first);
});

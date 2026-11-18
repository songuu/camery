import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateAccess} from '@camery/access/node';
import {migrateBible} from '@camery/bible/node';
import {migrateIngest} from '@camery/ingest/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import type {PersistedAdoptOptions} from '@camery/versioning/node';
import {migrateDevelopment} from '@camery/script/node';
import {createOutlineSourceGuard,migrateOutline,migrateOutlineIdentities} from '@camery/script/outline/node';
import {ChangeSetV07} from '@camery/ir';
import {WorkbenchActionReceiptSchema} from '@camery/ir/workbench';
import {readOutlineFormalProjection} from '../../script/src/outline/node/formal-projection.js';
import {selectedOutlineProjection} from '../../script/test/outline-formal-mapping-support.js';
import {changeSet,fixtureId} from '../../ir/test/fixtures.js';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {migrateOutlineProjectIntents} from '../src/projects/outline-intent-migrate.js';
import {PostgresOutlineProjectIntents} from '../src/projects/outline-intent-store.js';
import {APPLICATION_BYTES,CandidateIntentBodySchema} from '../src/projects/intent-contracts.js';
import {grantProjectAdoptionRole,verifyProjectAdoptionRole} from '../src/projects/adoption-role.js';
import {allocateOutlineIntentId as allocate,observeOutlinePool,outlineIntentPgFixture,outlineVersionCounts} from './outline-intent-pg-support.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for independent Outline intent integration');
const pool=new Pool({connectionString:databaseUrl,max:12,connectionTimeoutMillis:5000}),owned:string[]=[],extraTargets:{tenantId:string;projectId:string}[]=[];
let oldLedgers:{projects:unknown[];outline:unknown[];identities:unknown[]};
beforeAll(async()=>{
  await migrateAccess(pool);await migrateVersioning(pool);await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateOutlineIdentities(pool);await migrateProjectIdentities(pool);
  oldLedgers={projects:(await pool.query('SELECT version,checksum FROM camery_projects.migrations ORDER BY version')).rows,outline:(await pool.query('SELECT version,checksum FROM camery_outline.migrations ORDER BY version')).rows,identities:(await pool.query('SELECT version,checksum FROM camery_outline.identity_migrations ORDER BY version')).rows};
  await migrateOutlineProjectIntents(pool);await migrateOutlineProjectIntents(pool);
});
afterAll(async()=>{
  let failed=false;
  try{
    for(const tenant of owned){
      for(const [schema,tables] of [
        ['camery_projects',['outline_decision_receipts','outline_decision_intents','outline_candidate_receipts','outline_candidate_intents','principals','projects','tenants']],
        ['camery_outline',['identity_preparations']],['camery_script',['ir_identities']],
        ['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],
        ['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']],['camery_access',['sessions','memberships','users']],
      ] as const)for(const table of tables)try{await pool.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
    }
    const targets=[...extraTargets,...owned.map(tenant=>({tenantId:allocateTargetTenant(tenant),projectId:allocateTargetProject(tenant)}))];
    for(const target of targets){const client=await pool.connect();try{
      await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');
      for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[target.tenantId,target.projectId]);
      await client.query('COMMIT');
    }catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}
  }finally{await pool.end();}
  if(failed)throw new Error('Independent Outline intent fixture cleanup failed');
});

// Match only the explicit target convention in outlineIdentityPgFixture; never infer runtime project bindings.
const allocateTargetTenant=(tenant:string)=>fixtureId('formal-tenant-'+tenant);
const allocateTargetProject=(tenant:string)=>fixtureId('formal-project-'+tenant);
const fixture=(capacity=false)=>outlineIntentPgFixture(pool,owned,{capacity});
const counts=(f:Awaited<ReturnType<typeof fixture>>)=>outlineVersionCounts(pool,f.target);
const freshPool=()=>new Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:5000});
const lostAckPool=()=>{let lost=false;return observeOutlinePool(pool,async()=>{},()=>{if(!lost){lost=true;throw new Error('Injected actual COMMIT acknowledgement loss');}});};

it('installs its own ledger without rewriting prior project, Outline or identity migrations',async()=>{
  expect((await pool.query('SELECT version,checksum FROM camery_projects.migrations ORDER BY version')).rows).toEqual(oldLedgers.projects);
  expect((await pool.query('SELECT version,checksum FROM camery_outline.migrations ORDER BY version')).rows).toEqual(oldLedgers.outline);
  expect((await pool.query('SELECT version,checksum FROM camery_outline.identity_migrations ORDER BY version')).rows).toEqual(oldLedgers.identities);
  expect((await pool.query('SELECT version,checksum FROM camery_projects.outline_migrations ORDER BY version')).rows).toEqual([1,2].map(version=>expect.objectContaining({version,checksum:expect.stringMatching(/^[a-f0-9]{64}$/)})));
});

it('preserves the first generated IDs across eight concurrent producers and a new pool',async()=>{
  const f=await fixture();
  const proposals=Array.from({length:8},()=>({...f.proposed,applicationId:'concurrent-first',changeId:allocate(),operationIds:f.proposed.operationIds.map(row=>({...row,id:allocate()}))}));
  const results=await Promise.all(proposals.map(body=>f.intents.putCandidate(body))),first=results[0]!;
  expect(results.every(value=>JSON.stringify(value)===JSON.stringify(first))).toBe(true);
  expect(proposals.find(body=>body.changeId===first.changeId)?.operationIds).toEqual(first.operationIds);
  expect((await pool.query<{count:string}>('SELECT count(*)::text count FROM camery_projects.outline_candidate_intents WHERE tenant_id=$1 AND application_id=$2',[f.scope.tenantId,'concurrent-first'])).rows[0]!.count).toBe('1');
  await expect(f.intents.putCandidate({...proposals[0]!,commandDigest:'f'.repeat(64)})).rejects.toMatchObject({code:'CONFLICT'});
  const reopened=freshPool();try{
    const intents=new PostgresOutlineProjectIntents(reopened);
    expect(await intents.findCandidate({scope:f.scope,applicationId:'concurrent-first'})).toEqual(first);
    expect(await intents.candidateForChange({scope:f.scope,changeId:first.changeId})).toEqual(first);
  }finally{await reopened.end();}
  expect(f.calls()).toBe(1);
});

it('submits and adopts the complete original review and native audit with both atomic receipts',async()=>{
  const f=await fixture();expect((await f.submit()).status).toBe('candidate');const d=await f.decision();
  const result=await f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),d.receipt);
  expect(result.status).toBe('adopted');const head=result.state.head;
  if(head.schema_version!=='0.7.0-draft')throw new Error('Expected adopted Outline schema');
  const {projection,binding}=selectedOutlineProjection(head,f.prepared.identities);
  expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review!.output);
  expect(projection.plan.source).toMatchObject({run_id:f.source.runId,run_digest:f.source.runDigest,review_digest:f.source.reviewDigest,reviewer_key:'registry-editor',reviewer_id:f.reviewer.id});
  expect(projection.plan.source.reviewer_id).not.toBe(d.intent.actor.id);
  expect(head.scenes).toEqual([]);expect(head.shots).toEqual([]);expect(head.assets).toEqual([]);
  expect((await f.intents.readPreparationReceipt({scope:f.scope,applicationId:'application'}))?.status).toBe('candidate');
  expect((await f.intents.readDecisionReceipt(d.key))?.adoption).toEqual(result.state.adoptions[0]);
  expect(f.calls()).toBe(1);
});

it('reloads a 500KB reviewed source, 1350 persistent IDs and all 1249 formal operations after actual adoption',async()=>{
  const f=await fixture(true),oldCounts=await Promise.all(['candidate_intents','candidate_receipts','decision_intents','decision_receipts'].map(async table=>(await pool.query(`SELECT * FROM camery_projects.${table} WHERE tenant_id=$1`,[f.scope.tenantId])).rows));
  expect(Buffer.byteLength(JSON.stringify(f.candidate))).toBeGreaterThan(APPLICATION_BYTES);
  expect(Buffer.byteLength(JSON.stringify(f.review!.output))).toBeGreaterThanOrEqual(499900);
  expect(Buffer.byteLength(JSON.stringify(f.review!.output))).toBeLessThanOrEqual(524288);
  expect(f.candidate.request!.ops).toHaveLength(1249);
  expect((await pool.query<{count:string}>('SELECT count(*)::text count FROM camery_script.ir_identities WHERE tenant_id=$1',[f.scope.tenantId])).rows[0]!.count).toBe('1350');
  expect(CandidateIntentBodySchema.safeParse({version:1,scope:f.scope,applicationId:'legacy',actor:f.proposed.actor,target:f.target,commandDigest:f.proposed.commandDigest,source:{kind:'manual'},expectation:f.proposed.expectation,changeId:f.candidate.changeId,request:f.candidate.request}).success).toBe(false);
  const prepared=await f.submit();expect(prepared.status).toBe('candidate');const d=await f.decision();
  const adopted=await f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),d.receipt);expect(adopted.status).toBe('adopted');
  const reopened=freshPool();try{
    const intents=new PostgresOutlineProjectIntents(reopened),stored=await new PostgresVersionStore(reopened).read(f.target);
    expect(await intents.findCandidate({scope:f.scope,applicationId:'application'})).toEqual(f.candidate);
    expect(await intents.readPreparationReceipt({scope:f.scope,applicationId:'application'})).toEqual(await f.intents.readPreparationReceipt({scope:f.scope,applicationId:'application'}));
    expect((await intents.readDecisionReceipt(d.key))?.adoption).toEqual(adopted.state.adoptions[0]);
    expect(stored).toEqual({state:adopted.state,writeVersion:adopted.writeVersion});
    const head=stored!.state.head;if(head.schema_version!=='0.7.0-draft')throw new Error('Expected complete reloaded Outline schema');
    const {projection,binding}=selectedOutlineProjection(head,f.prepared.identities);
    expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review!.output);
    expect(projection.plan.source.review_digest).toBe(f.source.reviewDigest);
  }finally{await reopened.end();}
  expect(await Promise.all(['candidate_intents','candidate_receipts','decision_intents','decision_receipts'].map(async table=>(await pool.query(`SELECT * FROM camery_projects.${table} WHERE tenant_id=$1`,[f.scope.tenantId])).rows))).toEqual(oldCounts);
  expect(f.calls()).toBe(1);
});

it('persists more than 500 actual native dependency warnings without truncating either receipt',async()=>{
  const f=await fixture();await f.submit();const first=await f.decision();
  const initial=await f.versions.adoptGuarded(f.target,f.candidate.changeId,first.options,createOutlineSourceGuard(f.store,f.source),first.receipt);
  if(initial.state.head.schema_version!=='0.7.0-draft')throw new Error('Expected actual Outline graph');
  const historicalPlan=structuredClone(initial.state.head.adaptation_plans[0]!);
  const actor=await f.authority('reviewer');
  async function nativeCommit(ops:ChangeSetV07['ops']){
    const stored=(await f.versions.read(f.target))!;
    const targets=ops.flatMap(op=>'target' in op?[op.target]:[]);
    const rows=Object.values(stored.state.head).flatMap(value=>Array.isArray(value)?value:[]) as {id:string;version:number}[];
    const request=ChangeSetV07.parse({schema_version:'0.7.0-draft',id:allocate(),author:actor.principal,status:'candidate',base_revision:stored.state.head.revision.number,base_revisions:targets.map(id=>({id,version:rows.find(row=>row.id===id)!.version})),ops});
    const submitted=await f.versions.submit(f.target,request);expect(submitted.status).toBe('candidate');
    const adopted=await f.versions.adopt(f.target,request.id,{...first.options,expectation:{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:submitted.writeVersion}});expect(adopted.status).toBe('adopted');
  }
  await nativeCommit([{op:'update',op_id:allocate(),collection:'characters',target:f.prepared.identities.characters[0]!.id,set:{name:'Explicit independently adopted temporary edit'}}]);
  let stored=(await f.versions.read(f.target))!;
  const restore=await f.intents.putCandidate(f.bodyFor('restore-source',stored.state.head,{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:stored.writeVersion}));
  const submittedRestore=await f.submit(restore),restoreDecision=await f.decision('adopt','restore-source-decision',restore,{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:submittedRestore.writeVersion});
  expect((await f.versions.adoptGuarded(f.target,restore.changeId,restoreDecision.options,createOutlineSourceGuard(f.store,f.source),restoreDecision.receipt)).status).toBe('adopted');
  // Trusted importer fixture: old pins remain valid history after the original owned graph advances.
  // This creates genuine kernel warnings; no caller-authored receipt or fabricated result crosses the writer.
  await nativeCommit(Array.from({length:64},()=>({op:'add' as const,op_id:allocate(),collection:'adaptation_plans' as const,value:{...structuredClone(historicalPlan),id:allocate()}})));
  await nativeCommit([{op:'update',op_id:allocate(),collection:'characters',target:f.prepared.identities.characters[0]!.id,set:{name:'Explicit second independent edit'}}]);
  stored=(await f.versions.read(f.target))!;
  const body=f.bodyFor('complete-warning-evidence',stored.state.head,{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:stored.writeVersion});
  const candidate=await f.intents.putCandidate(body),prepared=await f.submit(candidate);
  expect(prepared.status).toBe('candidate');expect(prepared.warnings.length).toBeGreaterThan(500);
  expect(prepared.warnings.every(row=>row.code==='STALE_OUTLINE_DEPENDENCY')).toBe(true);
  expect((await f.intents.readPreparationReceipt({scope:f.scope,applicationId:body.applicationId}))?.warnings).toEqual(prepared.warnings);
  const decision=await f.decision('adopt','complete-warning-decision',candidate,{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:prepared.writeVersion});
  const adopted=await f.versions.adoptGuarded(f.target,candidate.changeId,decision.options,createOutlineSourceGuard(f.store,f.source),decision.receipt);expect(adopted.status).toBe('adopted');
  expect(adopted.warnings.length).toBeGreaterThan(500);
  const reopened=freshPool();try{
    const intents=new PostgresOutlineProjectIntents(reopened);
    expect((await intents.readPreparationReceipt({scope:f.scope,applicationId:body.applicationId}))?.warnings).toEqual(prepared.warnings);
    expect((await intents.readDecisionReceipt(decision.key))?.warnings).toEqual(adopted.warnings);
  }finally{await reopened.end();}
  expect(f.calls()).toBe(1);
});

it.each(['prepare','submit','adopt'] as const)('recovers actual committed %s acknowledgement loss through a fresh pool without duplicated writes',async phase=>{
  const f=await fixture();let candidate=f.candidate;
  if(phase==='prepare')await expect(new PostgresOutlineProjectIntents(lostAckPool()).putCandidate(f.bodyFor('lost-preparation'))).rejects.toMatchObject({code:'STORAGE_FAILED'});
  if(phase==='submit')await expect(f.submit(candidate,new PostgresVersionStore(lostAckPool()))).rejects.toMatchObject({code:'DATABASE_ERROR'});
  if(phase==='adopt')await f.submit();
  const d=phase==='adopt'?await f.decision():null;
  if(d)await expect(new PostgresVersionStore(lostAckPool()).adoptGuarded(f.target,candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),d.receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});
  const before=await counts(f),reopened=freshPool();try{
    const intents=new PostgresOutlineProjectIntents(reopened),versions=new PostgresVersionStore(reopened);
    if(phase==='prepare'){
      candidate=(await intents.findCandidate({scope:f.scope,applicationId:'lost-preparation'}))!;expect(candidate).not.toBeNull();
      const retried=await intents.putCandidate({...f.bodyFor('lost-preparation'),changeId:allocate()});expect(retried).toEqual(candidate);
    }else if(phase==='submit'){
      expect((await intents.readPreparationReceipt({scope:f.scope,applicationId:'application'}))?.status).toBe('candidate');
      expect((await versions.submitWithReceipt(f.target,candidate.request!,{expectation:candidate.expectation},intents.preparationReceiptWriter(candidate))).status).toBe('candidate');
    }else if(d){
      expect((await intents.readDecisionReceipt(d.key))?.status).toBe('adopted');
      const retry=await intents.putDecision({...d.body,at:'2026-11-18T06:00:01.000Z'});expect(retry).toEqual(d.intent);
      let sourceCalls=0;
      expect((await versions.adoptGuarded(f.target,candidate.changeId,d.options,async()=>{sourceCalls++;throw new Error('Historical adopted source guard should not run');},intents.decisionReceiptWriter(retry,candidate))).status).toBe('adopted');
      expect(sourceCalls).toBe(0);await f.sessions.provisionMember({...f.scope,userId:'reviewer',role:'viewer'});
      await expect(f.authority('reviewer')).rejects.toMatchObject({code:'FORBIDDEN'});
    }
    expect(await counts(f)).toEqual(before);
  }finally{await reopened.end();}
});

it('rolls native writes and both receipt schemas back on the same backend transaction when receipt persistence fails',async()=>{
  const f=await fixture(),before=await f.versions.read(f.target),beforeCounts=await counts(f);const observations:{pid:number;txid:string}[]=[];
  const observed=new PostgresVersionStore(observeOutlinePool(pool,async(client,text)=>{
    if(text.includes('INSERT INTO camery_projects.outline_candidate_receipts'))observations.push((await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!);
  }));
  let callback:{pid:number;txid:string}|undefined;
  await expect(observed.submitWithReceipt(f.target,f.candidate.request!,{expectation:f.candidate.expectation},async(client,result,context)=>{
    callback=(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!;
    await f.intents.preparationReceiptWriter(f.candidate)(client,result,context);throw new Error('Injected after genuine preparation receipt insert');
  })).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(observations).toEqual([callback]);expect(await f.versions.read(f.target)).toEqual(before);expect(await counts(f)).toEqual(beforeCounts);
  expect(await f.intents.readPreparationReceipt({scope:f.scope,applicationId:'application'})).toBeNull();
  await f.submit();const d=await f.decision(),submitted=await f.versions.read(f.target);
  await expect(f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),async(client,result,context)=>{
    await d.receipt(client,result,context);throw new Error('Injected after genuine adoption receipt insert');
  })).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(await f.versions.read(f.target)).toEqual(submitted);expect(await f.intents.readDecisionReceipt(d.key)).toBeNull();
  expect((await f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),d.receipt)).status).toBe('adopted');
});

it('writes exact unchanged CAS and stale CAS receipts without another formal operation, and rolls an intent back if its receipt fails',async()=>{
  const f=await fixture();await f.submit();const d=await f.decision();await f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),d.receipt);
  const stored=(await f.versions.read(f.target))!,before=await counts(f),body=f.bodyFor('unchanged',stored.state.head,{expectedSnapshotRevision:2,expectedWriteVersion:3});expect(body.draft.operations).toEqual([]);
  const unchanged=await f.intents.putCandidate(body);expect(unchanged.request).toBeNull();
  expect(await f.intents.readPreparationReceipt({scope:f.scope,applicationId:'unchanged'})).toMatchObject({status:'unchanged',snapshotRevision:2,writeVersion:3});
  const stale=await f.intents.putCandidate(f.bodyFor('stale',stored.state.head,{expectedSnapshotRevision:2,expectedWriteVersion:2}));expect(stale.request).toBeNull();
  expect(await f.intents.readPreparationReceipt({scope:f.scope,applicationId:'stale'})).toMatchObject({status:'conflicted',snapshotRevision:2,writeVersion:3});
  const failing=new PostgresOutlineProjectIntents(observeOutlinePool(pool,async(_client,text)=>{if(text.includes('INSERT INTO camery_projects.outline_candidate_receipts'))throw new Error('Injected NoChange receipt insertion failure');}));
  await expect(failing.putCandidate({...body,applicationId:'rollback-noop',changeId:allocate()})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(await f.intents.findCandidate({scope:f.scope,applicationId:'rollback-noop'})).toBeNull();expect(await counts(f)).toEqual(before);
  await pool.query('DELETE FROM camery_projects.outline_candidate_receipts WHERE tenant_id=$1 AND project_id=$2 AND application_id=$3',[f.scope.tenantId,f.scope.projectId,'unchanged']);
  await expect(f.intents.putCandidate(body)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(await f.intents.readPreparationReceipt({scope:f.scope,applicationId:'unchanged'})).toBeNull();
});

it('keeps first decision time and complete explicit rejection evidence and permits rejection after source changes',async()=>{
  const f=await fixture();await f.submit();const d=await f.decision('reject');
  expect(await f.intents.putDecision({...d.body,at:'2026-11-18T06:00:01.000Z'})).toEqual(d.intent);
  await f.store.putBrief({...f.put,expectedRevision:1,notes:'已经修改的当前大纲简报'});
  const result=await f.versions.rejectWithReceipt(f.target,f.candidate.changeId,d.options,d.intent.reason!,d.receipt);expect(result.status).toBe('rejected');
  expect((await f.intents.readDecisionReceipt(d.key))?.rejection).toMatchObject({actor_id:d.intent.actor.id,reason:d.intent.reason,at:d.intent.at});
});

it('does not cache source refusal or a database guard error as a completed decision',async()=>{
  const f=await fixture();await f.submit();const d=await f.decision(),before=await f.versions.read(f.target);
  await expect(f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,async()=>{throw new Error('Injected hard source database fault');},d.receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(await f.intents.readDecisionReceipt(d.key)).toBeNull();expect(await f.versions.read(f.target)).toEqual(before);
  await f.store.putBrief({...f.put,expectedRevision:1,notes:'采用前已修改来源'});
  await expect(f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),d.receipt)).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});
  expect(await f.intents.readDecisionReceipt(d.key)).toBeNull();expect(await f.versions.read(f.target)).toEqual(before);
});

it('enforces project, actor and source-preparation foreign keys in actual SQL',async()=>{
  const f=await fixture();
  const columns='tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,run_id,run_digest,review_digest,record,digest,business_digest';
  for(const field of ['project','actor','source'] as const){
    const project=field==='project'?"'unregistered-project'":'project_id',actor=field==='actor'?"'unregistered-actor'":'actor_key',runDigest=field==='source'?"repeat('f',64)":'run_digest';
    const path=field==='project'?'{scope,projectId}':field==='actor'?'{actor,key}':'{source,source,runDigest}',replacement=field==='project'?project:field==='actor'?actor:runDigest;
    const record=`jsonb_set(jsonb_set(jsonb_set(record,'{applicationId}',to_jsonb($2::text)),'{changeId}',to_jsonb($3::text)),'${path}',to_jsonb((${replacement})::text))`;
    await expect(pool.query(`INSERT INTO camery_projects.outline_candidate_intents(${columns}) SELECT tenant_id,${project},$2,actor_kind,${actor},ir_actor_id,ir_tenant_id,ir_project_id,$3,run_id,${runDigest},review_digest,${record},digest,business_digest FROM camery_projects.outline_candidate_intents WHERE tenant_id=$1 AND application_id='application'`,[f.scope.tenantId,'unbound-'+field,allocate()])).rejects.toMatchObject({code:'23503'});
  }
  await expect(pool.query('DELETE FROM camery_outline.identity_preparations WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',[f.scope.tenantId,f.scope.projectId,f.source.runId])).rejects.toMatchObject({code:'23503'});
  expect((await pool.query<{count:string}>('SELECT count(*)::text count FROM camery_projects.outline_candidate_intents WHERE tenant_id=$1',[f.scope.tenantId])).rows[0]!.count).toBe('1');
});

it('blocks mismatched authority columns in SQL and rejects changed stored authority with intact old digests',async()=>{
  const f=await fixture();
  const parameters=['reviewer',fixtureId(f.scope.tenantId+'reviewer'),f.scope.tenantId,f.scope.projectId,'application'];
  await expect(pool.query('UPDATE camery_projects.outline_candidate_intents SET actor_key=$1,ir_actor_id=$2 WHERE tenant_id=$3 AND project_id=$4 AND application_id=$5',parameters)).rejects.toMatchObject({code:'23514'});
  expect(await f.intents.findCandidate({scope:f.scope,applicationId:'application'})).toEqual(f.candidate);
  await pool.query("UPDATE camery_projects.outline_candidate_intents SET actor_key=$1,ir_actor_id=$2,record=jsonb_set(jsonb_set(record,'{actor,key}',to_jsonb($1::text)),'{actor,id}',to_jsonb($2::text)) WHERE tenant_id=$3 AND project_id=$4 AND application_id=$5",parameters);
  await expect(f.intents.findCandidate({scope:f.scope,applicationId:'application'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

it.each(['action','actor','scope','reason','at','expectation'] as const)('rolls back both schemas for a miswired frozen decision %s',async field=>{
  const f=await fixture();await f.submit();const d=await f.decision('reject');
  if(field==='expectation')expect((await f.versions.submit(f.target,changeSet([{op:'add',op_id:allocate(),collection:'props',value:{id:allocate(),version:1,name:'明确的并发候选',description:'只推进实际写版本'}}],{schema_version:'0.7.0-draft',id:allocate(),base_revision:1,base_revisions:[],author:{kind:d.intent.actor.kind,id:d.intent.actor.id}}))).status).toBe('candidate');
  const before=await f.versions.read(f.target),beforeCounts=await counts(f);
  const options:PersistedAdoptOptions={...d.options,authorize:()=>true};let reason=d.intent.reason!;
  if(field==='actor')options.actor={kind:'user',id:allocate()};
  if(field==='scope')options.scope={kind:'episode',id:f.prepared.identities.episodes[0]!.episodeId};
  if(field==='at')options.at='2026-11-18T06:00:01.000Z';
  if(field==='reason')reason='不同的后来拒绝理由';
  if(field==='expectation')options.expectation={expectedSnapshotRevision:1,expectedWriteVersion:3};
  const action=field==='action'?f.versions.adoptGuarded(f.target,f.candidate.changeId,options,createOutlineSourceGuard(f.store,f.source),d.receipt):f.versions.rejectWithReceipt(f.target,f.candidate.changeId,options,reason,d.receipt);
  await expect(action).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(await f.versions.read(f.target)).toEqual(before);expect(await counts(f)).toEqual(beforeCounts);expect(await f.intents.readDecisionReceipt(d.key)).toBeNull();
});

it('binds preparation receipts to the version tenant even when project IDs are identical',async()=>{
  const f=await fixture(),other={tenantId:allocate(),projectId:f.target.projectId};extraTargets.push(other);
  await f.versions.initialize(other,f.baseline);const before=await f.versions.read(other);
  await expect(f.versions.submitWithReceipt(other,f.candidate.request!,{expectation:f.candidate.expectation},f.intents.preparationReceiptWriter(f.candidate))).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(await f.versions.read(other)).toEqual(before);expect(await f.intents.readPreparationReceipt({scope:f.scope,applicationId:'application'})).toBeNull();
});

it('preserves the first refused decision and rolls back a later attempted success under the same request',async()=>{
  const f=await fixture();await f.submit();const d=await f.decision();
  const refused=await f.versions.adoptGuarded(f.target,f.candidate.changeId,{...d.options,authorize:()=>false},createOutlineSourceGuard(f.store,f.source),d.receipt);
  expect(refused.issues.map(row=>row.code)).toContain('ADOPTION_AUTHORITY');const receipt=await f.intents.readDecisionReceipt(d.key),before=await f.versions.read(f.target);
  await expect(f.versions.adoptGuarded(f.target,f.candidate.changeId,d.options,createOutlineSourceGuard(f.store,f.source),d.receipt)).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(await f.versions.read(f.target)).toEqual(before);expect(await f.intents.readDecisionReceipt(d.key)).toEqual(receipt);
  const fresh=await f.decision('adopt','fresh-authorized');expect((await f.versions.adoptGuarded(f.target,f.candidate.changeId,fresh.options,createOutlineSourceGuard(f.store,f.source),fresh.receipt)).status).toBe('adopted');
});

it('keeps the original adopted audit when a later allowed acknowledgement uses a different time',async()=>{
  const f=await fixture();await f.submit();const first=await f.decision(),result=await f.versions.adoptGuarded(f.target,f.candidate.changeId,first.options,createOutlineSourceGuard(f.store,f.source),first.receipt),before=await counts(f);
  await f.store.putBrief({...f.put,expectedRevision:1,notes:'采用后独立修订'});
  const later=await f.decision('adopt','later-ack',f.candidate,first.intent.expectation,'2026-11-18T06:00:01.000Z');
  await f.versions.adoptGuarded(f.target,f.candidate.changeId,later.options,async()=>{throw new Error('Historical source guard should not run');},later.receipt);
  const receipt=await f.intents.readDecisionReceipt(later.key);expect(receipt?.adoption).toEqual(result.state.adoptions[0]);expect(receipt?.adoption?.at).not.toBe(later.intent.at);expect(await counts(f)).toEqual(before);
});

it('keeps old public receipt and intent budgets and gives an old adopter LOGIN no new table privilege',async()=>{
  expect(APPLICATION_BYTES).toBe(1048576);
  const issue={code:'TEST_WARNING',where:'/',message:'Explicit budget fixture'};
  expect(WorkbenchActionReceiptSchema.shape.issues.safeParse([issue]).success).toBe(true);
  expect(WorkbenchActionReceiptSchema.shape.issues.safeParse(Array.from({length:501},()=>issue)).success).toBe(false);
  const name='outline_legacy_'+randomBytes(10).toString('hex'),password=randomBytes(24).toString('hex');let roleCreated=false;let runtime:Pool|undefined;
  try{
    await pool.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);roleCreated=true;
    await grantProjectAdoptionRole(pool,name);const url=new URL(databaseUrl!);url.username=name;url.password=password;runtime=new Pool({connectionString:url.toString(),max:1,connectionTimeoutMillis:5000});
    await verifyProjectAdoptionRole(runtime);
    for(const table of ['outline_candidate_intents','outline_candidate_receipts','outline_decision_intents','outline_decision_receipts']){
      expect((await runtime.query<{allowed:boolean}>('SELECT has_table_privilege($1,$2) allowed',['camery_projects.'+table,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'])).rows[0]!.allowed).toBe(false);
      await expect(runtime.query(`SELECT * FROM camery_projects.${table} LIMIT 1`)).rejects.toMatchObject({code:'42501'});
    }
  }finally{await runtime?.end();if(roleCreated){await pool.query(`DROP OWNED BY "${name}"`);await pool.query(`DROP ROLE "${name}"`);}}
});

import {createHash,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateAccess} from '@camery/access/node';
import {migrateBible} from '@camery/bible/node';
import {migrateIngest} from '@camery/ingest/node';
import {migrateDevelopment} from '@camery/script/node';
import {migrateOutline,migrateOutlineIdentities} from '@camery/script/outline/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {ChangeSetV07} from '@camery/ir';
import {OutlineCandidateSchema,OutlineCandidatePageSchema,OutlineReceiptSchema,OutlineReceiptPageSchema} from '@camery/ir/outline-adoption';
import type {OutlineCandidate,OutlineReceiptPage} from '@camery/ir/outline-adoption';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {migrateOutlineProjectIntents} from '../src/projects/outline-intent-migrate.js';
import {grantProjectAdoptionRole,verifyProjectAdoptionRole} from '../src/projects/adoption-role.js';
import {createApplication} from '../src/app.js';
import {fixtureId} from '../../ir/test/fixtures.js';
import {readOutlineFormalProjection} from '../../script/src/outline/node/formal-projection.js';
import {selectedOutlineProjection} from '../../script/test/outline-formal-mapping-support.js';
import {allocateOutlineIntentId as allocate,observeOutlinePool,outlineVersionCounts} from './outline-intent-pg-support.js';
import {outlineAdoptionPgFixture,withOutlineAdoptionRole,verifyOutlineProjectAdoptionRole} from './outline-adoption-pg-support.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];
if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for authenticated Outline adoption integration');
const pool=new Pool({connectionString:databaseUrl,max:12,connectionTimeoutMillis:5000}),owned:string[]=[];
beforeAll(async()=>{
  await migrateAccess(pool);await migrateVersioning(pool);await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateOutlineIdentities(pool);await migrateProjectIdentities(pool);await migrateOutlineProjectIntents(pool);
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
      const client=await pool.connect();try{
        await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');
        for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[fixtureId('formal-tenant-'+tenant),fixtureId('formal-project-'+tenant)]);
        await client.query('COMMIT');
      }catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}
    }
  }finally{await pool.end();}
  if(failed)throw new Error('Authenticated Outline adoption fixture cleanup failed');
});
const fixture=(capacity=false)=>outlineAdoptionPgFixture(pool,owned,capacity);
type Fixture=Awaited<ReturnType<typeof fixture>>;
const freshPool=()=>new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});
const nativeCounts=(f:Fixture)=>outlineVersionCounts(pool,f.target);
const candidateKey=(f:Fixture,applicationId:string)=>({scope:f.scope,applicationId});
const base=(f:Fixture)=>'/api/v1/projects/'+f.scope.projectId;
const candidatePath=(f:Fixture,id:string)=>base(f)+'/outline-adoption/candidates/'+id;

it('installs two complete C-ordered catalog indexes and uses them for project and run keyset pages without sorting',async()=>{
  const expected=await Promise.all(['0001-outline-intents.sql','0002-outline-candidate-catalog.sql'].map(async(name,index)=>({version:index+1,checksum:createHash('sha256').update(await readFile(new URL('../src/projects/outline-intent-migrations/'+name,import.meta.url),'utf8')).digest('hex')})));
  expect(expected[0]!.checksum).toBe('0347b878b4d6c2f4e08b7ebfb4f0ef518a89f28894facbcee915e7c182f6c46a');
  const applied=(await pool.query('SELECT version,checksum FROM camery_projects.outline_migrations ORDER BY version')).rows;expect(applied).toEqual(expected);
  await migrateOutlineProjectIntents(pool);expect((await pool.query('SELECT version,checksum FROM camery_projects.outline_migrations ORDER BY version')).rows).toEqual(applied);
  const names=['outline_candidate_catalog_idx','outline_candidate_run_catalog_idx'];
  const indexes=await pool.query<{name:string;valid:boolean;ready:boolean;method:string;columns:string[];collation:string;descending:boolean;complete:boolean}>(`SELECT c.relname AS name,i.indisvalid AS valid,i.indisready AS ready,am.amname AS method,
    ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum,position) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.position<=i.indnkeyatts ORDER BY k.position) AS columns,
    co.collname AS collation,(i.indoption[i.indnkeyatts-1] & 1)=1 AS descending,i.indpred IS NULL AND i.indexprs IS NULL AS complete
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_am am ON am.oid=c.relam
    LEFT JOIN pg_collation co ON co.oid=i.indcollation[i.indnkeyatts-1]
    WHERE n.nspname='camery_projects' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,[names]);
  expect(indexes.rows).toEqual(names.map((name,index)=>({name,valid:true,ready:true,method:'btree',columns:['tenant_id','project_id','ir_tenant_id','ir_project_id',...(index?['run_id']:[]),'change_id'],collation:'C',descending:true,complete:true})));
  const f=await fixture(),second=await f.intents.putCandidate(f.bodyFor('catalog-index-row')),last=[f.candidate.changeId,second.changeId].sort().at(-1)!,client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query('SET LOCAL enable_seqscan=off');
    for(const [index,run] of [false,true].entries()){
      const plan=await client.query<{'QUERY PLAN':string}>(`EXPLAIN (COSTS OFF) SELECT change_id FROM camery_projects.outline_candidate_intents WHERE tenant_id=$1 AND project_id=$2 AND ir_tenant_id=$3 AND ir_project_id=$4${run?' AND run_id=$6':''} AND change_id COLLATE "C" < $5::text COLLATE "C" ORDER BY change_id COLLATE "C" DESC LIMIT 5`,[f.scope.tenantId,f.scope.projectId,f.target.tenantId,f.target.projectId,last,...(run?[f.source.runId]:[])]);
      const text=plan.rows.map(row=>row['QUERY PLAN']).join('\n');expect(text).toContain('using '+names[index]);expect(text).not.toMatch(/\bSort\b/);
    }
  }finally{try{await client.query('ROLLBACK');}finally{client.release();}}
});

it('uses a dedicated LOGIN for real new identity preparation, adoption, unchanged acknowledgement and source-stale rejection',async()=>{
  const f=await fixture();const current=await f.next('runtime-owned-source',4);
  await withOutlineAdoptionRole(pool,databaseUrl,async(runtime)=>{
    await verifyOutlineProjectAdoptionRole(runtime);
    const application=f.application(runtime),prepared=await application.prepareOutline({subject:await f.subject('editor'),projectId:f.scope.projectId,runId:current.source.runId,command:f.command('login-prepare',current.source)});
    expect(prepared.status).toBe('candidate');expect(prepared.runId).toBe(current.source.runId);expect(prepared.preparation?.status).toBe('candidate');
    expect((await pool.query<{n:string}>('SELECT count(*)::text n FROM camery_outline.identity_preparations WHERE tenant_id=$1 AND run_id=$2',[f.scope.tenantId,current.source.runId])).rows[0]!.n).toBe('1');
    const adopted=await application.adoptCandidate({subject:await f.subject('reviewer'),projectId:f.scope.projectId,candidateId:prepared.candidateId,requestId:'login-adopt',command:{expectedSnapshotRevision:1,expectedWriteVersion:2}});
    expect(adopted.status).toBe('adopted');expect(adopted.adoption?.actor_id).toBe(fixtureId(f.scope.tenantId+'reviewer'));expect(adopted.adoption?.scope).toEqual({kind:'project',id:f.target.projectId});
    const before=await nativeCounts(f),unchanged=await application.prepareOutline({subject:await f.subject('editor'),projectId:f.scope.projectId,runId:current.source.runId,command:f.command('login-unchanged',current.source,2,3)});
    expect(unchanged.operationCount).toBe(0);expect(unchanged.preparation?.status).toBe('unchanged');expect(await nativeCounts(f)).toEqual(before);
    const rejectSource=await f.next('runtime-reject-source',4),candidate=await application.prepareOutline({subject:await f.subject('editor'),projectId:f.scope.projectId,runId:rejectSource.source.runId,command:f.command('login-reject',rejectSource.source,2,3)});
    await f.store.putBrief({...f.put,expectedRevision:rejectSource.run.brief.revision,episodeCount:4,paidEpisodeNumbers:[4],notes:'拒绝前来源已经更新'});
    const rejected=await application.rejectCandidate({subject:await f.subject('reviewer'),projectId:f.scope.projectId,candidateId:candidate.candidateId,requestId:'login-rejection',command:{expectedSnapshotRevision:2,expectedWriteVersion:4,reason:'来源更新，明确保留此次拒绝理由。'}});
    expect(rejected.status).toBe('rejected');expect(rejected.rejection?.reason).toBe('来源更新，明确保留此次拒绝理由。');
    const reopened=new Pool({connectionString:runtime.options.connectionString,max:2,connectionTimeoutMillis:5000});try{
      await verifyOutlineProjectAdoptionRole(reopened);const view=await f.application(reopened).candidate({subject:await f.subject('viewer'),projectId:f.scope.projectId,candidateId:prepared.candidateId});
      expect(view.status).toBe('adopted');expect(view.preparation).toEqual(prepared.preparation);expect(view.canReview).toBe(false);expect(f.calls()).toBe(3);
    }finally{await reopened.end();}
    for(const sql of [
      'UPDATE camery_outline.reviews SET record=record WHERE false','INSERT INTO camery_projects.principals SELECT * FROM camery_projects.principals WHERE false',
      'SELECT * FROM camery_access.sessions LIMIT 0','UPDATE camery_versioning.projects SET tenant_id=tenant_id WHERE false','UPDATE camery_versioning.changes SET change_id=change_id WHERE false',
      'SELECT * FROM camery_projects.candidate_intents LIMIT 0','CREATE TABLE camery_outline.forbidden_runtime_table(value integer)',
    ])await expect(runtime.query(sql)).rejects.toMatchObject({code:'42501'});
  });
});

it.each([
  ['extra table','GRANT SELECT ON camery_access.sessions','REVOKE SELECT ON camery_access.sessions'],
  ['extra update column','GRANT UPDATE(tenant_id) ON camery_versioning.projects','REVOKE UPDATE(tenant_id) ON camery_versioning.projects'],
  ['extra source write','GRANT INSERT ON camery_outline.reviews','REVOKE INSERT ON camery_outline.reviews'],
  ['grant option','GRANT SELECT ON camery_versioning.snapshots','REVOKE GRANT OPTION FOR SELECT ON camery_versioning.snapshots'],
  ['schema create','GRANT CREATE ON SCHEMA camery_outline','REVOKE CREATE ON SCHEMA camery_outline'],
] as const)('rejects a dedicated LOGIN with %s privilege',async(label,grant,revoke)=>{
  await withOutlineAdoptionRole(pool,databaseUrl,async(runtime,name)=>{
    await verifyOutlineProjectAdoptionRole(runtime);await pool.query(grant+` TO "${name}"`+(label==='grant option'?' WITH GRANT OPTION':''));
    try{await expect(verifyOutlineProjectAdoptionRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}
    finally{await pool.query(revoke+` FROM "${name}"`);}
    await verifyOutlineProjectAdoptionRole(runtime);
  });
});
it('refuses missing required proof INSERT and role membership while keeping the old adopter profile isolated',async()=>{
  await withOutlineAdoptionRole(pool,databaseUrl,async(runtime,name)=>{
    await pool.query(`REVOKE INSERT ON camery_outline.identity_preparations FROM "${name}"`);
    await expect(verifyOutlineProjectAdoptionRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    await pool.query(`GRANT INSERT ON camery_outline.identity_preparations TO "${name}"`);await verifyOutlineProjectAdoptionRole(runtime);
    const other='outline_member_'+randomBytes(10).toString('hex');let created=false;
    try{await pool.query(`CREATE ROLE "${other}" NOLOGIN`);created=true;await pool.query(`GRANT "${other}" TO "${name}"`);await expect(verifyOutlineProjectAdoptionRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});}
    finally{if(created){await pool.query(`REVOKE "${other}" FROM "${name}"`);await pool.query(`DROP ROLE "${other}"`);}}
    await verifyOutlineProjectAdoptionRole(runtime);
  });
  await withOutlineAdoptionRole(pool,databaseUrl,async(runtime)=>{
    await verifyProjectAdoptionRole(runtime);await expect(verifyOutlineProjectAdoptionRole(runtime)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    for(const table of ['outline_candidate_intents','outline_candidate_receipts','outline_decision_intents','outline_decision_receipts'])await expect(runtime.query(`SELECT * FROM camery_projects.${table} LIMIT 0`)).rejects.toMatchObject({code:'42501'});
  },grantProjectAdoptionRole);
});

it('prepares one immutable application command across eight concurrent producers and read-only catalog pages',async()=>{
  const f=await fixture(),subject=await f.subject('editor'),command=f.command('first-concurrent'),application=f.application();
  const results=await Promise.all(Array.from({length:8},()=>application.prepareOutline({subject,projectId:f.scope.projectId,runId:f.source.runId,command})));const first=results[0]!;
  expect(results.every(row=>row.candidateId===first.candidateId)).toBe(true);expect(first.status).toBe('candidate');
  expect((await pool.query<{n:string}>('SELECT count(*)::text n FROM camery_projects.outline_candidate_intents WHERE tenant_id=$1 AND application_id=$2',[f.scope.tenantId,command.applicationId])).rows[0]!.n).toBe('1');
  expect((await f.versions.read(f.target))!.state.changes).toHaveLength(1);
  const before=await f.persistenceCounts(),generated=f.generated(),calls=f.calls();
  const query={subject:await f.subject('viewer'),projectId:f.scope.projectId,command:{runId:f.source.runId,limit:1}},firstPage=await application.listCandidates(query);
  expect(firstPage.items).toHaveLength(1);expect(firstPage.nextCursor).not.toBeNull();
  const second=await application.listCandidates({...query,command:{...query.command,cursor:firstPage.nextCursor!}});
  expect(second.items).toHaveLength(1);expect(new Set([firstPage.items[0]!.candidateId,second.items[0]!.candidateId]).size).toBe(2);expect(second.nextCursor).toBeNull();
  await application.candidate({subject:query.subject,projectId:f.scope.projectId,candidateId:first.candidateId});
  await application.receiptMessages({subject:query.subject,projectId:f.scope.projectId,candidateId:first.candidateId,command:{kind:'preparation',requestId:command.applicationId,section:'warnings',limit:1}});
  expect(await f.persistenceCounts()).toEqual(before);expect(f.generated()).toBe(generated);expect(f.calls()).toBe(calls);
  await expect(application.listCandidates({...query,command:{runId:'other-run',cursor:firstPage.nextCursor!}})).rejects.toMatchObject({code:'INVALID_INPUT'});
});

it.each(['intent','submit','adopt'] as const)('recovers a committed authenticated %s ACK with a new pool and original native audit',async phase=>{
  const f=await fixture(),applicationId='lost-'+phase,requestId='lost-decision';let relevant=false,lost=false;
  const observed=observeOutlinePool(pool,async(_client,text)=>{
    const marker=phase==='intent'?'outline_candidate_intents':phase==='submit'?'outline_candidate_receipts':'outline_decision_receipts';if(text.includes('INSERT INTO camery_projects.'+marker))relevant=true;
  },()=>{if(relevant&&!lost){lost=true;throw new Error('Injected committed application acknowledgement loss');}});
  const input={subject:await f.subject('editor'),projectId:f.scope.projectId,runId:f.source.runId,command:f.command(applicationId)};
  let candidate:OutlineCandidate|undefined;if(phase==='adopt')candidate=await f.application().prepareOutline(input);
  if(candidate)await expect(f.application(observed).adoptCandidate({subject:await f.subject('reviewer'),projectId:f.scope.projectId,candidateId:candidate.candidateId,requestId,command:{expectedSnapshotRevision:1,expectedWriteVersion:2}})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  else await expect(f.application(observed).prepareOutline(input)).rejects.toMatchObject({code:phase==='intent'?'STORAGE_FAILED':'DATABASE_ERROR'});
  expect(lost).toBe(true);const intent=(await f.intents.findCandidate(candidateKey(f,applicationId)))!,before=await nativeCounts(f),reopened=freshPool();
  if(phase==='adopt')await f.store.putBrief({...f.put,expectedRevision:1,notes:'采用完成后来源已经推进，原审计仍可恢复。'});
  try{
    const restored=f.application(reopened);
    if(phase==='adopt'){
      const receipt=await restored.adoptCandidate({subject:await f.subject('reviewer'),projectId:f.scope.projectId,candidateId:intent.changeId,requestId,command:{expectedSnapshotRevision:1,expectedWriteVersion:2}});
      expect(receipt.status).toBe('adopted');expect(receipt.adoption).toEqual((await f.versions.read(f.target))!.state.adoptions[0]);expect(await nativeCounts(f)).toEqual(before);
    }else{
      const retried=await restored.prepareOutline(input);expect(retried.candidateId).toBe(intent.changeId);expect(retried.preparation?.status).toBe('candidate');
      if(phase==='submit')expect(await nativeCounts(f)).toEqual(before);
      expect((await f.versions.read(f.target))!.state.changes).toHaveLength(1);
    }
    expect((await f.intents.findCandidate(candidateKey(f,applicationId)))!.operationIds).toEqual(intent.operationIds);expect(f.calls()).toBe(1);
  }finally{await reopened.end();}
});

it.each(['preparation','decision'] as const)('rolls real native mutations back when the application %s receipt fails',async phase=>{
  const f=await fixture(),applicationId='rollback-'+phase,requestId='rollback-decision',normal=f.application();
  let candidate:OutlineCandidate|undefined;if(phase==='decision')candidate=await normal.prepareOutline({subject:await f.subject('editor'),projectId:f.scope.projectId,runId:f.source.runId,command:f.command(applicationId)});
  const before=await f.versions.read(f.target),counts=await nativeCounts(f),observed=observeOutlinePool(pool,async(_client,text)=>{if(text.includes('INSERT INTO camery_projects.'+(phase==='preparation'?'outline_candidate_receipts':'outline_decision_receipts')))throw new Error('Injected actual receipt persistence failure');});
  if(candidate)await expect(f.application(observed).adoptCandidate({subject:await f.subject('reviewer'),projectId:f.scope.projectId,candidateId:candidate.candidateId,requestId,command:{expectedSnapshotRevision:1,expectedWriteVersion:2}})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  else await expect(f.application(observed).prepareOutline({subject:await f.subject('editor'),projectId:f.scope.projectId,runId:f.source.runId,command:f.command(applicationId)})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(await f.versions.read(f.target)).toEqual(before);expect(await nativeCounts(f)).toEqual(counts);
  if(phase==='preparation')expect(await f.intents.readPreparationReceipt(candidateKey(f,applicationId))).toBeNull();
  else expect(await f.intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId})).toBeNull();
});

it('retains every real reviewed field through a complete 1249-operation HTTP adoption and fresh-pool read',async()=>{
  const f=await fixture(true);await withOutlineAdoptionRole(pool,databaseUrl,async(runtime)=>{
    await verifyOutlineProjectAdoptionRole(runtime);const options=f.optionsFor(runtime),app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,outlineAdoption:options});
    try{
      const command=f.command('http-complete'),url=base(f)+'/outline/'+f.source.runId+'/candidates',response=await app.inject({method:'POST',url,headers:{...f.headers.editor,'idempotency-key':command.applicationId},payload:command});
      expect(response.statusCode,response.body).toBe(201);const candidate=OutlineCandidateSchema.parse(response.json().data);
      expect(candidate.operationCount).toBe(1249);expect(Buffer.byteLength(response.body)).toBeLessThan(16384);expect(response.body).not.toContain('operationIds');expect(response.body).not.toContain('modelIdentity');expect(response.json().data).not.toHaveProperty('draft');
      const intent=(await f.intents.findCandidate(candidateKey(f,command.applicationId)))!;expect(Buffer.byteLength(JSON.stringify(intent))).toBeGreaterThan(1048576);expect(intent.request!.ops).toHaveLength(1249);
      const decision=await app.inject({method:'POST',url:candidatePath(f,candidate.candidateId)+'/adopt',headers:{...f.headers.reviewer,'idempotency-key':'http-complete-adoption'},payload:{expectedSnapshotRevision:1,expectedWriteVersion:2}});
      expect(decision.statusCode,decision.body).toBe(201);const receipt=OutlineReceiptSchema.parse(decision.json().data);expect(receipt.status).toBe('adopted');expect(receipt.adoption?.actor_id).not.toBe(intent.actor.id);
      const reopened=freshPool();try{
        const stored=(await new PostgresVersionStore(reopened).read(f.target))!;if(stored.state.head.schema_version!=='0.7.0-draft')throw new Error('Expected full Outline v07 graph');
        const {projection,binding}=selectedOutlineProjection(stored.state.head,intent.source.identities);expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review!.output);
        const restored=await f.application(reopened).candidate({subject:await f.subject('viewer'),projectId:f.scope.projectId,candidateId:candidate.candidateId});expect(restored.status).toBe('adopted');expect(restored.preparation).toEqual(candidate.preparation);
      }finally{await reopened.end();}
      const before=await nativeCounts(f),generated=f.generated();
      const listing=await app.inject({url:base(f)+'/outline-adoption/candidates?runId='+f.source.runId+'&limit=1',headers:f.headers.viewer});expect(listing.statusCode,listing.body).toBe(200);expect(OutlineCandidatePageSchema.parse(listing.json().data).items).toHaveLength(1);
      const read=await app.inject({url:candidatePath(f,candidate.candidateId),headers:f.headers.viewer});expect(read.statusCode,read.body).toBe(200);expect(read.headers['cache-control']).toBe('no-store');expect(read.json().data.canReview).toBe(false);expect(await nativeCounts(f)).toEqual(before);expect(f.generated()).toBe(generated);expect(f.calls()).toBe(1);
    }finally{await app.close();}
  });
});

it('rejects untrusted HTTP fields and duplicate idempotency headers before new application or formal writes',async()=>{
  const f=await fixture(),app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,outlineAdoption:f.optionsFor()});
  try{
    const command=f.command('strict-input'),url=base(f)+'/outline/'+f.source.runId+'/candidates',before=await f.persistenceCounts(),nativeBefore=await nativeCounts(f);
    for(const extra of [{actor:{kind:'user',id:allocate()}},{target:f.target},{draft:{}},{request:{}},{modelIdentity:'caller-model'}]){
      const response=await app.inject({method:'POST',url,headers:{...f.headers.editor,'idempotency-key':command.applicationId},payload:{...command,...extra}});expect(response.statusCode,response.body).toBe(400);
    }
    for(const headers of [{...f.headers.editor},{...f.headers.editor,'idempotency-key':'another-key'},{...f.headers.editor,'idempotency-key':[command.applicationId,command.applicationId]}])expect((await app.inject({method:'POST',url,headers,payload:command})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url,headers:{...f.headers.viewer,'idempotency-key':command.applicationId},payload:command})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url,headers:{...f.headers.editor,'idempotency-key':command.applicationId},payload:{...command,padding:'x'.repeat(20000)}})).statusCode).toBe(413);
    expect(await f.persistenceCounts()).toEqual(before);expect(await nativeCounts(f)).toEqual(nativeBefore);
    const response=await app.inject({method:'POST',url,headers:{...f.headers.editor,'idempotency-key':command.applicationId},payload:command});expect(response.statusCode,response.body).toBe(201);const candidate=OutlineCandidateSchema.parse(response.json().data);
    expect((await app.inject({method:'POST',url:candidatePath(f,candidate.candidateId)+'/adopt',headers:{...f.headers.reviewer,'idempotency-key':'scope-injection'},payload:{expectedSnapshotRevision:1,expectedWriteVersion:2,scope:{kind:'project',id:f.target.projectId}}})).statusCode).toBe(400);
    expect((await app.inject({url:candidatePath(f,candidate.candidateId).replace('/project/','/other/'),headers:f.headers.viewer})).statusCode).toBe(403);
  }finally{await app.close();}
  const disabled=await createApplication({tenantId:f.scope.tenantId,store:f.sessions});try{expect((await disabled.inject({url:base(f)+'/outline-adoption/candidates',headers:f.headers.viewer})).statusCode).toBe(404);}finally{await disabled.close();}
});

it('checks fresh session grants before cached preparation and adoption acknowledgements, and preserves explicit stale rejection',async()=>{
  const f=await fixture(),app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,outlineAdoption:f.optionsFor()});
  try{
    const command=f.command('reauthorize'),url=base(f)+'/outline/'+f.source.runId+'/candidates',prepared=await app.inject({method:'POST',url,headers:{...f.headers.editor,'idempotency-key':command.applicationId},payload:command});expect(prepared.statusCode,prepared.body).toBe(201);const candidate=OutlineCandidateSchema.parse(prepared.json().data),decisionUrl=candidatePath(f,candidate.candidateId),decision={expectedSnapshotRevision:1,expectedWriteVersion:2};
    await f.sessions.provisionMember({...f.scope,userId:'editor',role:'viewer'});expect((await app.inject({method:'POST',url,headers:{...f.headers.editor,'idempotency-key':command.applicationId},payload:command})).statusCode).toBe(403);
    await f.store.putBrief({...f.put,expectedRevision:1,notes:'采用时来源已经变更'});const before=await nativeCounts(f);
    expect((await app.inject({method:'POST',url:decisionUrl+'/adopt',headers:{...f.headers.reviewer,'idempotency-key':'stale-adopt'},payload:decision})).statusCode).toBe(409);expect(await nativeCounts(f)).toEqual(before);
    expect(await f.intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId:'stale-adopt'})).toBeNull();
    const rejected=await app.inject({method:'POST',url:decisionUrl+'/reject',headers:{...f.headers.reviewer,'idempotency-key':'stale-reject'},payload:{...decision,reason:'来源过期，明确拒绝。'}});expect(rejected.statusCode,rejected.body).toBe(201);const ack=OutlineReceiptSchema.parse(rejected.json().data);expect(ack.status).toBe('rejected');
    await f.sessions.provisionMember({...f.scope,userId:'reviewer',role:'viewer'});expect((await app.inject({method:'POST',url:decisionUrl+'/reject',headers:{...f.headers.reviewer,'idempotency-key':'stale-reject'},payload:{...decision,reason:'来源过期，明确拒绝。'}})).statusCode).toBe(403);
    await f.sessions.provisionMember({...f.scope,userId:'reviewer',role:'reviewer'});const retry=await app.inject({method:'POST',url:decisionUrl+'/reject',headers:{...f.headers.reviewer,'idempotency-key':'stale-reject'},payload:{...decision,reason:'来源过期，明确拒绝。'}});expect(retry.statusCode,retry.body).toBe(201);expect(retry.json().data).toEqual(ack);
  }finally{await app.close();}
});

it('pages every genuine native warning through authenticated HTTP with query-bound cursors and no read-side allocations',async()=>{
  const f=await fixture(),application=f.application(),editor=await f.subject('editor'),reviewer=await f.subject('reviewer');
  const initial=await application.prepareOutline({subject:editor,projectId:f.scope.projectId,runId:f.source.runId,command:f.command('warning-initial')});
  await application.adoptCandidate({subject:reviewer,projectId:f.scope.projectId,candidateId:initial.candidateId,requestId:'warning-initial-adopt',command:{expectedSnapshotRevision:1,expectedWriteVersion:2}});
  let stored=(await f.versions.read(f.target))!;if(stored.state.head.schema_version!=='0.7.0-draft')throw new Error('Expected native outline graph');const historicalPlan=structuredClone(stored.state.head.adaptation_plans[0]!),actor=(await f.authority('reviewer')).principal;
  async function nativeCommit(ops:ChangeSetV07['ops']){
    const current=(await f.versions.read(f.target))!,rows=Object.values(current.state.head).flatMap(value=>Array.isArray(value)?value:[]) as {id:string;version:number}[];
    const request=ChangeSetV07.parse({schema_version:'0.7.0-draft',id:allocate(),author:actor,status:'candidate',base_revision:current.state.head.revision.number,base_revisions:ops.flatMap(op=>'target' in op?[{id:op.target,version:rows.find(row=>row.id===op.target)!.version}]:[]),ops});
    const submitted=await f.versions.submit(f.target,request);expect(submitted.status).toBe('candidate');const adopted=await f.versions.adopt(f.target,request.id,{actor,scope:{kind:'project',id:f.target.projectId},at:new Date().toISOString(),authorize:()=>true,expectation:{expectedSnapshotRevision:current.state.head.revision.number,expectedWriteVersion:submitted.writeVersion}});expect(adopted.status).toBe('adopted');
  }
  const character=f.prepared.identities.characters[0]!.id;
  await nativeCommit([{op:'update',op_id:allocate(),collection:'characters',target:character,set:{name:'Native temporary outline edit'}}]);stored=(await f.versions.read(f.target))!;
  const restored=await application.prepareOutline({subject:editor,projectId:f.scope.projectId,runId:f.source.runId,command:f.command('warning-restore',f.source,stored.state.head.revision.number,stored.writeVersion)});
  await application.adoptCandidate({subject:reviewer,projectId:f.scope.projectId,candidateId:restored.candidateId,requestId:'warning-restore-adopt',command:{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:restored.writeVersion}});
  // These are valid historical pins, not fabricated receipt messages or caller-authored native results.
  await nativeCommit(Array.from({length:64},()=>({op:'add' as const,op_id:allocate(),collection:'adaptation_plans' as const,value:{...structuredClone(historicalPlan),id:allocate()}})));
  await nativeCommit([{op:'update',op_id:allocate(),collection:'characters',target:character,set:{name:'Native subsequent outline edit'}}]);stored=(await f.versions.read(f.target))!;
  const app=await createApplication({tenantId:f.scope.tenantId,store:f.sessions,outlineAdoption:f.optionsFor()});
  try{
    const command=f.command('http-warning-pages',f.source,stored.state.head.revision.number,stored.writeVersion),prepared=await app.inject({method:'POST',url:base(f)+'/outline/'+f.source.runId+'/candidates',headers:{...f.headers.editor,'idempotency-key':command.applicationId},payload:command});expect(prepared.statusCode,prepared.body).toBe(201);const candidate=OutlineCandidateSchema.parse(prepared.json().data),receipt=(await f.intents.readPreparationReceipt(candidateKey(f,command.applicationId)))!;
    expect(candidate.preparation?.warningCount).toBeGreaterThan(500);expect(candidate.preparation?.warningCount).toBe(receipt.warnings.length);
    const readMessages=async(kind:'preparation'|'decision',requestId:string,headers:typeof f.headers.viewer)=>{
      let cursor:string|null=null;const items:OutlineReceiptPage['items']=[];let firstCursor:string|null=null;
      do{
        const query=new URLSearchParams({kind,requestId,section:'warnings',limit:'31'});if(cursor)query.set('cursor',cursor);
        const page=await app.inject({url:candidatePath(f,candidate.candidateId)+'/receipts?'+query,headers});expect(page.statusCode,page.body).toBe(200);expect(Buffer.byteLength(page.body)).toBeLessThanOrEqual(983040);const data=OutlineReceiptPageSchema.parse(page.json().data);expect(data.items.length).toBeLessThanOrEqual(31);if(cursor!==null)expect(data.nextCursor).not.toBe(cursor);items.push(...data.items);cursor=data.nextCursor;if(firstCursor===null)firstCursor=cursor;
      }while(cursor!==null);
      return {items,firstCursor};
    };
    const before=await f.persistenceCounts(),beforeNative=await nativeCounts(f),generated=f.generated(),pages=await readMessages('preparation',command.applicationId,f.headers.viewer);expect(pages.items).toEqual(receipt.warnings);expect(pages.firstCursor).not.toBeNull();
    for(const change of [{section:'issues'},{requestId:'warning-initial'},{cursor:pages.firstCursor!+'!'}]){
      const query=new URLSearchParams({kind:'preparation',requestId:command.applicationId,section:'warnings',cursor:pages.firstCursor!,...change});const response=await app.inject({url:candidatePath(f,candidate.candidateId)+'/receipts?'+query,headers:f.headers.viewer});expect(response.statusCode,response.body).toBe(400);
    }
    const otherActor=new URLSearchParams({kind:'preparation',requestId:command.applicationId,section:'warnings',cursor:pages.firstCursor!});expect((await app.inject({url:candidatePath(f,candidate.candidateId)+'/receipts?'+otherActor,headers:f.headers.reviewer})).statusCode).toBe(400);
    expect(await f.persistenceCounts()).toEqual(before);expect(await nativeCounts(f)).toEqual(beforeNative);expect(f.generated()).toBe(generated);
    const adopted=await app.inject({method:'POST',url:candidatePath(f,candidate.candidateId)+'/adopt',headers:{...f.headers.reviewer,'idempotency-key':'http-warnings-adopt'},payload:{expectedSnapshotRevision:stored.state.head.revision.number,expectedWriteVersion:candidate.writeVersion}});expect(adopted.statusCode,adopted.body).toBe(201);const ack=OutlineReceiptSchema.parse(adopted.json().data),full=(await f.intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId:'http-warnings-adopt'}))!;
    expect(ack.warningCount).toBeGreaterThan(500);expect((await readMessages('decision','http-warnings-adopt',f.headers.reviewer)).items).toEqual(full.warnings);
    const unavailable=new URLSearchParams({kind:'decision',requestId:'http-warnings-adopt',section:'warnings'});expect((await app.inject({url:candidatePath(f,candidate.candidateId)+'/receipts?'+unavailable,headers:f.headers.viewer})).statusCode).toBe(404);expect(f.calls()).toBe(1);
  }finally{await app.close();}
});

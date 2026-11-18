import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {upgradeV05Package,upgradeV06Package} from '@camery/ir';
import {WorkbenchCandidateDetailSchema,WorkbenchCandidatePageSchema,WorkbenchActionReceiptSchema} from '@camery/ir/workbench';
import {AccessService,issueSession} from '@camery/access';
import {migrateAccess,PostgresSessionStore,verifyRuntimeRole} from '@camery/access/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {migrateDevelopment,prepareDevelopmentDraft,finalizeDevelopmentChangeSet,createDevelopmentSourceGuard} from '@camery/script/node';
import {identityPgFixture} from '../../script/test/ir-identities-pg-support.js';
import {makePackage,fixtureId as id,changeSet} from '../../ir/test/fixtures';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {ProjectIdentityRegistrar} from '../src/projects/identity-map.js';
import {grantProjectIdentityReaderRole,verifyProjectIdentityReaderRole} from '../src/projects/identity-role.js';
import {grantProjectAdoptionRole,verifyProjectAdoptionRole} from '../src/projects/adoption-role.js';
import {createProjectRuntime} from '../src/projects/runtime.js';
import {newProjectObjectId} from '../src/projects/ids.js';
import type {CandidateIntentBody,DecisionIntentBody} from '../src/projects/intent-contracts.js';
import {projectIntentDigest} from '../src/projects/intent-store.js';
import {ProjectApplication} from '../src/projects/application.js';
import {createApplication} from '../src/app.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for dedicated project adoption LOGIN tests');
const admin=new Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});const owned:string[]=[];const roles:string[]=[];const clients:Pool[]=[];
const suffix=randomBytes(10).toString('hex');const readerName='project_reader_'+suffix;const adopterName='project_adopter_'+suffix;const memberName='project_member_'+suffix;const schema='project_canary_'+suffix;let canaryCreated=false;
let reader:Pool;let adopter:Pool;let auth:Pool;let readerUrl:string;let adopterUrl:string;
function quote(value:string){return '"'+value.replaceAll('"','""')+'"';}
async function login(name:string):Promise<{pool:Pool;url:string}>{const password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE ${quote(name)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);roles.push(name);const url=new URL(databaseUrl!);url.username=name;url.password=password;const pool=new Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});clients.push(pool);return {pool,url:url.toString()};}
beforeAll(async()=>{
  await migrateAccess(admin);await migrateVersioning(admin);await migrateDevelopment(admin);await migrateProjectIdentities(admin);
  const a=await login(adopterName);adopter=a.pool;adopterUrl=a.url;const r=await login(readerName);reader=r.pool;readerUrl=r.url;
  await grantProjectAdoptionRole(admin,adopterName);await grantProjectIdentityReaderRole(admin,readerName);await verifyProjectAdoptionRole(adopter);await verifyProjectIdentityReaderRole(reader);
  const authLogin=await login('project_auth_'+suffix);auth=authLogin.pool;await admin.query(`GRANT USAGE ON SCHEMA camery_access TO ${quote(roles.at(-1)!)}`);await admin.query(`GRANT SELECT ON camery_access.users,camery_access.memberships,camery_access.sessions TO ${quote(roles.at(-1)!)}`);await admin.query(`GRANT UPDATE(revoked_at) ON camery_access.sessions TO ${quote(roles.at(-1)!)}`);await verifyRuntimeRole(auth);
  await admin.query(`CREATE SCHEMA ${quote(schema)}`);canaryCreated=true;await admin.query(`CREATE TABLE ${quote(schema)}.canary(value text)`);await admin.query(`CREATE SEQUENCE ${quote(schema)}.other_sequence`);
  await admin.query(`CREATE ROLE ${quote(memberName)} NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);roles.push(memberName);
});
afterAll(async()=>{
  let failed=false;for(const pool of clients)try{await pool.end();}catch{failed=true;}
  for(const tenantId of owned){const client=await admin.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['decision_receipts','decision_intents','candidate_receipts','candidate_intents','principals','projects','tenants'])await client.query(`DELETE FROM camery_projects.${table} WHERE tenant_id=$1`,[tenantId]);for(const table of ['ir_identities','run_origins','reviews','candidates','runs','briefs'])await client.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenantId]);for(const table of ['sessions','memberships','users'])await client.query(`DELETE FROM camery_access.${table} WHERE tenant_id=$1`,[tenantId]);for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1`,[id(tenantId)]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}
  if(canaryCreated)try{await admin.query(`DROP SCHEMA ${quote(schema)} CASCADE`);}catch{failed=true;}
  for(const name of [...roles].reverse())try{await admin.query(`DROP OWNED BY ${quote(name)}`);await admin.query(`DROP ROLE ${quote(name)}`);}catch{failed=true;}
  await admin.end();if(failed)throw new Error('Dedicated project adoption LOGIN fixture cleanup failed');
});
async function installedSource(v07=false){
  const f=await identityPgFixture(admin,owned);const versions=new PostgresVersionStore(admin);const old=upgradeV05Package(makePackage()),baseline=v07?upgradeV06Package(old):old;for(const [name,value] of Object.entries(baseline))if(Array.isArray(value))(baseline as unknown as Record<string,unknown>)[name]=[];
  baseline.project.id=f.target.projectId;baseline.project.source_ids=[];baseline.project.rights_status='unknown';baseline.project.scope={label:'独立 LOGIN 验收基线',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};baseline.revision={number:1,status:'adopted',note:'Explicit restricted LOGIN fixture installation'};await versions.initialize(f.target,baseline);
  const registrar=new ProjectIdentityRegistrar(admin);await registrar.registerTenant({tenantId:f.scope.tenantId,irTenantId:f.target.tenantId});await registrar.registerProject({...f.scope,irProjectId:f.target.projectId});for(const key of ['editor','reviewer','source-reviewer','viewer'])await registrar.registerPrincipal({tenantId:f.scope.tenantId,kind:'user',key,irActorId:id(f.scope.tenantId+key)});return f;
}
it.each([false,true])('uses two actual LOGINs on v07=%s for source-local IDs, formal submit and guarded adoption with both durable receipts',async v07=>{
  const f=await installedSource(v07);
  const runtime=await createProjectRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:readerUrl,adoptionDatabaseUrl:adopterUrl});try{
    const {identities,development,versions:restricted,intents}=runtime.options;const author=await identities.resolve({...f.scope,kind:'user',key:'editor'});expect(author.versionKey).toEqual(f.target);
    const prepared=await development.identities.prepare({source:f.source,target:f.target});const reviewerId=id(f.scope.tenantId+'source-reviewer');const reviewers={foundation:{key:'source-reviewer',id:reviewerId},episodes:{key:'source-reviewer',id:reviewerId}};const head=(await restricted.read(f.target))!.state.head;const draft=prepareDevelopmentDraft({...prepared,source:f.source,reviewers,head});
    const changeId=newProjectObjectId();const request=finalizeDevelopmentChangeSet({draft,changeSetId:changeId,author:author.principal as {kind:'user';id:string},operationIds:draft.operations.map(op=>({slot:op.slot,id:newProjectObjectId()}))});
    const body:CandidateIntentBody={version:1,scope:f.scope,applicationId:'restricted-application',actor:{...author.principal,key:'editor'},target:f.target,commandDigest:projectIntentDigest({source:f.source,expectation:{expectedSnapshotRevision:1,expectedWriteVersion:1}}),source:{kind:'development',mapperVersion:1,source:f.source,identities:prepared.identities,reviewers},expectation:{expectedSnapshotRevision:1,expectedWriteVersion:1},changeId,request};const candidate=await intents.putCandidate(body);
    expect((await restricted.submitWithReceipt(f.target,candidate.request,{expectation:candidate.expectation},intents.preparationReceiptWriter(candidate))).status).toBe('candidate');
    const {principal:reviewer}=await identities.resolvePrincipal({tenantId:f.scope.tenantId,kind:'user',key:'reviewer'});const decisionBody:DecisionIntentBody={version:1,scope:f.scope,requestId:'restricted-decision',actor:{...reviewer,key:'reviewer'},changeId,action:'adopt',adoptionScope:{kind:'project',id:f.target.projectId},expectation:{expectedSnapshotRevision:1,expectedWriteVersion:2},reason:null,at:'2026-11-17T06:00:00.000Z'};const decision=await intents.putDecision(decisionBody);
    const result=await restricted.adoptGuarded(f.target,changeId,{actor:reviewer,scope:decision.adoptionScope,expectation:decision.expectation,at:decision.at,authorize:()=>true},createDevelopmentSourceGuard(development.store,f.source),intents.decisionReceiptWriter(decision,candidate));expect(result.status).toBe('adopted');expect(result.state.head.schema_version).toBe(v07?'0.7.0-draft':'0.6.0-draft');expect(result.state.head.episodes).toHaveLength(10);
    expect((await intents.readPreparationReceipt({scope:f.scope,applicationId:body.applicationId}))?.status).toBe('candidate');expect((await intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId:decision.requestId}))?.status).toBe('adopted');
  }finally{await runtime.close();}
});
async function httpFixture(){
  const f=await installedSource();const installer=new PostgresSessionStore(admin);const credentials={editor:{authorization:''},reviewer:{authorization:''},viewer:{authorization:''}};
  for(const role of ['editor','reviewer','viewer'] as const){await installer.provisionMember({...f.scope,userId:role,role});credentials[role].authorization='Bearer '+(await issueSession({tenantId:f.scope.tenantId,userId:role,ttlSeconds:3600},installer)).token;}
  await installer.provisionMember({...f.scope,userId:'source-reviewer',role:'reviewer'});
  const runtime=await createProjectRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl:readerUrl,adoptionDatabaseUrl:adopterUrl});let app:Awaited<ReturnType<typeof createApplication>>;
  try{app=await createApplication({tenantId:f.scope.tenantId,store:new PostgresSessionStore(auth),projects:runtime.options});}catch(error){await runtime.close();throw error;}
  const base='/api/v1/projects/'+f.scope.projectId;const command={applicationId:'http-application',expectedSnapshotRevision:1,expectedWriteVersion:1,runDigest:f.source.runDigest,briefDigest:f.source.briefDigest,foundationReviewDigest:f.source.foundationReviewDigest,episodesReviewDigest:f.source.episodesReviewDigest};
  const prepare=async()=>{const response=await app.inject({method:'POST',url:base+'/development/'+f.source.runId+'/candidates',headers:{...credentials.editor,'idempotency-key':command.applicationId},payload:command});expect(response.statusCode,response.body).toBe(201);return WorkbenchCandidateDetailSchema.parse(response.json().data);};
  const counts=async()=>Promise.all(['camery_script.ir_identities','camery_projects.candidate_intents','camery_projects.candidate_receipts','camery_projects.decision_intents','camery_projects.decision_receipts'].map(async table=>(await admin.query<{n:string}>(`SELECT count(*)::text n FROM ${table} WHERE tenant_id=$1`,[f.scope.tenantId])).rows[0]!.n));
  return {...f,app,base,command,prepare,credentials,counts,runtime,application:new ProjectApplication(runtime.options),close:async()=>{try{await app.close();}finally{await runtime.close();}}};
}
it('runs authenticated HTTP prepare→typed differences→adopt and exact ACK on dedicated LOGINs, then denies revoked tokens and editor review',async()=>{
  const f=await httpFixture();try{
    const before=await f.counts();for(const url of [f.base+'/workbench/state',f.base+'/workbench/candidates',f.base+'/workbench/candidates?runId='+f.source.runId]){const response=await f.app.inject({url,headers:f.credentials.viewer});expect(response.statusCode,response.body).toBe(200);}expect(await f.counts()).toEqual(before);
    const prepared=await f.prepare();expect(prepared.source).toEqual({kind:'development',runId:f.source.runId,state:'current'});expect(prepared.status).toBe('candidate');for(const collection of ['worlds','characters','character_relationships','development_plans','episodes','episode_plans'])expect(prepared.differences.some(row=>row.collection===collection)).toBe(true);expect(prepared.differences.filter(row=>row.collection==='episode_plans')).toHaveLength(10);
    const command={scope:{kind:'project',id:f.target.projectId},expectedSnapshotRevision:1,expectedWriteVersion:2};const url=f.base+'/workbench/candidates/'+prepared.candidateId+'/adopt';
    expect((await f.app.inject({method:'POST',url,headers:{...f.credentials.editor,'idempotency-key':'http-adopt'},payload:command})).statusCode).toBe(403);
    const adopt=async()=>f.app.inject({method:'POST',url,headers:{...f.credentials.reviewer,'idempotency-key':'http-adopt'},payload:command});const first=await adopt();expect(first.statusCode,first.body).toBe(201);const receipt=WorkbenchActionReceiptSchema.parse(first.json().data);expect(receipt.status).toBe('adopted');expect(receipt.adoption?.change_set_id).toBe(prepared.candidateId);const savedCounts=await f.counts();
    await f.store.putBrief({...f.put,expectedRevision:1,idea:'采用后修改来源，不可改变既有采用回执'});const ack=await adopt();expect(ack.statusCode,ack.body).toBe(201);expect(ack.json().data).toEqual(receipt);expect(await f.counts()).toEqual(savedCounts);
    expect((await f.app.inject({method:'POST',url:'/api/v1/auth/sign-out',headers:f.credentials.reviewer})).statusCode).toBe(204);expect((await adopt()).statusCode).toBe(401);
  }finally{await f.close();}
});
it('reads adopted content and bounded history with the dedicated LOGIN, rejecting mixed snapshots after an independent adoption',async()=>{
  const f=await httpFixture();try{
    const initial=await f.counts();const empty=await f.app.inject({url:f.base+'/workbench',headers:f.credentials.viewer});expect(empty.statusCode,empty.body).toBe(200);expect(empty.json().data.rows).toEqual([]);expect(await f.counts()).toEqual(initial);
    const candidate=await f.prepare();const decision=await f.app.inject({method:'POST',url:f.base+'/workbench/candidates/'+candidate.candidateId+'/adopt',headers:{...f.credentials.reviewer,'idempotency-key':'read-seed-adoption'},payload:{scope:{kind:'project',id:f.target.projectId},expectedSnapshotRevision:1,expectedWriteVersion:2}});expect(decision.statusCode,decision.body).toBe(201);
    const url=f.base+'/workbench?collection=episode_plans&limit=3';const response=await f.app.inject({url,headers:f.credentials.viewer});expect(response.statusCode,response.body).toBe(200);const page=response.json().data;expect(page.rows).toHaveLength(3);expect(page.snapshotRevision).toBe(2);expect(page.capabilities).toEqual({canWrite:false,canReview:false,canReadMedia:false});expect(page.nextCursor).toBeTypeOf('string');
    const next=await f.app.inject({url:url+'&expectedRevision=2&cursor='+encodeURIComponent(page.nextCursor),headers:f.credentials.viewer});expect(next.statusCode,next.body).toBe(200);expect(new Set([...page.rows,...next.json().data.rows].map((row:{ref:{id:string}})=>row.ref.id)).size).toBe(6);
    const objectId=page.rows[0].ref.id as string;const history=await f.app.inject({url:f.base+'/workbench/objects/episode_plans/'+objectId+'/history?expectedRevision=2&limit=1',headers:f.credentials.viewer});expect(history.statusCode,history.body).toBe(200);expect(history.json().data.items[0]).toMatchObject({ref:{id:objectId,version:1},snapshotRevision:2,deleted:false});
    const editor=await f.runtime.options.identities.resolvePrincipal({tenantId:f.scope.tenantId,kind:'user',key:'editor'});const request=changeSet([{op:'update',op_id:newProjectObjectId(),collection:'episodes',target:page.rows[0].value.episode_id as string,set:{title:'独立采用后的正式分集'}}],{schema_version:'0.6.0-draft',id:newProjectObjectId(),author:editor.principal,base_revision:2,base_revisions:[{id:page.rows[0].value.episode_id as string,version:1}]});
    const submitted=await f.app.inject({method:'POST',url:f.base+'/workbench/candidates',headers:{...f.credentials.editor,'idempotency-key':'read-update'},payload:{applicationId:'read-update',change:request,expectedSnapshotRevision:2,expectedWriteVersion:3}});expect(submitted.statusCode,submitted.body).toBe(201);
    const adopted=await f.app.inject({method:'POST',url:f.base+'/workbench/candidates/'+request.id+'/adopt',headers:{...f.credentials.reviewer,'idempotency-key':'read-update-adoption'},payload:{scope:{kind:'project',id:f.target.projectId},expectedSnapshotRevision:2,expectedWriteVersion:4}});expect(adopted.statusCode,adopted.body).toBe(201);expect(adopted.json().data.status).toBe('adopted');
    const stale=await f.app.inject({url:url+'&cursor='+encodeURIComponent(page.nextCursor),headers:f.credentials.viewer});expect(stale.statusCode,stale.body).toBe(409);expect(stale.json().code).toBe('SNAPSHOT_STALE');
    const oldHistory=await f.app.inject({url:f.base+'/workbench/objects/episode_plans/'+objectId+'/history?expectedRevision=2',headers:f.credentials.viewer});expect(oldHistory.statusCode,oldHistory.body).toBe(409);expect(await f.runtime.options.reads.head(f.target)).toMatchObject({pendingCount:0,head:{revision:{number:3}}});
    expect((await f.app.inject({url:f.base+'/workbench'})).statusCode).toBe(401);
  }finally{await f.close();}
});
it('pages real scalar catalog metadata, includes unmanaged native changes only in all-project lists and binds cursors to the session subject',async()=>{
  const f=await httpFixture();try{
    const prepared=await f.prepare();const intent=(await f.runtime.options.intents.findCandidate({scope:f.scope,applicationId:f.command.applicationId}))!;
    for(let index=0;index<51;index++){const {digest:_digest,businessDigest:_businessDigest,createdAt:_createdAt,...body}=structuredClone(intent);body.applicationId='catalog-prepared-'+index;body.changeId=newProjectObjectId();body.request!.id=body.changeId;await f.runtime.options.intents.putCandidate(body);}
    const nativeId=newProjectObjectId();const native=changeSet([{op:'add',op_id:newProjectObjectId(),collection:'props',value:{id:newProjectObjectId(),version:1,name:'原生目录道具',description:'没有共享 intent 的候选'}}],{schema_version:'0.6.0-draft',id:nativeId,base_revision:1,base_revisions:[],author:{kind:'user',id:id(f.scope.tenantId+'editor')}});expect((await new PostgresVersionStore(admin).submit(f.target,native)).status).toBe('candidate');
    const other=await installedSource();const foreignRequest={...native,author:{kind:'user' as const,id:id(other.scope.tenantId+'editor')}};await f.runtime.options.intents.putCandidate({version:1,scope:other.scope,target:other.target,applicationId:'same-id-in-other-tenant',actor:{...foreignRequest.author,key:'editor'},commandDigest:'a'.repeat(64),source:{kind:'manual'},changeId:nativeId,request:foreignRequest,expectation:{expectedSnapshotRevision:1,expectedWriteVersion:1}});
    const url=f.base+'/workbench/candidates';const all=await f.app.inject({url:url+'?limit=50',headers:f.credentials.viewer});expect(all.statusCode,all.body).toBe(200);const first=WorkbenchCandidatePageSchema.parse(all.json().data);expect(first.items).toHaveLength(50);expect(first.nextCursor).not.toBeNull();
    const next=await f.app.inject({url:url+'?limit=50&cursor='+first.nextCursor,headers:f.credentials.viewer});expect(next.statusCode,next.body).toBe(200);const second=WorkbenchCandidatePageSchema.parse(next.json().data);const items=[...first.items,...second.items];expect(new Set(items.map(row=>row.candidateId)).size).toBe(53);expect(items.find(row=>row.candidateId===nativeId)).toMatchObject({managed:false,source:{kind:'unmanaged'},applicationId:null,createdAt:null});expect(items.find(row=>row.candidateId===prepared.candidateId)?.status).toBe('candidate');expect(items.filter(row=>row.status==='prepared')).toHaveLength(51);
    const filtered=await f.app.inject({url:url+'?runId='+f.source.runId+'&limit=50',headers:f.credentials.viewer});expect(filtered.statusCode,filtered.body).toBe(200);expect(WorkbenchCandidatePageSchema.parse(filtered.json().data).items.every(row=>row.source.kind==='development'&&row.source.state==='unchecked')).toBe(true);
    expect((await f.app.inject({url:url+'?cursor='+first.nextCursor,headers:f.credentials.editor})).statusCode).toBe(400);expect((await f.app.inject({url:url+'?runId=unrelated',headers:f.credentials.viewer})).json().data.items).toEqual([]);
    expect(JSON.stringify(items)).not.toContain('expectedWriteVersion');expect(JSON.stringify(items)).not.toContain('ops');
  }finally{await f.close();}
});
it('keeps stale-source adoption and receipts atomic, recovers the exact prepared intent and permits an explicit rejection',async()=>{
  const f=await httpFixture();try{
    const prepared=await f.prepare();await f.store.putBrief({...f.put,expectedRevision:1,idea:'新 brief 使尚未采用的来源过期'});const command={scope:{kind:'project' as const,id:f.target.projectId},expectedSnapshotRevision:1,expectedWriteVersion:2};const url=f.base+'/workbench/candidates/'+prepared.candidateId;
    const before=(await new PostgresVersionStore(admin).read(f.target))!;const response=await f.app.inject({method:'POST',url:url+'/adopt',headers:{...f.credentials.reviewer,'idempotency-key':'stale-adoption'},payload:command});expect(response.statusCode,response.body).toBe(409);expect(response.json().code).toBe('CONFLICT');
    const subject=await new AccessService({tenantId:f.scope.tenantId,store:new PostgresSessionStore(auth)}).authenticate(f.credentials.reviewer.authorization);await expect(f.application.adoptCandidate({subject,projectId:f.scope.projectId,candidateId:prepared.candidateId,requestId:'stale-adoption',command})).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});
    expect(await new PostgresVersionStore(admin).read(f.target)).toEqual(before);expect(await f.runtime.options.intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId:'stale-adoption'})).toBeNull();expect((await f.prepare()).candidateId).toBe(prepared.candidateId);
    const rejection=await f.app.inject({method:'POST',url:url+'/reject',headers:{...f.credentials.reviewer,'idempotency-key':'stale-rejection'},payload:{...command,reason:'来源已过期，明确拒绝本候选'}});expect(rejection.statusCode,rejection.body).toBe(201);const receipt=WorkbenchActionReceiptSchema.parse(rejection.json().data);expect(receipt.status).toBe('rejected');expect(receipt.rejection?.reason).toBe('来源已过期，明确拒绝本候选');
    expect((await f.app.inject({url,headers:f.credentials.viewer})).json().data.status).toBe('rejected');expect((await f.runtime.options.intents.readDecisionReceipt({scope:f.scope,actorKind:'user',actorKey:'reviewer',requestId:'stale-rejection'}))?.rejection).toEqual(receipt.rejection);
  }finally{await f.close();}
});
it('rejects actual 42501 writes outside the adopter boundary and distinguishes the reader LOGIN',async()=>{
  for(const sql of ['INSERT INTO camery_script.briefs DEFAULT VALUES','DELETE FROM camery_script.reviews WHERE false','DELETE FROM camery_script.ir_identities WHERE false','SELECT * FROM camery_projects.tenants','INSERT INTO camery_projects.projects DEFAULT VALUES','INSERT INTO camery_versioning.projects DEFAULT VALUES','UPDATE camery_versioning.projects SET package_id=package_id WHERE false','UPDATE camery_versioning.changes SET change_id=change_id WHERE false','DELETE FROM camery_projects.candidate_intents WHERE false','SELECT * FROM camery_projects.migrations',`SELECT * FROM ${quote(schema)}.canary`,`CREATE TABLE ${quote(schema)}.forbidden(value text)`])await expect(adopter.query(sql)).rejects.toMatchObject({code:'42501'});
  await expect(reader.query('SELECT * FROM camery_script.briefs')).rejects.toMatchObject({code:'42501'});await expect(reader.query('INSERT INTO camery_projects.candidate_intents DEFAULT VALUES')).rejects.toMatchObject({code:'42501'});await expect(verifyProjectAdoptionRole(reader)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(verifyProjectIdentityReaderRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  await expect(createProjectRuntime({tenantId:'tenant',readerDatabaseUrl:adopterUrl,adoptionDatabaseUrl:readerUrl})).rejects.toThrow('Project runtime startup failed');
});
it('rejects effective table, column, schema, membership, replication and sequence escalation then accepts exact revocation',async()=>{
  const role=quote(adopterName);const db=quote((await admin.query<{name:string}>('SELECT current_database() name')).rows[0]!.name);const sequence=(await admin.query<{name:string}>("SELECT pg_get_serial_sequence('camery_versioning.changes','sequence') name")).rows[0]!.name;
  const probes:[string,string,string?][]=[
    [`GRANT SELECT ON ${quote(schema)}.canary TO ${role}`,`REVOKE SELECT ON ${quote(schema)}.canary FROM ${role}`],
    [`GRANT SELECT(value) ON ${quote(schema)}.canary TO ${role}`,`REVOKE SELECT(value) ON ${quote(schema)}.canary FROM ${role}`],
    [`GRANT INSERT ON camery_versioning.projects TO ${role}`,`REVOKE INSERT ON camery_versioning.projects FROM ${role}`],
    // PostgreSQL's table-level REVOKE also removes existing column UPDATE grants; restore only these two required columns.
    [`GRANT UPDATE ON camery_versioning.changes TO ${role}`,`REVOKE UPDATE ON camery_versioning.changes FROM ${role}`,`GRANT UPDATE(status,record) ON camery_versioning.changes TO ${role}`],
    [`GRANT UPDATE(package_id) ON camery_versioning.projects TO ${role}`,`REVOKE UPDATE(package_id) ON camery_versioning.projects FROM ${role}`],
    [`GRANT INSERT ON camery_script.briefs TO ${role}`,`REVOKE INSERT ON camery_script.briefs FROM ${role}`],
    [`GRANT REFERENCES(tenant_id) ON camery_script.briefs TO ${role}`,`REVOKE REFERENCES(tenant_id) ON camery_script.briefs FROM ${role}`],
    [`GRANT SELECT ON camery_script.briefs TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR SELECT ON camery_script.briefs FROM ${role}`],
    [`GRANT USAGE ON SCHEMA camery_script TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR USAGE ON SCHEMA camery_script FROM ${role}`],
    [`GRANT CREATE ON SCHEMA ${quote(schema)} TO ${role}`,`REVOKE CREATE ON SCHEMA ${quote(schema)} FROM ${role}`],
    [`GRANT CREATE ON DATABASE ${db} TO ${role}`,`REVOKE CREATE ON DATABASE ${db} FROM ${role}`],
    [`GRANT CONNECT ON DATABASE ${db} TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR CONNECT ON DATABASE ${db} FROM ${role}`],
    [`GRANT USAGE ON SEQUENCE ${quote(schema)}.other_sequence TO ${role}`,`REVOKE USAGE ON SEQUENCE ${quote(schema)}.other_sequence FROM ${role}`],
    [`GRANT SELECT ON SEQUENCE ${sequence} TO ${role}`,`REVOKE SELECT ON SEQUENCE ${sequence} FROM ${role}`],
    [`GRANT USAGE ON SEQUENCE ${sequence} TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR USAGE ON SEQUENCE ${sequence} FROM ${role}`],
    [`GRANT ${quote(memberName)} TO ${role}`,`REVOKE ${quote(memberName)} FROM ${role}`],
    [`ALTER ROLE ${role} REPLICATION`,`ALTER ROLE ${role} NOREPLICATION`],
    [`ALTER TABLE ${quote(schema)}.canary OWNER TO ${role}`,`ALTER TABLE ${quote(schema)}.canary OWNER TO CURRENT_USER`],
  ];
  for(const [grant,revoke,restore] of probes){await admin.query(grant);try{await expect(verifyProjectAdoptionRole(adopter),grant).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await admin.query(revoke);if(restore)await admin.query(restore);}try{await verifyProjectAdoptionRole(adopter);}catch{throw new Error('Adopter capability restoration failed after '+revoke);}}
});

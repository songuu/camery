import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import type {QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {AccessService,issueSession} from '@camery/access';
import type {Role} from '@camery/access';
import {migrateAccess,PostgresSessionStore} from '@camery/access/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {migrateIngest} from '@camery/ingest/node';
import {migrateBible} from '@camery/bible/node';
import {migrateDevelopment} from '@camery/script/node';
import {migrateOutline} from '@camery/script/outline/node';
import {migrateContinuity,migrateContinuityNative,PostgresContinuityStore,resolveContinuityNativePredecessor,prepareContinuityNativeMapping,createContinuityNativeSubmissionReceipt,createContinuityNativeAdoptionHooks} from '@camery/script/continuity/node';
import {migrateScreenplay,migrateScreenplayGeneration,prepareScreenplayNativeMapping,screenplayNativeSlots,createScreenplayNativeSubmissionReceipt} from '@camery/script/screenplay/node';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {migrateScreenplayProjectIntents} from '../src/projects/screenplay-intent-migrate.js';
import {ScreenplayAdoptionApplication} from '../src/projects/screenplay-adoption-application.js';
import {screenplayAdoptionPgFixture} from './fixtures/screenplay-adoption-pg.js';
import {createScreenplayProjectHost} from '../src/projects/screenplay-project-host.js';
import {PostgresScreenplayProjectIntents} from '../src/projects/screenplay-intent-store.js';
import {grantProjectIdentityReaderRole} from '../src/projects/identity-role.js';
import {grantScreenplayProjectAdoptionRole,verifyScreenplayProjectAdoptionRole,verifyScreenplayProjectIdentityReaderRole} from '../src/projects/screenplay-adoption-role.js';
import {createScreenplayAdoptionRuntime} from '../src/projects/screenplay-adoption-runtime.js';

const url=process.env['CAMERY_TEST_DATABASE_URL'];if(!url)throw new Error('CAMERY_TEST_DATABASE_URL required for actual SC host source integration');
const database='camery_sc_host_'+randomBytes(8).toString('hex'),address=new URL(url);address.pathname='/'+database;
const admin=new Pool({connectionString:url,max:1}),pool=new Pool({connectionString:address.href,max:8});let created=false;
beforeAll(async()=>{if(!/^camery_sc_host_[a-f0-9]{16}$/.test(database))throw new Error('Unowned SC host test database');await admin.query(`CREATE DATABASE "${database}"`);created=true;await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateVersioning(pool);await migrateContinuity(pool);await migrateContinuityNative(pool);await migrateScreenplay(pool);await migrateScreenplayGeneration(pool);await migrateAccess(pool);await migrateProjectIdentities(pool);await migrateScreenplayProjectIntents(pool);await migrateScreenplayProjectIntents(pool);},30000);
afterAll(async()=>{try{await pool.end();if(created)await admin.query(`DROP DATABASE "${database}"`);}finally{await admin.end();}});
async function subject(f:Awaited<ReturnType<typeof screenplayAdoptionPgFixture>>,userId='operator',role:Role='reviewer'){
  const sessions=new PostgresSessionStore(pool);await sessions.provisionMember({...f.scope,userId,role});return new AccessService({tenantId:f.scope.tenantId,store:sessions}).authenticate('Bearer '+(await issueSession({tenantId:f.scope.tenantId,userId,ttlSeconds:3600},sessions)).token);
}
function lossyVersionPool(kind:'candidate'|'decision'='candidate'){let receiptWritten=false,lost=false;
  const wrapped=new Proxy(pool,{get(target,field){if(field==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(connection,key){if(key==='query')return async(input:string|QueryConfig,values?:unknown[])=>{const sql=typeof input==='string'?input:input.text,result=await connection.query(input,values);if(sql.startsWith(`INSERT INTO camery_projects.screenplay_${kind}_receipts`))receiptWritten=true;if(sql.toUpperCase()==='COMMIT'&&receiptWritten&&!lost){lost=true;throw new Error('Actual shared SC COMMIT ACK loss');}return result;};const value:unknown=Reflect.get(connection,key);return typeof value==='function'?value.bind(connection):value;}});};const value:unknown=Reflect.get(target,field);return typeof value==='function'?value.bind(target):value;}});
  return {pool:wrapped,lost:()=>lost};
}
it('recovers fixed SC identities after actual shared preparation COMMIT ACK loss, then adopts and reports real ledger_pending',async()=>{
  const f=await screenplayAdoptionPgFixture(pool),actor=await subject(f),loss=lossyVersionPool(),application=new ScreenplayAdoptionApplication({...f.options,versions:new PostgresVersionStore(loss.pool)}),input={subject:actor,projectId:f.scope.projectId,command:f.command};
  await expect(application.prepareScreenplay(input)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(loss.lost()).toBe(true);
  const journal=await f.intents.findCandidate({scope:f.scope,applicationId:f.command.applicationId});expect(journal).not.toBeNull();const actual=(await f.versions.read(f.target))!;expect(actual.state.changes.find(row=>row.request.id===journal!.changeId)?.status).toBe('candidate');expect((await f.intents.readPreparationReceipt({scope:f.scope,applicationId:f.command.applicationId}))?.status).toBe('candidate');
  const committed=await pool.query('SELECT change_id FROM camery_screenplay.native_bindings WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[f.scope.tenantId,f.scope.projectId,f.sourceKey.candidateId]);expect(committed.rows).toEqual([{change_id:journal!.changeId}]);
  const allocated=f.allocations(),candidate=await f.application.prepareScreenplay(input);expect(candidate.candidateId).toBe(journal!.changeId);expect(f.allocations()).toBe(allocated);expect(candidate.canAdopt).toBe(true);
  const decision={subject:actor,projectId:f.scope.projectId,candidateId:candidate.candidateId,requestId:'adopt-script',command:{expectedSnapshotRevision:candidate.snapshotRevision,expectedWriteVersion:candidate.writeVersion}},receipt=await f.application.adoptCandidate(decision);expect(receipt.status).toBe('adopted');
  const state=(await f.versions.read(f.target))!;expect(state.state.head.lines.every(line=>line.locked)).toBe(true);expect(state.state.head.locks.every(lock=>lock.owner_id===f.principals.operator.id)).toBe(true);
  const handoff=await f.application.handoff({subject:actor,projectId:f.scope.projectId,candidateId:candidate.candidateId});expect(handoff).toMatchObject({state:'ledger_pending',ledger:null,script:{changeId:candidate.candidateId}});
  expect(await f.application.adoptCandidate(decision)).toEqual(receipt);await expect(f.application.adoptCandidate({...decision,subject:await subject(f,'operator','viewer')})).rejects.toMatchObject({code:'FORBIDDEN'});
},45000);

it('keeps legacy producer candidates adoptable without inventing a host preparation journal or acknowledgement',async()=>{
  const f=await screenplayAdoptionPgFixture(pool),actor=await subject(f),host=createScreenplayProjectHost(actor,f.scope.tenantId,f.scope.projectId,f.options.now(),true),source=await f.reader.readReviewed({key:f.sourceKey,target:f.target},host),p=source.progress.preparation;
  const ids=screenplayNativeSlots(source.progress.review!.output.draft).map(slot=>({slot,id:f.newId()})),mapping=prepareScreenplayNativeMapping({head:source.head,context:p.context,candidate:p.candidate,review:source.progress.review!,target:f.target,changeId:f.newId(),author:f.principals.operator,ids}),expectation={expectedSnapshotRevision:f.command.expectedSnapshotRevision,expectedWriteVersion:f.command.expectedWriteVersion};
  await f.versions.submitWithReceipt(f.target,mapping.request,{expectation},createScreenplayNativeSubmissionReceipt({key:f.sourceKey,mapping,ids,expectation},f.scripts,host));
  const input={subject:actor,projectId:f.scope.projectId,candidateId:mapping.request.id},view=await f.application.candidate(input);expect(view).toMatchObject({applicationId:null,preparation:null,canAdopt:true});
  const allocated=f.allocations();await expect(f.application.prepareScreenplay({subject:actor,projectId:f.scope.projectId,command:{...f.command,expectedWriteVersion:view.writeVersion}})).rejects.toMatchObject({code:'CONFLICT'});expect(f.allocations()).toBe(allocated);
  expect((await f.application.adoptCandidate({...input,requestId:'legacy-adopt',command:{expectedSnapshotRevision:view.snapshotRevision,expectedWriteVersion:view.writeVersion}})).status).toBe('adopted');expect(await f.intents.candidateForChange({scope:f.scope,changeId:mapping.request.id})).toBeNull();
},45000);

it('recovers a committed adoption on a new pool and requires all four actual ledgers before the next episode can consume constraints',async()=>{
  const f=await screenplayAdoptionPgFixture(pool),actor=await subject(f),view=await f.application.prepareScreenplay({subject:actor,projectId:f.scope.projectId,command:f.command}),input={subject:actor,projectId:f.scope.projectId,candidateId:view.candidateId},decision={...input,requestId:'adoption-lost-ack',command:{expectedSnapshotRevision:view.snapshotRevision,expectedWriteVersion:view.writeVersion}},loss=lossyVersionPool('decision'),uncertain=new ScreenplayAdoptionApplication({...f.options,versions:new PostgresVersionStore(loss.pool)});
  await expect(uncertain.adoptCandidate(decision)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(loss.lost()).toBe(true);
  const saved=(await f.versions.read(f.target))!,reopened=new Pool({connectionString:address.href,max:2});
  try{const recovered=new ScreenplayAdoptionApplication({...f.options,versions:new PostgresVersionStore(reopened),intents:new PostgresScreenplayProjectIntents(reopened)});expect((await recovered.adoptCandidate(decision)).status).toBe('adopted');expect(await f.versions.read(f.target)).toEqual(saved);}finally{await reopened.end();}
  const host=createScreenplayProjectHost(actor,f.scope.tenantId,f.scope.projectId,f.options.now(),true),raw=await f.reader.handoff({scope:f.scope,target:f.target,changeId:view.candidateId},host),nextEpisode=saved.state.head.episodes[1]!.id,rules=f.reviewed.preparation.context.rules;
  expect(raw.state).toBe('ledger_pending');for(const kind of ['facts','knowledge','characters','threads'] as const)expect(raw.candidate.ledger[kind]).toHaveLength(1);
  await expect(f.scripts.describeSource({scope:f.scope,target:f.target,episodeId:nextEpisode,rules},host)).rejects.toMatchObject({code:'INCOMPLETE'});
  const ledgerHost={scope:f.scope,actor:{kind:'human' as const,id:actor.userId},at:f.options.now(),authorize:()=>true},ledgers=new PostgresContinuityStore(pool,{previousFor:resolveContinuityNativePredecessor}),key={...f.scope,candidateId:'final-ledgers'},source=await ledgers.describeSource({scope:f.scope,target:f.target,episodeId:raw.draft.episodeId},ledgerHost),prepared=await ledgers.prepare({key,target:f.target,expectedSnapshotRevision:source.source.snapshotRevision,expectedPackageDigest:source.source.packageDigest,draft:raw.draft},ledgerHost),reviewed=await ledgers.confirm(key,{candidateDigest:prepared.preparation.candidate.digest,draft:raw.draft,waivers:prepared.preparation.candidate.issues.filter(row=>row.severity==='warning').map(row=>({code:row.code,path:row.path,reason:'合成用例逐项确认真实锁定剧本证据。'}))},ledgerHost);
  const current=(await f.versions.read(f.target))!,mapping=prepareContinuityNativeMapping({head:current.state.head,progress:reviewed,changeId:f.newId(),snapshotId:f.newId(),operationId:f.newId(),author:f.principals.operator}),expectation={expectedSnapshotRevision:current.state.head.revision.number,expectedWriteVersion:current.writeVersion},pending=await f.versions.submitWithReceipt(f.target,mapping.request,{expectation},createContinuityNativeSubmissionReceipt({mapping,expectation},ledgers,ledgerHost)),adoptExpectation={expectedSnapshotRevision:pending.state.head.revision.number,expectedWriteVersion:pending.writeVersion},hooks=createContinuityNativeAdoptionHooks({mapping,expectation:adoptExpectation,actorId:f.principals.operator.id},ledgers,ledgerHost);
  expect((await f.versions.adoptGuarded(f.target,mapping.request.id,{actor:f.principals.operator,scope:{kind:'episode',id:raw.draft.episodeId},at:ledgerHost.at,authorize:()=>true,expectation:adoptExpectation},hooks.guard,hooks.receipt)).status).toBe('adopted');
  const ready=await f.application.handoff(input);expect(ready).toMatchObject({state:'handoff_ready',ledger:{changeId:mapping.request.id}});
  const next=await f.scripts.describeSource({scope:f.scope,target:f.target,episodeId:nextEpisode,rules},host);expect(next.context.previous?.ledger).toEqual(mapping.snapshot.ledger);
  await pool.query('DELETE FROM camery_screenplay.native_adoptions WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND change_id=$3',[f.target.tenantId,f.target.projectId,view.candidateId]);
  await expect(f.application.adoptCandidate(decision)).rejects.toMatchObject({code:'INCOMPLETE'});await expect(f.application.handoff(input)).rejects.toMatchObject({code:'INCOMPLETE'});
},45000);

it('commits only one whole native candidate when distinct commands race for the same reviewed source',async()=>{
  const f=await screenplayAdoptionPgFixture(pool),actor=await subject(f),input={subject:actor,projectId:f.scope.projectId},results=await Promise.allSettled(['race-a','race-b'].map(applicationId=>f.application.prepareScreenplay({...input,command:{...f.command,applicationId}})));
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  const rows=await pool.query('SELECT change_id FROM camery_screenplay.native_bindings WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[f.scope.tenantId,f.scope.projectId,f.sourceKey.candidateId]);expect(rows.rows).toHaveLength(1);expect((await f.versions.read(f.target))!.state.changes.filter(row=>row.request.author.id===f.principals.operator.id)).toHaveLength(1);
},45000);

it('uses independent restricted LOGINs for a complete candidate over the V1 operation limit and closes excess effective privileges',async()=>{
  const f=await screenplayAdoptionPgFixture(pool,260),actor=await subject(f),tag=randomBytes(8).toString('hex'),readerRole='sc_reader_'+tag,adopterRole='sc_adopter_'+tag,groupRole='sc_group_'+tag,roles:string[]=[];let reader:Pool|undefined,adopter:Pool|undefined,runtime:Awaited<ReturnType<typeof createScreenplayAdoptionRuntime>>|undefined;
  async function login(role:string){const password=randomBytes(24).toString('hex');await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);roles.push(role);const value=new URL(address.href);value.username=role;value.password=password;return value.href;}
  try{
    const readerDatabaseUrl=await login(readerRole),adoptionDatabaseUrl=await login(adopterRole);await grantProjectIdentityReaderRole(pool,readerRole);await grantScreenplayProjectAdoptionRole(pool,adopterRole);reader=new Pool({connectionString:readerDatabaseUrl,max:2});adopter=new Pool({connectionString:adoptionDatabaseUrl,max:2});await verifyScreenplayProjectAdoptionRole(adopter);await verifyScreenplayProjectIdentityReaderRole(reader);
    runtime=await createScreenplayAdoptionRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl,adoptionDatabaseUrl});const app=new ScreenplayAdoptionApplication(runtime.adoptionOptions),candidate=await app.prepareScreenplay({subject:actor,projectId:f.scope.projectId,command:f.command});expect(candidate.operationCount).toBeGreaterThan(500);expect(candidate.canAdopt).toBe(true);
    const receipt=await app.adoptCandidate({subject:actor,projectId:f.scope.projectId,candidateId:candidate.candidateId,requestId:'restricted-adoption',command:{expectedSnapshotRevision:candidate.snapshotRevision,expectedWriteVersion:candidate.writeVersion}});expect(receipt).toMatchObject({status:'adopted',issueCount:0});expect((await app.handoff({subject:actor,projectId:f.scope.projectId,candidateId:candidate.candidateId})).state).toBe('ledger_pending');
    for(const sql of ['SELECT * FROM camery_access.sessions','UPDATE camery_screenplay.candidates SET digest=digest WHERE false','DELETE FROM camery_screenplay.native_adoptions WHERE false','UPDATE camery_projects.screenplay_candidate_intents SET digest=digest WHERE false','INSERT INTO camery_projects.principals SELECT * FROM camery_projects.principals WHERE false'])await expect(adopter.query(sql)).rejects.toMatchObject({code:'42501'});
    await pool.query('CREATE TABLE public.sc_capability_canary(value text)');await pool.query('CREATE VIEW public.sc_capability_view AS SELECT value FROM public.sc_capability_canary');
    for(const [grant,revoke] of [
      [`GRANT SELECT(value) ON public.sc_capability_canary TO "${adopterRole}"`,`REVOKE SELECT(value) ON public.sc_capability_canary FROM "${adopterRole}"`],
      ['GRANT SELECT ON public.sc_capability_view TO PUBLIC','REVOKE SELECT ON public.sc_capability_view FROM PUBLIC'],
      [`GRANT UPDATE(digest) ON camery_screenplay.native_adoptions TO "${adopterRole}"`,`REVOKE UPDATE(digest) ON camery_screenplay.native_adoptions FROM "${adopterRole}"`],
      [`GRANT SELECT ON camery_access.sessions TO "${adopterRole}" WITH GRANT OPTION`,`REVOKE SELECT ON camery_access.sessions FROM "${adopterRole}"`],
    ]){await pool.query(grant!);await expect(verifyScreenplayProjectAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});await pool.query(revoke!);await verifyScreenplayProjectAdoptionRole(adopter);}
    await pool.query('CREATE FUNCTION public.sc_definer_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$');
    try{await expect(verifyScreenplayProjectAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(verifyScreenplayProjectIdentityReaderRole(reader)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(createScreenplayAdoptionRuntime({tenantId:f.scope.tenantId,readerDatabaseUrl,adoptionDatabaseUrl})).rejects.toThrow('Screenplay adoption runtime startup failed');}finally{await pool.query('DROP FUNCTION public.sc_definer_probe()');}
    await pool.query(`GRANT SELECT ON public.sc_capability_canary TO "${adopterRole}","${readerRole}"`);
    try{
      await pool.query('CREATE FUNCTION public.sc_hide_exact_catalog(name,name) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$');await pool.query('CREATE OPERATOR public.!~ (LEFTARG=pg_catalog.name,RIGHTARG=pg_catalog.name,PROCEDURE=public.sc_hide_exact_catalog)');
      await expect(verifyScreenplayProjectAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(verifyScreenplayProjectIdentityReaderRole(reader)).rejects.toMatchObject({code:'STORAGE_FAILED'});
    }finally{await pool.query('DROP OPERATOR IF EXISTS public.!~ (pg_catalog.name,pg_catalog.name)');await pool.query('DROP FUNCTION IF EXISTS public.sc_hide_exact_catalog(pg_catalog.name,pg_catalog.name)');await pool.query(`REVOKE SELECT ON public.sc_capability_canary FROM "${adopterRole}","${readerRole}"`);}
    await verifyScreenplayProjectAdoptionRole(adopter);
    await pool.query(`CREATE ROLE "${groupRole}" NOLOGIN NOINHERIT`);roles.push(groupRole);await pool.query(`GRANT "${groupRole}" TO "${adopterRole}"`);await expect(verifyScreenplayProjectAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});await pool.query(`REVOKE "${groupRole}" FROM "${adopterRole}"`);await verifyScreenplayProjectAdoptionRole(adopter);
    await runtime.close();await runtime.close();runtime=undefined;
  }finally{await runtime?.close();await reader?.end();await adopter?.end();await pool.query('DROP VIEW IF EXISTS public.sc_capability_view');await pool.query('DROP TABLE IF EXISTS public.sc_capability_canary');for(const role of roles.reverse()){await pool.query(`DROP OWNED BY "${role}"`);await pool.query(`DROP ROLE "${role}"`);}}
},45000);
it('does not impersonate a lock author and still allows another current reviewer to reject the complete stale source',async()=>{
  const f=await screenplayAdoptionPgFixture(pool),other=await subject(f,'other'),editor=await subject(f,'operator','editor');
  await expect(f.application.prepareScreenplay({subject:editor,projectId:f.scope.projectId,command:f.command})).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.allocations()).toBe(0);
  const reviewer=await subject(f),candidate=await f.application.prepareScreenplay({subject:reviewer,projectId:f.scope.projectId,command:f.command}),read=await f.application.candidate({subject:other,projectId:f.scope.projectId,candidateId:candidate.candidateId});expect(read.canAdopt).toBe(false);expect(read.canReject).toBe(true);expect(read.blockingReasons).toContain('LOCK_AUTHOR_REQUIRED');
  await f.outline.putBrief({...f.put,expectedRevision:1,notes:'来源已由明确的新修订替换。'});const stale=await f.application.candidate({subject:reviewer,projectId:f.scope.projectId,candidateId:candidate.candidateId});expect(stale.canAdopt).toBe(false);expect(stale.canReject).toBe(true);
  expect((await f.application.rejectCandidate({subject:other,projectId:f.scope.projectId,candidateId:candidate.candidateId,requestId:'reject-stale',command:{expectedSnapshotRevision:stale.snapshotRevision,expectedWriteVersion:stale.writeVersion,reason:'核对来源后明确拒绝'}})).status).toBe('rejected');
},45000);

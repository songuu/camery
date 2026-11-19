import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient,QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {makeContinuityPackage} from '../../ir/test/continuity-ledger-fixture.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {migrateContinuity,migrateContinuityNative,grantContinuityRuntimeRole,verifyContinuityRuntimeRole,grantContinuityAdoptionRole,verifyContinuityAdoptionRole,PostgresContinuityStore,resolveContinuityNativePredecessor,prepareContinuityNativeMapping,createContinuityNativeSubmissionReceipt,createContinuityNativeAdoptionHooks,readContinuityNativeAdoption} from '../src/continuity/node/index.js';
import type {ContinuityReviewHost} from '../src/continuity/node/index.js';
import type {ContinuityDraft} from '../src/continuity/contracts.js';
import {testDatabaseConnections} from './postgres-disconnect-support.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for native continuity adoption');
const suffix=randomBytes(8).toString('hex'),database='camery_continuity_native_'+suffix,reviewerRole='continuity_review_'+suffix,adopterRole='continuity_adopt_'+suffix;
const admin=new Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000}),connections=testDatabaseConnections(),address=new URL(databaseUrl);address.pathname='/'+database;
const installer=connections.createPool({connectionString:address.toString(),max:4,connectionTimeoutMillis:5000}),roles:string[]=[];let reviewer:Pool,adopter:Pool,adopterConnectionString='',created=false;
beforeAll(async()=>{
  if(!/^camery_continuity_native_[a-f0-9]{16}$/.test(database))throw new Error('Unowned native continuity database');await admin.query(`CREATE DATABASE "${database}"`);created=true;
  await migrateVersioning(installer);await migrateContinuity(installer);await migrateContinuityNative(installer);
  const reviewPassword=randomBytes(24).toString('hex'),adoptPassword=randomBytes(24).toString('hex');
  await installer.query(`CREATE ROLE ${reviewerRole} LOGIN PASSWORD '${reviewPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);roles.push(reviewerRole);
  await installer.query(`CREATE ROLE ${adopterRole} LOGIN PASSWORD '${adoptPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);roles.push(adopterRole);
  await grantContinuityRuntimeRole(installer,reviewerRole,{nativeProofs:true});await grantContinuityAdoptionRole(installer,adopterRole);
  const reviewUrl=new URL(address);reviewUrl.username=reviewerRole;reviewUrl.password=reviewPassword;reviewer=connections.createPool({connectionString:reviewUrl.href,max:4,connectionTimeoutMillis:5000});
  const adoptUrl=new URL(address);adoptUrl.username=adopterRole;adoptUrl.password=adoptPassword;adopterConnectionString=adoptUrl.href;adopter=connections.createPool({connectionString:adopterConnectionString,max:4,connectionTimeoutMillis:5000});
  await verifyContinuityRuntimeRole(reviewer,{nativeProofs:true});await verifyContinuityAdoptionRole(adopter);
},30000);
afterAll(async()=>{
  try{await reviewer?.end();await adopter?.end();for(const role of roles){await installer.query(`DROP OWNED BY ${role}`);await installer.query(`DROP ROLE ${role}`);}}
  finally{try{await installer.end();await connections.waitForDisconnects();if(created)await admin.query(`DROP DATABASE "${database}"`);}finally{await admin.end();}}
});
async function fixture(){
  const tag=randomUUID(),head=makeContinuityPackage();head.continuity_snapshots=[];head.project.id=id(tag);const target={tenantId:id('native-tenant-'+tag),projectId:head.project.id};
  const scope={tenantId:'native-'+tag,projectId:'project'},host:ContinuityReviewHost={actor:{kind:'human',id:'reviewer'},scope,at:'2026-11-19T03:30:00.000Z',authorize:()=>true};
  await new PostgresVersionStore(installer).initialize(target,head);const store=new PostgresContinuityStore(reviewer,{previousFor:resolveContinuityNativePredecessor}),versions=new PostgresVersionStore(adopter),actor={kind:'user' as const,id:id('native-adopter-'+tag)};
  const source=await store.describeSource({scope,target,episodeId:head.episodes[0]!.id},host),event=source.context.events.find(row=>row.ref.id===id('b_open'))!;
  const evidence={event:event.ref,quote:event.text},draft:ContinuityDraft={version:1,episodeId:head.episodes[0]!.id,events:[{id:'fact',op:'assert_fact',factId:'note',kind:'fact',text:'原始便签事实。',evidence},{id:'learn',op:'learn',characterId:id('char_lin'),factId:'note',source:{kind:'witness'},evidence},{id:'state',op:'set_character',value:{characterId:id('char_lin'),summary:'继续核对。',appearance:null,spot:null,holding:[]},evidence},{id:'plant',op:'plant',threadId:'origin',summary:'追查便签来源。',payoffEpisodeId:head.episodes[1]!.id,evidence}]};
  async function prepare(episodeDraft=draft,candidateId='first',snapshotId=id(tag+'-snapshot')){
    const view=await store.describeSource({scope,target,episodeId:episodeDraft.episodeId},host),key={...scope,candidateId},candidate=await store.prepare({key,target,expectedSnapshotRevision:view.source.snapshotRevision,expectedPackageDigest:view.source.packageDigest,draft:episodeDraft},host);
    const edited=structuredClone(episodeDraft);if(candidateId==='first'){const first=edited.events[0]!;if(first.op!=='assert_fact')throw new Error('Expected fixture fact');first.text='人类逐项核对后的完整便签事实。';}
    const waivers=candidate.preparation.candidate.issues.filter(row=>row.severity==='warning').map(row=>({code:row.code,path:row.path,reason:'核对到期伏笔后明确保留。'}));
    const progress=await store.confirm(key,{candidateDigest:candidate.preparation.candidate.digest,draft:edited,waivers},host),native=(await versions.read(target))!,mapping=prepareContinuityNativeMapping({head:native.state.head,progress,changeId:id(tag+'-'+candidateId+'-change'),snapshotId,operationId:id(tag+'-'+candidateId+'-op'),author:actor}),expectation={expectedSnapshotRevision:native.state.head.revision.number,expectedWriteVersion:native.writeVersion};
    const pending=await versions.submitWithReceipt(target,mapping.request,{expectation},createContinuityNativeSubmissionReceipt({mapping,expectation},store,host));expect(pending.status).toBe('candidate');
    return {mapping,expectation:{expectedSnapshotRevision:pending.state.head.revision.number,expectedWriteVersion:pending.writeVersion}};
  }
  async function adopt(prepared:Awaited<ReturnType<typeof prepare>>,nativeStore=versions,allowed=true){
    const {mapping,expectation}=prepared,hooks=createContinuityNativeAdoptionHooks({mapping,expectation,actorId:actor.id},store,host);
    return nativeStore.adoptGuarded(target,mapping.binding.changeId,{actor,scope:{kind:'episode',id:mapping.binding.episodeId},at:host.at,authorize:()=>allowed,expectation},hooks.guard,hooks.receipt);
  }
  const counts=async()=>Promise.all(['camery_versioning.snapshots','camery_versioning.object_revisions','camery_versioning.adoptions','camery_continuity.native_bindings','camery_continuity.native_adoptions'].map(async table=>Number((await installer.query(`SELECT count(*)::text n FROM ${table} WHERE ${table.startsWith('camery_continuity.')?'formal_tenant_id':'tenant_id'}=$1 AND ${table.startsWith('camery_continuity.')?'formal_project_id':'project_id'}=$2`,[target.tenantId,target.projectId])).rows[0].n)));
  return {head,target,scope,host,store,versions,actor,draft,prepare,adopt,counts};
}
function observed(pool:Pool,after:(text:string,client:PoolClient)=>void|Promise<void>):Pool{return new Proxy(pool,{get(target,key){if(key==='connect')return async()=>{const client=await target.connect();return new Proxy(client,{get(connection,property){if(property==='query')return async(input:string|QueryConfig,values?:unknown[])=>{const result=await connection.query(input,values);await after(typeof input==='string'?input:input.text,connection);return result;};const value:unknown=Reflect.get(connection,property);return typeof value==='function'?value.bind(connection):value;}});};const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}

it('adopts complete human-edited ledgers under an independent minimal LOGIN and passes real adopted constraints into the next episode',async()=>{
  const f=await fixture(),first=await f.prepare(),adopted=await f.adopt(first);expect(adopted.status).toBe('adopted');if(adopted.state.head.schema_version!=='0.8.0-draft')throw new Error('Expected v08');
  expect(adopted.state.head.continuity_snapshots[0]).toEqual(first.mapping.snapshot);expect(first.mapping.snapshot.ledger.facts[0]!.text).toBe('人类逐项核对后的完整便签事实。');
  const secondView=await f.store.describeSource({scope:f.scope,target:f.target,episodeId:f.head.episodes[1]!.id},f.host);expect(secondView.previous?.version).toBe(2);expect(secondView.previous?.ledger).toEqual(first.mapping.snapshot.ledger);
  const event=secondView.context.events.find(row=>row.episodeId===f.head.episodes[1]!.id)!,second=await f.prepare({version:1,episodeId:f.head.episodes[1]!.id,events:[{id:'payoff',op:'payoff',threadId:'origin',evidence:{event:event.ref,quote:event.text}}]},'second',id(randomUUID()));
  const next=await f.adopt(second);expect(next.status).toBe('adopted');expect(second.mapping.snapshot.ledger.threads[0]!.paidOff?.episodeId).toBe(f.head.episodes[1]!.id);expect(second.mapping.snapshot.ledger.facts).toEqual(first.mapping.snapshot.ledger.facts);
  const client=await reviewer.connect();try{const historical=await readContinuityNativeAdoption(client,{scope:f.scope,target:f.target,changeId:first.mapping.binding.changeId});expect(historical.ledger).toEqual(first.mapping.snapshot.ledger);}finally{client.release();}
  const before=await f.counts();expect((await f.adopt(first)).status).toBe('adopted');expect(await f.counts()).toEqual(before);expect((await f.adopt(first,f.versions,false)).issues.map(row=>row.code)).toContain('ADOPTION_AUTHORITY');expect(await f.counts()).toEqual(before);
},45000);
it('rolls back native head, object/adoption audit and complete proof after an actual proof INSERT failure',async()=>{
  const f=await fixture(),prepared=await f.prepare(),before=await f.versions.read(f.target),counts=await f.counts();let fail=true;
  const broken=new PostgresVersionStore(observed(adopter,text=>{if(fail&&text.startsWith('INSERT INTO camery_continuity.native_adoptions')){fail=false;throw new Error('Synthetic proof failure after actual INSERT');}}));
  await expect(f.adopt(prepared,broken)).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await f.versions.read(f.target)).toEqual(before);expect(await f.counts()).toEqual(counts);expect((await f.adopt(prepared)).status).toBe('adopted');
},30000);
it('recovers a genuinely committed native adoption and its single proof after losing COMMIT acknowledgement',async()=>{
  const f=await fixture(),prepared=await f.prepare();let lose=true;
  const uncertain=new PostgresVersionStore(observed(adopter,text=>{if(lose&&text==='COMMIT'){lose=false;throw new Error('Synthetic committed adoption ACK loss');}}));
  await expect(f.adopt(prepared,uncertain)).rejects.toMatchObject({code:'DATABASE_ERROR'});const committed=await f.counts();expect(committed.at(-1)).toBe(1);
  const replacement=connections.createPool({connectionString:adopterConnectionString,max:1,connectionTimeoutMillis:5000});try{await verifyContinuityAdoptionRole(replacement);const restored=await f.adopt(prepared,new PostgresVersionStore(replacement));expect(restored.status).toBe('adopted');expect(await f.counts()).toEqual(committed);}finally{await replacement.end();}
},30000);
it('serializes concurrent native adopters and rejects a stale later ledger after an earlier ledger revision',async()=>{
  const f=await fixture(),first=await f.prepare(),results=await Promise.all(Array.from({length:8},()=>f.adopt(first)));expect(results.every(row=>row.status==='adopted')).toBe(true);expect((await f.counts()).slice(-2)).toEqual([1,1]);
  const second=await f.prepare({version:1,episodeId:f.head.episodes[1]!.id,events:[]},'second',id(randomUUID()));expect((await f.adopt(second)).status).toBe('adopted');
  const changed=structuredClone(f.draft),fact=changed.events[0]!;if(fact.op!=='assert_fact')throw new Error('Expected fixture fact');fact.text='第一集再次明确核对的新事实。';
  expect((await f.adopt(await f.prepare(changed,'first-revised',first.mapping.snapshot.id))).status).toBe('adopted');
  const client=await reviewer.connect();try{expect((await readContinuityNativeAdoption(client,{scope:f.scope,target:f.target,changeId:second.mapping.binding.changeId})).ledger).toEqual(second.mapping.snapshot.ledger);
    await expect(resolveContinuityNativePredecessor(client,{scope:f.scope,target:f.target,episodeId:f.head.episodes[1]!.id})).rejects.toMatchObject({code:'CONFLICT'});
  }finally{client.release();}
},45000);
it('enforces actual role separation and detects extra column authority and grant options',async()=>{
  await expect(verifyContinuityRuntimeRole(reviewer)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  for(const [pool,role,sql,revoke] of [[reviewer,reviewerRole,'UPDATE(head_revision) ON camery_versioning.projects','UPDATE(head_revision) ON camery_versioning.projects'],[adopter,adopterRole,'INSERT ON camery_continuity.reviews','INSERT ON camery_continuity.reviews'],[adopter,adopterRole,'UPDATE(head_revision) ON camery_versioning.projects WITH GRANT OPTION','GRANT OPTION FOR UPDATE(head_revision) ON camery_versioning.projects']] as const){
    await installer.query(`GRANT ${sql.replace(' WITH GRANT OPTION','')} TO ${role}${sql.endsWith(' WITH GRANT OPTION')?' WITH GRANT OPTION':''}`);
    try{await expect(pool===reviewer?verifyContinuityRuntimeRole(pool,{nativeProofs:true}):verifyContinuityAdoptionRole(pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await installer.query(`REVOKE ${revoke} FROM ${role}`);}
  }
  await verifyContinuityRuntimeRole(reviewer,{nativeProofs:true});await verifyContinuityAdoptionRole(adopter);
  await expect(reviewer.query('UPDATE camery_versioning.projects SET head_revision=head_revision')).rejects.toMatchObject({code:'42501'});await expect(adopter.query('UPDATE camery_continuity.reviews SET digest=digest')).rejects.toMatchObject({code:'42501'});
  await expect(adopter.query('UPDATE camery_continuity.native_adoptions SET digest=digest')).rejects.toMatchObject({code:'42501'});
});
it('rejects extra table authority even when public ACL functions shadow catalog names in an explicit search_path',async()=>{
  const canary='native_acl_'+randomBytes(8).toString('hex');await installer.query(`CREATE TABLE public.${canary}(secret text)`);await installer.query(`GRANT SELECT ON public.${canary} TO ${adopterRole}`);
  const replacement=connections.createPool({connectionString:adopterConnectionString,max:1,options:'-c search_path=public,pg_catalog'});
  try{
    await installer.query(`CREATE FUNCTION public.has_table_privilege(oid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT CASE WHEN $1='public.${canary}'::regclass THEN false ELSE pg_catalog.has_table_privilege($1,$2) END $$`);
    await installer.query(`CREATE FUNCTION public.has_column_privilege(oid,smallint,text) RETURNS boolean LANGUAGE sql AS $$ SELECT CASE WHEN $1='public.${canary}'::regclass THEN false ELSE pg_catalog.has_column_privilege($1,$2,$3) END $$`);
    await expect(verifyContinuityAdoptionRole(replacement)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }finally{
    await replacement.end();await installer.query('DROP FUNCTION IF EXISTS public.has_column_privilege(oid,smallint,text)');await installer.query('DROP FUNCTION IF EXISTS public.has_table_privilege(oid,text)');await installer.query(`DROP TABLE public.${canary}`);
  }
  await verifyContinuityAdoptionRole(adopter);
});
it('rejects catalog-last paths even when a public operator hides catalog namespace scans',async()=>{
  const canary='native_operator_acl_'+randomBytes(8).toString('hex');await installer.query(`CREATE TABLE public.${canary}(secret text)`);await installer.query(`GRANT SELECT ON public.${canary} TO ${adopterRole}`);
  const replacement=connections.createPool({connectionString:adopterConnectionString,max:1,options:'-c search_path=public,pg_catalog'});
  try{
    await installer.query('CREATE FUNCTION public.native_hide_catalog(name,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$');
    await installer.query('CREATE OPERATOR public.!~ (LEFTARG=pg_catalog.name,RIGHTARG=pg_catalog.text,PROCEDURE=public.native_hide_catalog)');
    await expect(verifyContinuityAdoptionRole(replacement)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }finally{
    await replacement.end();await installer.query('DROP OPERATOR IF EXISTS public.!~ (pg_catalog.name,pg_catalog.text)');await installer.query('DROP FUNCTION IF EXISTS public.native_hide_catalog(pg_catalog.name,pg_catalog.text)');await installer.query(`DROP TABLE public.${canary}`);
  }
  await verifyContinuityAdoptionRole(adopter);
});
it('rejects extra sequence USAGE despite a more exact public regclass/oid equality operator',async()=>{
  const name='native_extra_seq_'+randomBytes(8).toString('hex');await installer.query(`CREATE SEQUENCE public.${name}`);await installer.query(`GRANT USAGE ON SEQUENCE public.${name} TO ${adopterRole}`);
  try{
    await installer.query('CREATE FUNCTION public.native_match_sequence(regclass,oid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$');
    await installer.query('CREATE OPERATOR public.= (LEFTARG=pg_catalog.regclass,RIGHTARG=pg_catalog.oid,PROCEDURE=public.native_match_sequence)');
    await expect(verifyContinuityAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }finally{await installer.query('DROP OPERATOR IF EXISTS public.= (pg_catalog.regclass,pg_catalog.oid)');await installer.query('DROP FUNCTION IF EXISTS public.native_match_sequence(pg_catalog.regclass,pg_catalog.oid)');await installer.query(`DROP SEQUENCE public.${name}`);}
  await verifyContinuityAdoptionRole(adopter);
});
it('rejects extra table authority despite an exact name/name public regex operator on the default search_path',async()=>{
  const name='native_exact_acl_'+randomBytes(8).toString('hex');await installer.query(`CREATE TABLE public.${name}(secret text)`);await installer.query(`GRANT SELECT ON public.${name} TO ${adopterRole}`);
  try{
    await installer.query('CREATE FUNCTION public.native_hide_exact_catalog(name,name) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$');
    await installer.query('CREATE OPERATOR public.!~ (LEFTARG=pg_catalog.name,RIGHTARG=pg_catalog.name,PROCEDURE=public.native_hide_exact_catalog)');
    await expect(verifyContinuityAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }finally{await installer.query('DROP OPERATOR IF EXISTS public.!~ (pg_catalog.name,pg_catalog.name)');await installer.query('DROP FUNCTION IF EXISTS public.native_hide_exact_catalog(pg_catalog.name,pg_catalog.name)');await installer.query(`DROP TABLE public.${name}`);}
  await verifyContinuityAdoptionRole(adopter);
});
it('pins installer catalog lookup in its own transaction without leaking search_path into the pool',async()=>{
  const shadow=connections.createPool({connectionString:address.toString(),max:1,options:'-c search_path=public,pg_catalog'});
  try{
    await installer.query("CREATE FUNCTION public.hashtextextended(text,integer) RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic installer shadow invoked'; END $$");
    await expect(shadow.query("SELECT public.hashtextextended('probe',0)")).rejects.toThrow('synthetic installer shadow invoked');
    await migrateContinuity(shadow);await migrateContinuityNative(shadow);expect(String((await shadow.query('SHOW search_path')).rows[0].search_path).replaceAll(' ','')).toBe('public,pg_catalog');
  }finally{await shadow.end();await installer.query('DROP FUNCTION IF EXISTS public.hashtextextended(pg_catalog.text,pg_catalog.int4)');}
});
it('rejects extra sequence grant options, role membership and executable security-definer capability',async()=>{
  await installer.query(`GRANT USAGE ON SEQUENCE camery_versioning.changes_sequence_seq TO ${adopterRole} WITH GRANT OPTION`);
  try{await expect(verifyContinuityAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await installer.query(`REVOKE GRANT OPTION FOR USAGE ON SEQUENCE camery_versioning.changes_sequence_seq FROM ${adopterRole}`);}
  await installer.query(`GRANT ${reviewerRole} TO ${adopterRole}`);try{await expect(verifyContinuityAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await installer.query(`REVOKE ${reviewerRole} FROM ${adopterRole}`);}
  await installer.query('CREATE FUNCTION public.native_definer_probe() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$');
  try{await expect(verifyContinuityAdoptionRole(adopter)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(verifyContinuityRuntimeRole(reviewer,{nativeProofs:true})).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await installer.query('DROP FUNCTION public.native_definer_probe()');}
  await verifyContinuityAdoptionRole(adopter);await verifyContinuityRuntimeRole(reviewer,{nativeProofs:true});
});

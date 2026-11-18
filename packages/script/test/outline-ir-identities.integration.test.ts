import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateBible} from '@camery/bible/node';
import {upgradeV05Package,upgradeV06Package,validatePackage} from '@camery/ir';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import type {VersionProjectKey} from '@camery/versioning/node';
import {migrateIngest} from '../../ingest/src/node/index.js';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {migrateDevelopment,PostgresDevelopmentIrIdentities,grantDevelopmentRuntimeRole,verifyDevelopmentRuntimeRole} from '../src/node/index.js';
import {PostgresOutlineStore} from '../src/outline/node/store.js';
import {migrateOutline} from '../src/outline/node/migrate.js';
import {grantOutlineRuntimeRole,verifyOutlineRuntimeRole} from '../src/outline/node/runtime-role.js';
import {migrateOutlineIdentities} from '../src/outline/node/identity-migrate.js';
import {PostgresOutlineIrIdentities} from '../src/outline/node/ir-identities.js';
import {prepareOutlineMappingDraft,finalizeOutlineChangeSet} from '../src/outline/node/formal-mapping.js';
import {createOutlineSourceGuard} from '../src/outline/node/formal-source.js';
import {readOutlineFormalProjection} from '../src/outline/node/formal-projection.js';
import {selectedOutlineProjection} from './outline-formal-mapping-support.js';
import {createDevelopmentSourceFixture} from './outline-source-pg-support.js';
import {outlineIdentityPgFixture} from './outline-ir-identities-pg-support.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for persistent Outline identity tests');
const pool=new Pool({connectionString:databaseUrl,max:10,connectionTimeoutMillis:5000}),owned:string[]=[],formalProjects:VersionProjectKey[]=[];
const allocate=()=>id(randomUUID());
const columns='tenant_id,project_id,kind,owner_key,owner_run_id,outline_owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id';
let oldLedgers:{script:unknown[];outline:unknown[]};
const rows=async(tenantId:string)=>(await pool.query(`SELECT ${columns} FROM camery_script.ir_identities WHERE tenant_id=$1 ORDER BY kind,owner_key,local_key`,[tenantId])).rows;
const preparations=async(tenantId:string)=>(await pool.query('SELECT * FROM camery_outline.identity_preparations WHERE tenant_id=$1 ORDER BY run_id',[tenantId])).rows;

beforeAll(async()=>{
  await migrateIngest(pool);await migrateBible(pool);await migrateDevelopment(pool);await migrateOutline(pool);await migrateVersioning(pool);
  oldLedgers={script:(await pool.query('SELECT version,checksum FROM camery_script.migrations ORDER BY version')).rows,outline:(await pool.query('SELECT version,checksum FROM camery_outline.migrations ORDER BY version')).rows};
  await migrateOutlineIdentities(pool);await migrateOutlineIdentities(pool);
});
afterAll(async()=>{
  let failed=false;
  try{
    for(const key of formalProjects){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}
    for(const tenant of owned)for(const [schema,tables] of [['camery_outline',['identity_preparations']],['camery_script',['ir_identities']],['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']]] as const)for(const table of tables)try{await pool.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
  }finally{await pool.end();}
  if(failed)throw new Error('Persistent Outline identity cleanup failed');
});

it('installs its own ledger idempotently while retaining old ledgers and the original stable-ID constraint',async()=>{
  expect((await pool.query('SELECT version,checksum FROM camery_script.migrations ORDER BY version')).rows).toEqual(oldLedgers.script);
  expect((await pool.query('SELECT version,checksum FROM camery_outline.migrations ORDER BY version')).rows).toEqual(oldLedgers.outline);
  expect((await pool.query('SELECT version,checksum FROM camery_outline.identity_migrations ORDER BY version')).rows).toEqual([expect.objectContaining({version:1,checksum:expect.stringMatching(/^[a-f0-9]{64}$/)})]);
  const constraint=(await pool.query<{definition:string}>("SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='camery_script.ir_identities'::regclass AND conname='ir_identities_check'")).rows;
  expect(constraint).toHaveLength(1);expect(constraint[0]!.definition).toContain('stable_id <> ir_project_id');
});
it('creates one atomic complete identity bundle across eight concurrent prepares and a new pool without new IDs',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned);let allocated=0;const store=new PostgresOutlineIrIdentities(pool,f.store,()=>{allocated++;return allocate();}),input={source:f.source,target:f.target};
  const bundles=await Promise.all(Array.from({length:8},()=>store.prepare(input)));expect(bundles.every(row=>JSON.stringify(row.identities)===JSON.stringify(bundles[0]!.identities))).toBe(true);
  expect(allocated).toBe((await rows(f.scope.tenantId)).length);expect(await preparations(f.scope.tenantId)).toHaveLength(1);expect(f.calls()).toBe(1);
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const restored=await new PostgresOutlineIrIdentities(reopened,new PostgresOutlineStore(reopened),()=>{throw new Error('Persisted Outline identity was reallocated');}).prepare(input);expect(restored.identities).toEqual(bundles[0]!.identities);expect(restored.progress).toEqual(bundles[0]!.progress);}finally{await reopened.end();}
});
it('uses the exact existing Development project episode IDs and keeps its old nine-field rows unchanged',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned);if(!('put' in f.upstream))throw new Error('Expected Development source');const {kind:_kind,...source}=f.upstream.descriptor;
  const development=await new PostgresDevelopmentIrIdentities(pool,f.upstream.store,allocate).prepare({source,target:f.target});
  const before=(await pool.query('SELECT tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id FROM camery_script.ir_identities WHERE tenant_id=$1 ORDER BY kind,local_key',[f.scope.tenantId])).rows;
  const outline=await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare({source:f.source,target:f.target});
  expect(outline.identities.episodes.map(row=>row.episodeId)).toEqual(development.identities.episodes.map(row=>row.episodeId));expect(outline.identities.episodes.map(row=>row.planId)).not.toEqual(development.identities.episodes.map(row=>row.planId));
  expect((await pool.query("SELECT tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind IN ('development_plan','world','character','relationship','episode','episode_plan') ORDER BY kind,local_key",[f.scope.tenantId])).rows).toEqual(before);
});
it('reserves shared episode pairs for Bible-first adoption and accepts a later longer Development tail without reallocating the Outline',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned,{kind:'bible',count:2}),store=new PostgresOutlineIrIdentities(pool,f.store,allocate),first=await store.prepare({source:f.source,target:f.target});
  const upstream=await createDevelopmentSourceFixture(pool,f.scope),{kind:_kind,...source}=upstream.descriptor;
  const development=await new PostgresDevelopmentIrIdentities(pool,upstream.store,allocate).prepare({source,target:f.target});expect(development.identities.episodes).toHaveLength(3);expect(development.identities.episodes.slice(0,2).map(row=>row.episodeId)).toEqual(first.identities.episodes.map(row=>row.episodeId));
  const restored=await new PostgresOutlineIrIdentities(pool,f.store,()=>{throw new Error('Valid longer shared tail caused reallocation');}).prepare({source:f.source,target:f.target});expect(restored.identities).toEqual(first.identities);expect(restored.identities.episodes).toHaveLength(2);
});
it('extends complete pairs for a new reviewed run then preserves every project slot when a later run shrinks',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned),store=new PostgresOutlineIrIdentities(pool,f.store,allocate),first=await store.prepare({source:f.source,target:f.target});
  const larger=await f.next('five-episodes',5),second=await store.prepare({source:larger.source,target:f.target});expect(second.identities.episodes).toHaveLength(5);expect(second.identities.episodes.slice(0,3)).toEqual(first.identities.episodes);expect(second.identities.planId).toBe(first.identities.planId);expect(second.identities.characters[0]!.id).not.toBe(first.identities.characters[0]!.id);
  const smaller=await f.next('two-episodes',2),third=await store.prepare({source:smaller.source,target:f.target});expect(third.identities.episodes).toEqual(second.identities.episodes);expect(third.progress.run.brief.episodeCount).toBe(2);expect(await preparations(f.scope.tenantId)).toHaveLength(3);expect(f.calls()).toBe(3);
});
it.each(['character','all-source','outline-tail','shared-tail','adaptation-anchor','development-anchor'] as const)('refuses actual committed %s damage before allocating any replacement identity',async damage=>{
  const f=await outlineIdentityPgFixture(pool,owned),input={source:f.source,target:f.target};await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare(input);
  const condition=damage==='character'?"kind='outline_character'":damage==='all-source'?"kind IN ('outline_character','outline_beat','outline_asset','outline_plot_unit','outline_decision')":damage==='outline-tail'?"kind='outline_episode_plan' AND local_key='3'":damage==='shared-tail'?"kind IN ('episode','episode_plan') AND local_key='3'":damage==='adaptation-anchor'?"kind='adaptation_plan'":"kind='development_plan'";
  const deleted=await pool.query(`DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND ${condition} RETURNING stable_id`,[f.scope.tenantId]);expect(deleted.rows.length).toBeGreaterThan(0);const before=await rows(f.scope.tenantId),proof=await preparations(f.scope.tenantId);let allocated=0;
  await expect(new PostgresOutlineIrIdentities(pool,f.store,()=>{allocated++;return allocate();}).prepare(input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(allocated).toBe(0);expect(await rows(f.scope.tenantId)).toEqual(before);expect(await preparations(f.scope.tenantId)).toEqual(proof);
});
it('refuses to conceal a previous Outline run missing its paired tail when a new reviewed run expands the season',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned);await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare({source:f.source,target:f.target});
  const deleted=await pool.query("DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind IN ('episode','episode_plan','outline_episode_plan') AND local_key='3' RETURNING stable_id",[f.scope.tenantId]);expect(deleted.rows).toHaveLength(3);
  const next=await f.next('five-after-missing-tail',5),before=await rows(f.scope.tenantId),proof=await preparations(f.scope.tenantId);expect(proof).toHaveLength(1);let allocated=0;
  await expect(new PostgresOutlineIrIdentities(pool,f.store,()=>{allocated++;return allocate();}).prepare({source:next.source,target:f.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(allocated).toBe(0);expect(await rows(f.scope.tenantId)).toEqual(before);expect(await preparations(f.scope.tenantId)).toEqual(proof);
});
it('rejects a new reviewed Outline run when an earlier owner retains identities but loses its witness and paired tail',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned);await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare({source:f.source,target:f.target});
  const proofDeleted=await pool.query('DELETE FROM camery_outline.identity_preparations WHERE tenant_id=$1 AND run_id=$2 RETURNING run_id',[f.scope.tenantId,f.run.runId]);expect(proofDeleted.rows).toHaveLength(1);
  const tailDeleted=await pool.query("DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind IN ('episode','episode_plan','outline_episode_plan') AND local_key='3' RETURNING stable_id",[f.scope.tenantId]);expect(tailDeleted.rows).toHaveLength(3);
  const next=await f.next('five-after-missing-owner-witness',5),before=await rows(f.scope.tenantId),proof=await preparations(f.scope.tenantId);expect(before.some(row=>row.owner_key===f.run.runId&&row.kind==='outline_character')).toBe(true);expect(proof).toEqual([]);let allocated=0;
  await expect(new PostgresOutlineIrIdentities(pool,f.store,()=>{allocated++;return allocate();}).prepare({source:next.source,target:f.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(allocated).toBe(0);expect(await rows(f.scope.tenantId)).toEqual(before);expect(await preparations(f.scope.tenantId)).toEqual(proof);
});
it('rejects a new Development owner after an earlier Bible-first Outline preparation loses its complete episode tail',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned,{kind:'bible'});await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare({source:f.source,target:f.target});
  const deleted=await pool.query("DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind IN ('episode','episode_plan','outline_episode_plan') AND local_key='3' RETURNING stable_id",[f.scope.tenantId]);expect(deleted.rows).toHaveLength(3);
  const development=await createDevelopmentSourceFixture(pool,f.scope),{kind:_kind,...source}=development.descriptor,before=await rows(f.scope.tenantId),proof=await preparations(f.scope.tenantId);expect(proof).toHaveLength(1);let allocated=0;
  await expect(new PostgresDevelopmentIrIdentities(pool,development.store,()=>{allocated++;return allocate();}).prepare({source,target:f.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(allocated).toBe(0);expect(await rows(f.scope.tenantId)).toEqual(before);expect(await preparations(f.scope.tenantId)).toEqual(proof);
});
it.each(['tail','world-and-tail'] as const)('rejects first Outline preparation after an already prepared Development owner loses %s',async damage=>{
  const f=await outlineIdentityPgFixture(pool,owned);if(!('put' in f.upstream))throw new Error('Development source expected');const {kind:_kind,...source}=f.upstream.descriptor;
  await new PostgresDevelopmentIrIdentities(pool,f.upstream.store,allocate).prepare({source,target:f.target});expect(await preparations(f.scope.tenantId)).toEqual([]);
  const deleted=await pool.query("DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind IN ('episode','episode_plan') AND local_key='3' RETURNING stable_id",[f.scope.tenantId]);expect(deleted.rows).toHaveLength(2);
  if(damage==='world-and-tail'){const world=await pool.query("DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind='world' RETURNING stable_id",[f.scope.tenantId]);expect(world.rows).toHaveLength(1);expect((await rows(f.scope.tenantId)).filter(row=>row.kind==='character').length).toBeGreaterThan(0);}
  const next=await f.next('outline-after-development-tail-loss',3),before=await rows(f.scope.tenantId);let allocated=0;
  await expect(new PostgresOutlineIrIdentities(pool,f.store,()=>{allocated++;return allocate();}).prepare({source:next.source,target:f.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  expect(allocated).toBe(0);expect(await rows(f.scope.tenantId)).toEqual(before);expect(await preparations(f.scope.tenantId)).toEqual([]);
});
it.each(['missing','digest','review'] as const)('refuses a %s preparation witness without replacing the committed bundle',async damage=>{
  const f=await outlineIdentityPgFixture(pool,owned),input={source:f.source,target:f.target};await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare(input);
  if(damage==='missing')await pool.query('DELETE FROM camery_outline.identity_preparations WHERE tenant_id=$1',[f.scope.tenantId]);else await pool.query(`UPDATE camery_outline.identity_preparations SET ${damage==='digest'?'registry_digest':'review_digest'}=$2 WHERE tenant_id=$1`,[f.scope.tenantId,'f'.repeat(64)]);
  const before=await rows(f.scope.tenantId);let allocated=0;await expect(new PostgresOutlineIrIdentities(pool,f.store,()=>{allocated++;return allocate();}).prepare(input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(allocated).toBe(0);expect(await rows(f.scope.tenantId)).toEqual(before);
});
it('refuses a different formal target and changed or unreviewed actual sources without allocating IDs',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned),store=new PostgresOutlineIrIdentities(pool,f.store,allocate);await store.prepare({source:f.source,target:f.target});const before=await rows(f.scope.tenantId);
  await expect(store.prepare({source:f.source,target:{...f.target,projectId:allocate()}})).rejects.toMatchObject({code:'CONFLICT'});expect(await rows(f.scope.tenantId)).toEqual(before);
  const unreviewed=await outlineIdentityPgFixture(pool,owned,{review:false});let allocated=0;await expect(new PostgresOutlineIrIdentities(pool,unreviewed.store,()=>{allocated++;return allocate();}).prepare({source:unreviewed.source,target:unreviewed.target})).rejects.toMatchObject({code:'INCOMPLETE'});expect(await rows(unreviewed.scope.tenantId)).toEqual([]);expect(allocated).toBe(0);
  const stale=await outlineIdentityPgFixture(pool,owned);await stale.store.putBrief({...stale.put,expectedRevision:1,notes:'新的大纲要求。'});await expect(new PostgresOutlineIrIdentities(pool,stale.store,()=>{allocated++;return allocate();}).prepare({source:stale.source,target:stale.target})).rejects.toMatchObject({code:'CONFLICT'});expect(await rows(stale.scope.tenantId)).toEqual([]);expect(allocated).toBe(0);
});
it.each(['development','bible'] as const)('refuses a changed actual %s upstream before creating metadata or a preparation witness',async kind=>{
  const f=await outlineIdentityPgFixture(pool,owned,{kind});
  if('put' in f.upstream)await f.upstream.store.putBrief({...f.upstream.put,expectedRevision:1,idea:'身份准备前已有新开发目标。'});
  else await f.upstream.documents.append({...f.scope,documentId:'book',batchId:'later',expectedRevision:1,text:'身份准备前追加的文档内容。'});
  let allocated=0;await expect(new PostgresOutlineIrIdentities(pool,f.store,()=>{allocated++;return allocate();}).prepare({source:f.source,target:f.target})).rejects.toMatchObject({code:'CONFLICT'});expect(allocated).toBe(0);expect(await rows(f.scope.tenantId)).toEqual([]);expect(await preparations(f.scope.tenantId)).toEqual([]);expect(f.calls()).toBe(1);
});
it('recovers the same original metadata and proof after actual COMMIT acknowledgement loss',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned),input={source:f.source,target:f.target};let lost=false;
  const borrowed={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,property){if(property==='query')return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('Committed Outline identity acknowledgement lost');}return result;};const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});}} as unknown as Pool;
  await expect(new PostgresOutlineIrIdentities(borrowed,f.store,allocate).prepare(input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(lost).toBe(true);const before=await rows(f.scope.tenantId),proof=await preparations(f.scope.tenantId);expect(before.length).toBeGreaterThan(10);expect(proof).toHaveLength(1);
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const restored=await new PostgresOutlineIrIdentities(reopened,new PostgresOutlineStore(reopened),()=>{throw new Error('Committed identity was reallocated');}).prepare(input);expect(restored.identities.episodes).toHaveLength(3);expect(await rows(f.scope.tenantId)).toEqual(before);expect(await preparations(f.scope.tenantId)).toEqual(proof);}finally{await reopened.end();}
});
it('rolls back both records after actual backend termination and completes once on a fresh pool',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned),input={source:f.source,target:f.target};let terminated=false,destroyed=false;let pid=0,native:PoolClient|undefined,ownedListener:((...args:unknown[])=>void)|undefined;
  const interrupted={connect:async()=>{const client=await pool.connect();native=client;pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;return new Proxy(client,{get(target,property){
    if(property==='on')return (event:Parameters<typeof client.on>[0],handler:(...args:unknown[])=>void)=>{if(event==='error')ownedListener=handler;return target.on(event,handler);};
    if(property==='query')return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql.startsWith('INSERT INTO camery_script.ir_identities')&&!terminated){expect((await pool.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0]!.terminated).toBe(true);terminated=true;await new Promise<void>(resolve=>{setImmediate(resolve);});}return result;};
    if(property==='release')return (destroy?:boolean)=>{destroyed=destroy===true;target.release(destroy);};const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});}} as unknown as Pool;
  await expect(new PostgresOutlineIrIdentities(interrupted,f.store,allocate).prepare(input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(terminated).toBe(true);expect(destroyed).toBe(true);expect(native!.listeners('error')).not.toContain(ownedListener);expect(await rows(f.scope.tenantId)).toEqual([]);expect(await preparations(f.scope.tenantId)).toEqual([]);
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const restoredStore=new PostgresOutlineIrIdentities(reopened,new PostgresOutlineStore(reopened),allocate),first=await restoredStore.prepare(input);expect((await restoredStore.prepare(input)).identities).toEqual(first.identities);expect(await preparations(f.scope.tenantId)).toHaveLength(1);}finally{await reopened.end();}
});
it('uses one SQL UNIQUE across both allocator directions and keeps Outline and Development owner FKs distinct',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned);if(!('put' in f.upstream))throw new Error('Development source expected');const {kind:_kind,...source}=f.upstream.descriptor;
  const old=await new PostgresDevelopmentIrIdentities(pool,f.upstream.store,allocate).prepare({source,target:f.target});
  await expect(new PostgresOutlineIrIdentities(pool,f.store,()=>old.identities.characters[0]!.id).prepare({source:f.source,target:f.target})).rejects.toMatchObject({code:'CONFLICT'});expect(await preparations(f.scope.tenantId)).toEqual([]);
  const prepared=await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare({source:f.source,target:f.target});
  const fresh=await outlineIdentityPgFixture(pool,owned);if(!('put' in fresh.upstream))throw new Error('Development source expected');const {kind:_freshKind,...freshSource}=fresh.upstream.descriptor;
  await expect(new PostgresDevelopmentIrIdentities(pool,fresh.upstream.store,()=>prepared.identities.beats[0]!.id).prepare({source:freshSource,target:fresh.target})).rejects.toMatchObject({code:'CONFLICT'});expect(await rows(fresh.scope.tenantId)).toEqual([]);
  const sql=`INSERT INTO camery_script.ir_identities(${columns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,base:unknown[]=[f.scope.tenantId,f.scope.projectId,'outline_beat',f.run.runId,null,f.run.runId,'sql-probe',f.target.tenantId,f.target.projectId,allocate()];
  for(const [index,value] of [[4,f.upstream.run.runId],[5,null],[3,'project'],[9,f.target.projectId]] as const){const values=[...base];values[index]=value;await expect(pool.query(sql,values)).rejects.toMatchObject({code:'23514'});}
  const wrongRun=[...base];wrongRun[3]=f.upstream.run.runId;wrongRun[5]=f.upstream.run.runId;await expect(pool.query(sql,wrongRun)).rejects.toMatchObject({code:'23503'});
  const wrongScope=[...base];wrongScope[1]='other-project';await expect(pool.query(sql,wrongScope)).rejects.toMatchObject({code:'23503'});
  const wrongLegacy=[...base];wrongLegacy[2]='character';wrongLegacy[3]=f.upstream.run.runId;wrongLegacy[4]=f.upstream.run.runId;await expect(pool.query(sql,wrongLegacy)).rejects.toMatchObject({code:'23514'});
});
it.each(['development','outline'] as const)('keeps the old %s append-only LOGIN unable to read or write shared identities and preparation witnesses',async kind=>{
  const f=await outlineIdentityPgFixture(pool,owned),suffix=randomBytes(8).toString('hex'),role='outline_identity_old_'+suffix,password=randomBytes(24).toString('hex');let runtime:Pool|undefined;
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
  try{if(kind==='development')await grantDevelopmentRuntimeRole(pool,role);else await grantOutlineRuntimeRole(pool,role);const url=new URL(databaseUrl!);url.username=role;url.password=password;runtime=new Pool({connectionString:url.toString(),max:1});if(kind==='development')await verifyDevelopmentRuntimeRole(runtime);else await verifyOutlineRuntimeRole(runtime);
    for(const table of ['camery_script.ir_identities','camery_outline.identity_preparations']){await expect(runtime.query(`SELECT * FROM ${table} WHERE tenant_id=$1`,[f.scope.tenantId])).rejects.toMatchObject({code:'42501'});await expect(runtime.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE false`)).rejects.toMatchObject({code:'42501'});}
  }finally{await runtime?.end();await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`);}
});
it('persists all cardinalities near 512KiB then adopts the complete graph using only the registered stable IDs',async()=>{
  const f=await outlineIdentityPgFixture(pool,owned,{kind:'bible',count:100,capacity:true}),prepared=await new PostgresOutlineIrIdentities(pool,f.store,allocate).prepare({source:f.source,target:f.target});if(!f.review)throw new Error('Reviewed capacity fixture expected');
  expect(Buffer.byteLength(JSON.stringify(f.review.output))).toBeGreaterThan(490000);expect(Buffer.byteLength(JSON.stringify(f.review.output))).toBeLessThan(524288);expect(await rows(f.scope.tenantId)).toHaveLength(1350);expect(await preparations(f.scope.tenantId)).toHaveLength(1);
  const head=upgradeV06Package(upgradeV05Package(makePackage()));for(const [field,value] of Object.entries(head))if(Array.isArray(value))(head as unknown as Record<string,unknown>)[field]=[];head.project.id=f.target.projectId;head.project.source_ids=[];head.project.rights_status='unknown';head.project.scope={label:'完整大纲身份采用',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};formalProjects.push(f.target);
  const reviewer={key:f.review.actorId,id:id('reviewer-'+f.scope.tenantId)},draft=prepareOutlineMappingDraft({progress:prepared.progress,source:f.source,identities:prepared.identities,reviewer,head});expect(draft.operations).toHaveLength(1249);
  const request=finalizeOutlineChangeSet({draft,changeSetId:allocate(),author:{kind:'user',id:allocate()},operationIds:draft.operations.map(row=>({slot:row.slot,id:allocate()}))}),versions=new PostgresVersionStore(pool);await versions.initialize(f.target,head);const pending=await versions.submit(f.target,request);expect(pending.status).toBe('candidate');expect(pending.issues).toEqual([]);
  const adopted=await versions.adoptGuarded(f.target,request.id,{actor:request.author,scope:{kind:'project',id:head.project.id},authorize:()=>true,at:'2026-11-18T05:10:00.000Z',expectation:{expectedSnapshotRevision:head.revision.number,expectedWriteVersion:pending.writeVersion}},createOutlineSourceGuard(f.store,f.source));expect(adopted.status).toBe('adopted');expect(adopted.issues).toEqual([]);if(adopted.state.head.schema_version!=='0.7.0-draft')throw new Error('Adopted v07 head expected');
  const {projection,binding}=selectedOutlineProjection(adopted.state.head,prepared.identities);expect(readOutlineFormalProjection(projection,binding)).toEqual(f.review.output);expect(validatePackage(adopted.state.head).valid).toBe(true);expect(f.calls()).toBe(1);
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const restored=await new PostgresOutlineIrIdentities(reopened,new PostgresOutlineStore(reopened),()=>{throw new Error('Full capacity identity reallocated');}).prepare({source:f.source,target:f.target});expect(restored.identities).toEqual(prepared.identities);expect((await new PostgresVersionStore(reopened).read(f.target))!.state.head).toEqual(adopted.state.head);}finally{await reopened.end();}
});

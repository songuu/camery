import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient} from 'pg';
import {beforeAll,afterAll,expect,it} from 'vitest';
import {PostgresDevelopmentIrIdentities} from '../src/node/ir-identities.js';
import {migrateDevelopment} from '../src/node/migrate.js';
import {PostgresDevelopmentStore} from '../src/node/store.js';
import {episodeExecutionFromFull} from '../src/node/contracts.js';
import {grantDevelopmentRuntimeRole,verifyDevelopmentRuntimeRole} from '../src/node/runtime-role.js';
import {identityPgFixture,identityMethods} from './ir-identities-pg-support.js';
import {fixtureId as id} from '../../ir/test/fixtures';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for source-local IR identities integration');
const pool=new Pool({connectionString:databaseUrl,max:10,connectionTimeoutMillis:5000});const owned:string[]=[];
const allocate=()=>id(randomUUID());
beforeAll(async()=>{await migrateDevelopment(pool);});
afterAll(async()=>{let failed=false;for(const tenant of owned)for(const table of ['ir_identities','run_origins','reviews','candidates','runs','briefs'])try{await pool.query(`DELETE FROM camery_script.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}await pool.end();if(failed)throw new Error('Source-local IR identity cleanup failed');});
const counts=async(tenantId:string)=>Number((await pool.query<{total:string}>('SELECT count(*)::text total FROM camery_script.ir_identities WHERE tenant_id=$1',[tenantId])).rows[0]!.total);

it('persists one complete immutable bundle through eight concurrent prepares and a fresh connection pool',async()=>{
  const f=await identityPgFixture(pool,owned);let allocated=0;const store=new PostgresDevelopmentIrIdentities(pool,f.store,()=>{allocated++;return allocate();});const input={source:f.source,target:f.target};
  const prepared=await Promise.all(Array.from({length:8},()=>store.prepare(input)));expect(prepared.every(row=>JSON.stringify(row.identities)===JSON.stringify(prepared[0]!.identities))).toBe(true);expect(allocated).toBe(await counts(f.scope.tenantId));expect(f.calls()).toBe(2);
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const duplicate=new PostgresDevelopmentIrIdentities(reopened,new PostgresDevelopmentStore(reopened),()=>{throw new Error('Persisted identity was reallocated');});expect((await duplicate.prepare(input)).identities).toEqual(prepared[0]!.identities);}finally{await reopened.end();}
});
it('reuses the actual inherited foundation owner without creating child-owned world or character rows',async()=>{
  const f=await identityPgFixture(pool,owned);const identities=new PostgresDevelopmentIrIdentities(pool,f.store,allocate);const original=await identities.prepare({source:f.source,target:f.target});const key={...f.scope,runId:'episodes-child'};
  const child=await f.store.fork({...key,sourceRunId:f.run.runId,expectedSourceRunDigest:f.run.digest,expectedRevision:f.run.brief.revision,expectedBriefDigest:f.run.brief.digest,actorId:'child-author',methods:identityMethods,stage:'episodes',expectedFoundationReviewDigest:f.foundation.digest,execution:episodeExecutionFromFull(f.run.execution)});
  const review=await f.finishEpisodes(child,f.foundation);const source={...f.source,...key,runDigest:child.digest,episodesReviewDigest:review!.digest};const inherited=await identities.prepare({source,target:f.target});expect(inherited.identities).toEqual(original.identities);expect(inherited.progress.foundation).toEqual(original.progress.foundation);expect(f.calls()).toBe(3);
  expect((await pool.query<{total:string}>('SELECT count(*)::text total FROM camery_script.ir_identities WHERE tenant_id=$1 AND owner_run_id=$2',[f.scope.tenantId,child.runId])).rows[0]!.total).toBe('0');
});
it('retains all previously mapped episode slots when a new reviewed brief shrinks the episode count',async()=>{
  const f=await identityPgFixture(pool,owned);const store=new PostgresDevelopmentIrIdentities(pool,f.store,allocate);const initial=await store.prepare({source:f.source,target:f.target});const saved=await f.store.putBrief({...f.put,expectedRevision:1,episodeCount:3});const newer=await f.start('three-episodes',saved.brief);const prepared=await store.prepare({source:newer.source,target:f.target});
  expect(prepared.identities.planId).toBe(initial.identities.planId);expect(prepared.identities.episodes).toEqual(initial.identities.episodes);expect(prepared.identities.worldId).not.toBe(initial.identities.worldId);expect(prepared.identities.foundationOwner.runId).toBe(newer.run.runId);expect(prepared.progress.run.brief.episodeCount).toBe(3);
});
it('fails closed on actual partial committed mappings without generating or persisting replacement IDs',async()=>{
  const f=await identityPgFixture(pool,owned);let allocated=0;const store=new PostgresDevelopmentIrIdentities(pool,f.store,()=>{allocated++;return allocate();});const input={source:f.source,target:f.target};await store.prepare(input);
  const columns='tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id';
  for(const kind of ['episode_plan','world','character','relationship','development_plan','all-episodes','episode-tail']){
    const saved=kind==='all-episodes'?(await pool.query(`DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind IN ('episode','episode_plan') RETURNING ${columns}`,[f.scope.tenantId])).rows
      :kind==='episode-tail'?(await pool.query(`DELETE FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind IN ('episode','episode_plan') AND local_key='10' RETURNING ${columns}`,[f.scope.tenantId])).rows
        :(await pool.query(`DELETE FROM camery_script.ir_identities WHERE (tenant_id,project_id,kind,owner_key,local_key) IN (SELECT tenant_id,project_id,kind,owner_key,local_key FROM camery_script.ir_identities WHERE tenant_id=$1 AND kind=$2 LIMIT 1) RETURNING ${columns}`,[f.scope.tenantId,kind])).rows;
    expect(saved.length).toBeGreaterThan(0);const before=(await pool.query(`SELECT ${columns} FROM camery_script.ir_identities WHERE tenant_id=$1 ORDER BY kind,owner_key,local_key`,[f.scope.tenantId])).rows;allocated=0;
    await expect(store.prepare(input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(allocated).toBe(0);expect((await pool.query(`SELECT ${columns} FROM camery_script.ir_identities WHERE tenant_id=$1 ORDER BY kind,owner_key,local_key`,[f.scope.tenantId])).rows).toEqual(before);
    for(const row of saved)await pool.query(`INSERT INTO camery_script.ir_identities(${columns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[row.tenant_id,row.project_id,row.kind,row.owner_key,row.owner_run_id,row.local_key,row.ir_tenant_id,row.ir_project_id,row.stable_id]);
  }
});
it('adds complete new episode pairs for a new reviewed owner without reassigning the existing contiguous slots',async()=>{
  const f=await identityPgFixture(pool,owned);const store=new PostgresDevelopmentIrIdentities(pool,f.store,allocate);const first=await store.prepare({source:f.source,target:f.target});const saved=await f.store.putBrief({...f.put,expectedRevision:1,episodeCount:12});const newer=await f.start('expanded-owner',saved.brief);const expanded=await store.prepare({source:newer.source,target:f.target});
  expect(expanded.identities.planId).toBe(first.identities.planId);expect(expanded.identities.episodes.slice(0,10)).toEqual(first.identities.episodes);expect(expanded.identities.episodes).toHaveLength(12);expect(expanded.identities.worldId).not.toBe(first.identities.worldId);
});
it('refuses another target, stale or unreviewed sources, wrong scopes and corrupt stored model evidence before allocating',async()=>{
  const f=await identityPgFixture(pool,owned);const store=new PostgresDevelopmentIrIdentities(pool,f.store,allocate);await store.prepare({source:f.source,target:f.target});const existing=await counts(f.scope.tenantId);
  await expect(store.prepare({source:f.source,target:{...f.target,projectId:id('different-project')}})).rejects.toMatchObject({code:'CONFLICT'});
  for(const source of [{...f.source,runDigest:'d'.repeat(64)},{...f.source,foundationReviewDigest:'d'.repeat(64)}])await expect(store.prepare({source,target:f.target})).rejects.toMatchObject({code:'CONFLICT'});
  for(const source of [{...f.source,projectId:'wrong'},{...f.source,tenantId:'wrong'}])await expect(store.prepare({source,target:f.target})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await counts(f.scope.tenantId)).toBe(existing);await f.store.putBrief({...f.put,expectedRevision:1,idea:'采用前创意已更改'});await expect(store.prepare({source:f.source,target:f.target})).rejects.toMatchObject({code:'CONFLICT'});expect(await counts(f.scope.tenantId)).toBe(existing);
  const unreviewed=await identityPgFixture(pool,owned,false);await expect(new PostgresDevelopmentIrIdentities(pool,unreviewed.store,allocate).prepare({source:unreviewed.source,target:unreviewed.target})).rejects.toMatchObject({code:'INCOMPLETE'});expect(await counts(unreviewed.scope.tenantId)).toBe(0);
  const corrupt=await identityPgFixture(pool,owned);await pool.query("UPDATE camery_script.candidates SET record=jsonb_set(record,'{model,modelIdentity}','\"forged\"'::jsonb) WHERE tenant_id=$1 AND stage='foundation'",[corrupt.scope.tenantId]);await expect(new PostgresDevelopmentIrIdentities(pool,corrupt.store,allocate).prepare({source:corrupt.source,target:corrupt.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(await counts(corrupt.scope.tenantId)).toBe(0);
});
it('recovers the original persisted bundle after an actual commit followed by lost acknowledgement',async()=>{
  const f=await identityPgFixture(pool,owned);let lost=false;const borrowed={connect:async()=>{const client=await pool.connect();return new Proxy(client,{get(target,property){if(property==='query')return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('Committed identity ACK lost');}return result;};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});}} as unknown as Pool;
  await expect(new PostgresDevelopmentIrIdentities(borrowed,f.store,allocate).prepare({source:f.source,target:f.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(lost).toBe(true);const rows=(await pool.query('SELECT * FROM camery_script.ir_identities WHERE tenant_id=$1 ORDER BY kind,owner_key,local_key',[f.scope.tenantId])).rows;expect(rows.length).toBeGreaterThan(20);
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const store=new PostgresDevelopmentIrIdentities(reopened,new PostgresDevelopmentStore(reopened),()=>{throw new Error('Committed ID reallocated');});const restored=await store.prepare({source:f.source,target:f.target});expect(restored.identities.episodes).toHaveLength(10);expect((await pool.query('SELECT * FROM camery_script.ir_identities WHERE tenant_id=$1 ORDER BY kind,owner_key,local_key',[f.scope.tenantId])).rows).toEqual(rows);}finally{await reopened.end();}
});
it('rolls back and destroys an actually terminated backend then creates one stable bundle on a fresh pool',async()=>{
  const f=await identityPgFixture(pool,owned);let terminated=false;let destroyed=false;let pid=0;let ownedListener:((...args:unknown[])=>void)|undefined;let native:PoolClient|undefined;
  const interrupted={connect:async()=>{const client=await pool.connect();native=client;pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;return new Proxy(client,{get(target,property){
    if(property==='on')return (event:Parameters<typeof client.on>[0],handler:(...args:unknown[])=>void)=>{if(event==='error')ownedListener=handler;return target.on(event,handler);};
    if(property==='query')return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql.startsWith('INSERT INTO camery_script.ir_identities')&&!terminated){expect((await pool.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0]!.terminated).toBe(true);terminated=true;await new Promise<void>(resolve=>{setImmediate(resolve);});}return result;};
    if(property==='release')return (destroy?:boolean)=>{destroyed=destroy===true;target.release(destroy);};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});}} as unknown as Pool;
  await expect(new PostgresDevelopmentIrIdentities(interrupted,f.store,allocate).prepare({source:f.source,target:f.target})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(terminated).toBe(true);expect(destroyed).toBe(true);expect(ownedListener).toBeTypeOf('function');expect(native!.listeners('error')).not.toContain(ownedListener);expect(await counts(f.scope.tenantId)).toBe(0);
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const store=new PostgresDevelopmentIrIdentities(reopened,new PostgresDevelopmentStore(reopened),allocate);const first=await store.prepare({source:f.source,target:f.target});expect((await store.prepare({source:f.source,target:f.target})).identities).toEqual(first.identities);}finally{await reopened.end();}
});
it('keeps the existing append-only development LOGIN unable to read or allocate local IR identities',async()=>{
  const f=await identityPgFixture(pool,owned);const suffix=randomBytes(8).toString('hex');const role='local_ir_old_data_'+suffix;const password=randomBytes(24).toString('hex');let runtime:Pool|undefined;
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
  try{await grantDevelopmentRuntimeRole(pool,role);const url=new URL(databaseUrl!);url.username=role;url.password=password;runtime=new Pool({connectionString:url.toString(),max:1});await verifyDevelopmentRuntimeRole(runtime);
    await expect(runtime.query('SELECT * FROM camery_script.ir_identities WHERE tenant_id=$1',[f.scope.tenantId])).rejects.toMatchObject({code:'42501'});
    await expect(runtime.query("INSERT INTO camery_script.ir_identities(tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id) VALUES($1,$2,'development_plan','project',NULL,'plan',$3,$4,$5)",[f.scope.tenantId,f.scope.projectId,f.target.tenantId,f.target.projectId,allocate()])).rejects.toMatchObject({code:'42501'});
  }finally{await runtime?.end();await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE ${role}`);}
});
it('enforces canonical slots, source-owner foreign scope and global stable identity uniqueness in SQL',async()=>{
  const f=await identityPgFixture(pool,owned);const sql='INSERT INTO camery_script.ir_identities(tenant_id,project_id,kind,owner_key,owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)';
  const base:unknown[]=[f.scope.tenantId,f.scope.projectId,'world',f.run.runId,f.run.runId,'world',f.target.tenantId,f.target.projectId,allocate()];
  for(const [index,bad] of [[0,f.scope.tenantId+'\n'],[2,'unknown'],[3,'wrong'],[4,null],[5,'wrong'],[6,f.target.tenantId+'\n'],[8,f.target.projectId]] as const){const values=[...base];values[index]=bad;await expect(pool.query(sql,values)).rejects.toMatchObject({code:'23514'});}
  await expect(pool.query(sql,[base[0],'other',...base.slice(2)])).rejects.toMatchObject({code:'23503'});
  const episode=[base[0],base[1],'episode','project',null,'01',base[6],base[7],allocate()];await expect(pool.query(sql,episode)).rejects.toMatchObject({code:'23514'});
  await pool.query(sql,base);await expect(pool.query(sql,[base[0],base[1],'character',base[3],base[4],'constructor',base[6],base[7],base[8]])).rejects.toMatchObject({code:'23505'});
});

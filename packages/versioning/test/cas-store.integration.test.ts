import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient,QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {migrateVersioning,PostgresVersionStore} from '../src/node/index';
import type {PersistedAdoptOptions,VersionProjectKey} from '../src/node/types';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for version expectation integration tests');
const pool=new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5000});const store=new PostgresVersionStore(pool);const projects:VersionProjectKey[]=[];
const approval=():PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:id('prj_demo')},at:'2026-11-17T05:00:00.000Z',authorize:()=>true});
const request=(alias='cas-change')=>changeSet([{op:'update',op_id:id('cas-op-'+alias),collection:'shots',target:id('sh_1'),set:{action:alias}}],{id:id(alias),base_revisions:[{id:id('sh_1'),version:1}]});
async function fixture(candidate=true){const key={tenantId:id(randomUUID()),projectId:id('prj_demo')};projects.push(key);await store.initialize(key,makePackage());if(candidate)await store.submit(key,request());return key;}
async function counts(key:VersionProjectKey){return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{total:string}>(`SELECT count(*)::text total FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.total)));}
function wrappedPool(observe:(client:PoolClient,text:string)=>Promise<void>,afterCommit?:()=>void){const connect=async()=>{
  const client=await pool.connect();const query=async(input:string|QueryConfig,values?:unknown[])=>{const text=typeof input==='string'?input:input.text;await observe(client,text);const result=await client.query(input,values);if(text.trim().toUpperCase()==='COMMIT')afterCommit?.();return result;};
  return new Proxy(client,{get(target,property){if(property==='query')return query;const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
};
  // Drizzle recognizes a Pool by its prototype. Preserve that identity so it checks out this observed client for its actual transaction.
  return new Proxy(pool,{get(target,property){if(property==='connect')return connect;const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
}
beforeAll(async()=>{await migrateVersioning(pool);});
afterAll(async()=>{let failed=false;for(const key of projects){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}await pool.end();if(failed)throw new Error('Version expectation fixture cleanup failed');});

it('checks both expectations before any formal mutation and preserves complete state on failure',async()=>{
  const key=await fixture();const before=await store.read(key);const beforeCounts=await counts(key);
  await expect(store.submit(key,request('other-cas'),{expectation:{expectedSnapshotRevision:4,expectedWriteVersion:2}})).rejects.toMatchObject({code:'SNAPSHOT_STALE'});
  await expect(store.adopt(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}})).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});
  await expect(store.reject(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:4,expectedWriteVersion:2}},'Do not adopt')).rejects.toMatchObject({code:'SNAPSHOT_STALE'});
  expect(await store.read(key)).toEqual(before);expect(await counts(key)).toEqual(beforeCounts);
});
it('serializes two distinct requests with one expected write version so exactly one can commit',async()=>{
  const key=await fixture(false);const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};const results=await Promise.allSettled([store.submit(key,request('cas-concurrent-a'),{expectation}),store.submit(key,request('cas-concurrent-b'),{expectation})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);const rejected=results.filter(result=>result.status==='rejected');expect(rejected).toHaveLength(1);expect(rejected[0]).toMatchObject({reason:{code:'WRITE_VERSION_CONFLICT'}});
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const persisted=await new PostgresVersionStore(reopened).read(key);expect(persisted?.writeVersion).toBe(2);expect(persisted?.state.head.revision.number).toBe(5);expect(persisted?.state.changes).toHaveLength(1);expect(persisted?.state.adoptions).toHaveLength(0);}finally{await reopened.end();}
});
it('returns the exact stored submit result after a committed acknowledgement loss and old CAS',async()=>{
  const key=await fixture(false);const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};let lose=true;const lossy=new PostgresVersionStore(wrappedPool(async()=>{},()=>{if(lose){lose=false;throw new Error('Synthetic committed submit acknowledgement lost');}}));
  await expect(lossy.submit(key,request(),{expectation})).rejects.toMatchObject({code:'DATABASE_ERROR'});const committed=(await store.read(key))!;expect(committed.writeVersion).toBe(2);expect(committed.state.changes).toHaveLength(1);const beforeCounts=await counts(key);
  const retry=await store.submit(key,request(),{expectation});expect(retry.state).toEqual(committed.state);expect(retry.writeVersion).toBe(2);expect(await counts(key)).toEqual(beforeCounts);
  const changed=request();changed.author.id=id('another-author');await expect(store.submit(key,changed,{expectation})).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});
  const conflict=await store.submit(key,changed,{expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}});expect(conflict.issues.map(issue=>issue.code)).toContain('CHANGE_ID_CONFLICT');expect(await store.read(key)).toEqual(committed);
});
it('recovers an adopted ACK with stale expectations while consulting current trusted authorization',async()=>{
  const key=await fixture();const expectation={expectedSnapshotRevision:5,expectedWriteVersion:2};const adopted=await store.adopt(key,request().id,{...approval(),expectation});expect(adopted.status).toBe('adopted');expect(adopted.writeVersion).toBe(3);const beforeCounts=await counts(key);const authorize=vi.fn(()=>true);
  const retry=await store.adopt(key,request().id,{...approval(),expectation,authorize});expect(retry.state).toEqual(adopted.state);expect(authorize).toHaveBeenCalledWith(approval().actor,key,approval().scope);
  const denied=await store.adopt(key,request().id,{...approval(),expectation,authorize:()=>false});expect(denied.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(await counts(key)).toEqual(beforeCounts);expect((await store.read(key))!.state).toEqual(adopted.state);
});
it('keeps source validation before the version row lock and rejects its stale CAS in the same transaction',async()=>{
  const key=await fixture();const before=await store.read(key);const beforeCounts=await counts(key);const phases:{phase:string;pid:number;txid:string}[]=[];
  const guarded=new PostgresVersionStore(wrappedPool(async(client,text)=>{if(text.includes('FOR UPDATE'))phases.push({phase:'version-lock',...(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!});}));
  await expect(guarded.adoptGuarded(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}},async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['cas-source:'+key.tenantId]);phases.push({phase:'source-guard',...(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!});})).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});
  expect(phases.map(at=>at.phase)).toEqual(['source-guard','version-lock']);expect(new Set(phases.map(at=>at.pid)).size).toBe(1);expect(new Set(phases.map(at=>at.txid)).size).toBe(1);expect(await store.read(key)).toEqual(before);expect(await counts(key)).toEqual(beforeCounts);
  const adopted=await guarded.adoptGuarded(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}},async()=>{});const guard=vi.fn(async()=>{throw new Error('Historical source must not run');});const retry=await guarded.adoptGuarded(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}},guard);expect(retry.state).toEqual(adopted.state);expect(guard).not.toHaveBeenCalled();
});
it('captures expected revisions before actually waiting on a competing PostgreSQL row lock',async()=>{
  const key=await fixture(false);const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT 1 FROM camery_versioning.projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE',[key.tenantId,key.projectId]);
  const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;let waitingPid=0;
  const observed=new PostgresVersionStore(wrappedPool(async(client,text)=>{if(text.includes('FOR UPDATE'))waitingPid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;}));
  const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};const submitting=observed.submit(key,request(),{expectation});expectation.expectedSnapshotRevision=99;expectation.expectedWriteVersion=99;
  try{await vi.waitFor(async()=>{expect(waitingPid).toBeGreaterThan(0);expect((await pool.query<{pids:number[]}>('SELECT pg_blocking_pids($1) pids',[waitingPid])).rows[0]!.pids).toContain(blockerPid);},{timeout:5000,interval:20});await blocker.query('COMMIT');expect((await submitting).status).toBe('candidate');}finally{await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await Promise.allSettled([submitting]);}
});
it('keeps rejection CAS strict instead of fabricating a full rejection acknowledgement',async()=>{
  const key=await fixture();const expectation={expectedSnapshotRevision:5,expectedWriteVersion:2};const rejected=await store.reject(key,request().id,{...approval(),expectation},'Reviewed and declined');expect(rejected.state.changes[0]!.rejection).toMatchObject({reason:'Reviewed and declined'});expect(rejected.writeVersion).toBe(3);const beforeCounts=await counts(key);
  await expect(store.reject(key,request().id,{...approval(),expectation},'Reviewed and declined')).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});expect(await counts(key)).toEqual(beforeCounts);expect((await store.read(key))!.state).toEqual(rejected.state);
});

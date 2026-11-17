import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient,QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {PostgresVersionStore,migrateVersioning,VersionPersistenceError} from '../src/node/index';
import type {PersistedAdoptOptions,VersionProjectKey} from '../src/node/types';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL is required for guarded adoption tests');
const pool=new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5000});const store=new PostgresVersionStore(pool);const projects:VersionProjectKey[]=[];
const sourceTable='camery_versioning.guard_source_'+randomBytes(8).toString('hex');let sourceCreated=false;
const approval=():PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:id('prj_demo')},at:'2026-11-17T01:00:00.000Z',authorize:()=>true});
const request=()=>changeSet([{op:'update',op_id:id('guarded-op'),collection:'shots',target:id('sh_1'),set:{action:'Guarded formal content'}}],{id:id('guarded-change'),base_revisions:[{id:id('sh_1'),version:1}]});
function gate(){let resolve:()=>void=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const sourceLock=(key:VersionProjectKey)=>'guarded-source:'+key.tenantId+':'+key.projectId;
async function lockSource(client:PoolClient,key:VersionProjectKey){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[sourceLock(key)]);}
async function revision(key:VersionProjectKey){return (await pool.query<{revision:number}>(`SELECT revision FROM ${sourceTable} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.revision;}
async function counts(key:VersionProjectKey){return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{total:string}>(`SELECT count(*)::text total FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.total)));}
async function fixture(){
  const key={tenantId:id(randomUUID()),projectId:id('prj_demo')};projects.push(key);await store.initialize(key,makePackage());await store.submit(key,request());await pool.query(`INSERT INTO ${sourceTable}(tenant_id,project_id,revision) VALUES($1,$2,1)`,[key.tenantId,key.projectId]);return key;
}
function wrappedPool(observe:(client:PoolClient,text:string)=>Promise<void>,afterCommit?:()=>void){
  return {query:pool.query.bind(pool),connect:async()=>{
    const client=await pool.connect();const query=async(input:string|QueryConfig,values?:unknown[])=>{const text=typeof input==='string'?input:input.text;await observe(client,text);const result=await client.query(input,values);if(text==='COMMIT')afterCommit?.();return result;};
    return new Proxy(client,{get(target,property){if(property==='query')return query;const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
  }} as unknown as Pool;
}
beforeAll(async()=>{await migrateVersioning(pool);await pool.query(`CREATE TABLE ${sourceTable}(tenant_id text NOT NULL,project_id text NOT NULL,revision integer NOT NULL,PRIMARY KEY(tenant_id,project_id))`);sourceCreated=true;});
afterAll(async()=>{
  let failed=false;for(const key of projects){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}
  if(sourceCreated)try{await pool.query(`DROP TABLE ${sourceTable}`);}catch{failed=true;}await pool.end();if(failed)throw new Error('Guarded adoption fixture cleanup failed');
});

it('keeps source lock and formal writes in the same actual backend and transaction until adoption commits',async()=>{
  const key=await fixture();const entered=gate();const proceed=gate();const locations:{phase:string;pid:number;txid:string}[]=[];
  const guarded=new PostgresVersionStore(wrappedPool(async(client,text)=>{if(text.includes('FOR UPDATE')||text.startsWith('INSERT INTO camery_versioning.adoptions')){const at=(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!;locations.push({phase:text.includes('FOR UPDATE')?'version-lock':'adoption-write',...at});}}));
  const adopting=guarded.adoptGuarded(key,request().id,approval(),async client=>{await lockSource(client,key);const at=(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!;locations.push({phase:'source-guard',...at});expect((await client.query<{revision:number}>(`SELECT revision FROM ${sourceTable} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.revision).toBe(1);entered.resolve();await proceed.promise;});
  const writer=await pool.connect();let writing:Promise<void>|undefined;
  try{
    await Promise.race([entered.promise,adopting.then(()=>{throw new Error('Adoption completed before the source checkpoint');})]);const writerPid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    writing=(async()=>{await writer.query('BEGIN');await lockSource(writer,key);await writer.query(`UPDATE ${sourceTable} SET revision=2 WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await writer.query('COMMIT');})();
    await vi.waitFor(async()=>{const blocked=await pool.query<{pids:number[]}>('SELECT pg_blocking_pids($1) pids',[writerPid]);expect(blocked.rows[0]!.pids).toContain(locations[0]!.pid);},{timeout:5000,interval:20});
    expect(locations.map(at=>at.phase)).toEqual(['source-guard']);proceed.resolve();expect((await adopting).status).toBe('adopted');await writing;expect(await revision(key)).toBe(2);
    expect(locations.map(at=>at.phase)).toEqual(['source-guard','version-lock','adoption-write']);expect(new Set(locations.map(at=>at.pid)).size).toBe(1);expect(new Set(locations.map(at=>at.txid)).size).toBe(1);expect((await store.read(key))!.state.adoptions).toHaveLength(1);
  }finally{proceed.resolve();await Promise.allSettled([adopting,...(writing?[writing]:[])]);await writer.query('ROLLBACK').catch(()=>{});writer.release();}
});
it('rolls back the complete transaction on an explicit source refusal before formal writes',async()=>{
  const key=await fixture();const before=await store.read(key);const beforeCounts=await counts(key);
  await expect(store.adoptGuarded(key,request().id,approval(),async client=>{await lockSource(client,key);await client.query(`UPDATE ${sourceTable} SET revision=9 WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source guard',key.projectId);})).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});
  expect(await revision(key)).toBe(1);expect(await store.read(key)).toEqual(before);expect(await counts(key)).toEqual(beforeCounts);
});
it('aborts formal adoption if its source connection disconnects even though a competing source update can now commit',async()=>{
  const key=await fixture();const before=await store.read(key);const beforeCounts=await counts(key);const writer=await pool.connect();
  try{
    await expect(store.adoptGuarded(key,request().id,approval(),async client=>{
      await lockSource(client,key);const pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
      expect((await pool.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0]!.terminated).toBe(true);
      await writer.query('BEGIN');await lockSource(writer,key);await writer.query(`UPDATE ${sourceTable} SET revision=2 WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await writer.query('COMMIT');
    })).rejects.toMatchObject({code:'DATABASE_ERROR'});
    expect(await revision(key)).toBe(2);expect(await store.read(key)).toEqual(before);expect(await counts(key)).toEqual(beforeCounts);
  }finally{await writer.query('ROLLBACK').catch(()=>{});writer.release();}
});
it('recovers an actual committed acknowledgement loss with the same ChangeSet and a newly authorized historical result',async()=>{
  const key=await fixture();let lose=true;let guards=0;const guarded=new PostgresVersionStore(wrappedPool(async()=>{},()=>{if(lose){lose=false;throw new Error('Synthetic committed acknowledgement lost');}}));
  await expect(guarded.adoptGuarded(key,request().id,approval(),async client=>{guards++;await lockSource(client,key);})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  const committed=(await store.read(key))!;expect(committed.state.changes[0]!.status).toBe('adopted');expect(committed.state.adoptions).toHaveLength(1);const beforeCounts=await counts(key);
  await pool.query(`UPDATE ${sourceTable} SET revision=2 WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);const changed=vi.fn(async()=>{throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source guard',key.projectId);});
  const authorize=vi.fn(()=>true);expect((await guarded.adoptGuarded(key,request().id,{...approval(),authorize},changed)).state).toEqual(committed.state);expect(authorize).toHaveBeenCalledWith(approval().actor,key,approval().scope);expect(changed).not.toHaveBeenCalled();expect(guards).toBe(1);
  expect((await guarded.adoptGuarded(key,request().id,{...approval(),authorize:()=>false},changed)).issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(await counts(key)).toEqual(beforeCounts);expect(await store.read(key)).toEqual(committed);
});
it('preserves tenant isolation and current adoption scope checks without extra snapshots or history',async()=>{
  const key=await fixture();const before=await store.read(key);const beforeCounts=await counts(key);const guard=async(client:PoolClient)=>{await lockSource(client,key);};
  await expect(store.adoptGuarded({...key,tenantId:id(randomUUID())},request().id,approval(),async()=>{})).rejects.toMatchObject({code:'PROJECT_NOT_FOUND'});
  const narrow=await store.adoptGuarded(key,request().id,{...approval(),scope:{kind:'scene',id:id('sc_2')}},guard);expect(narrow.issues.map(issue=>issue.code)).toContain('ADOPTION_SCOPE');
  const denied=await store.adoptGuarded(key,request().id,{...approval(),actor:{kind:'agent_run',id:id('agent')}},guard);expect(denied.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(await store.read(key)).toEqual(before);expect(await counts(key)).toEqual(beforeCounts);
});
it.each(['allowed','revoked'] as const)('recovers a concurrent historical ACK after waiting behind a newer source with %s authorization',async grant=>{
  const key=await fixture();const entered=gate();const proceed=gate();const waiting=gate();let adopterPid=0;let retryPid=0;let guards=0;let authorized=true;
  const adopting=store.adoptGuarded(key,request().id,approval(),async client=>{await lockSource(client,key);adopterPid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;entered.resolve();await proceed.promise;});
  const writer=await pool.connect();let writing:Promise<void>|undefined;let retry:ReturnType<PostgresVersionStore['adoptGuarded']>|undefined;
  try{
    await Promise.race([entered.promise,adopting.then(()=>{throw new Error('Adoption completed before its source checkpoint');})]);const writerPid=(await writer.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
    // Queue the source update before the retry. Once the first adoption commits, the source advances before the retry receives its source lock.
    writing=(async()=>{await writer.query('BEGIN');await lockSource(writer,key);await writer.query(`UPDATE ${sourceTable} SET revision=2 WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await writer.query('COMMIT');})();
    await vi.waitFor(async()=>expect((await pool.query<{pids:number[]}>('SELECT pg_blocking_pids($1) pids',[writerPid])).rows[0]!.pids).toContain(adopterPid),{timeout:5000,interval:20});
    retry=store.adoptGuarded(key,request().id,{...approval(),authorize:()=>authorized},async client=>{
      guards++;retryPid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;waiting.resolve();await lockSource(client,key);
      expect((await client.query<{revision:number}>(`SELECT revision FROM ${sourceTable} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.revision).toBe(2);if(grant==='revoked')authorized=false;
      throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source guard',key.projectId);
    });
    await Promise.race([waiting.promise,retry.then(()=>{throw new Error('Retry completed before waiting for its source lock');})]);await vi.waitFor(async()=>expect((await pool.query<{pids:number[]}>('SELECT pg_blocking_pids($1) pids',[retryPid])).rows[0]!.pids).toContain(adopterPid),{timeout:5000,interval:20});
    proceed.resolve();const committed=await adopting;expect(committed.status).toBe('adopted');await writing;const beforeCounts=await counts(key);const result=await retry;
    if(grant==='allowed')expect(result.state).toEqual(committed.state);else expect(result.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');
    expect(result.status).toBe(grant==='allowed'?'adopted':'rejected');expect(guards).toBe(1);expect(await revision(key)).toBe(2);expect(await counts(key)).toEqual(beforeCounts);expect((await store.read(key))!.state).toEqual(committed.state);
  }finally{proceed.resolve();await Promise.allSettled([adopting,...(writing?[writing]:[]),...(retry?[retry]:[])]);await writer.query('ROLLBACK').catch(()=>{});writer.release();}
});

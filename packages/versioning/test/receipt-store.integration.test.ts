import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import type {PoolClient,QueryConfig} from 'pg';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {migrateVersioning,PostgresVersionStore,VersionPersistenceError} from '../src/node/index';
import type {PersistedAdoptOptions,PersistedChangeResult,VersionProjectKey,VersionTransactionContext,VersionTransactionReceipt} from '../src/node/types';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {jsonSignature} from '../src/objects';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for atomic version receipt tests');
const pool=new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5000});const store=new PostgresVersionStore(pool);const projects:VersionProjectKey[]=[];
const receiptTable='camery_versioning.receipt_probe_'+randomBytes(8).toString('hex');let tableCreated=false;
const approval=():PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:id('prj_demo')},at:'2026-11-17T06:00:00.000Z',authorize:()=>true});
const request=()=>changeSet([{op:'update',op_id:id('receipt-pg-op'),collection:'shots',target:id('sh_1'),set:{action:'Atomically receipted change'}}],{id:id('receipt-pg-change'),base_revisions:[{id:id('sh_1'),version:1}]});
async function fixture(candidate=true){const key={tenantId:id(randomUUID()),projectId:id('prj_demo')};projects.push(key);await store.initialize(key,makePackage());if(candidate)await store.submit(key,request());return key;}
function gate(){let resolve=()=>{};const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
const outcome=(result:Readonly<PersistedChangeResult>)=>({status:result.status,revision:result.state.head.revision.number,writeVersion:result.writeVersion,issues:result.issues,adoptions:result.state.adoptions});
const receipt=(key:VersionProjectKey,receiptKey:string)=>async(client:PoolClient,result:Readonly<PersistedChangeResult>)=>{
  await client.query(`INSERT INTO ${receiptTable}(tenant_id,project_id,receipt_key,record,pid,txid) VALUES($1,$2,$3,$4::jsonb,pg_backend_pid(),txid_current()) ON CONFLICT DO NOTHING`,[key.tenantId,key.projectId,receiptKey,JSON.stringify(outcome(result))]);
};
async function saved(key:VersionProjectKey){return (await pool.query<{receipt_key:string;record:ReturnType<typeof outcome>;pid:number;txid:string}>(`SELECT receipt_key,record,pid,txid::text txid FROM ${receiptTable} WHERE tenant_id=$1 AND project_id=$2 ORDER BY receipt_key`,[key.tenantId,key.projectId])).rows;}
async function counts(key:VersionProjectKey){return Promise.all(['snapshots','changes','object_revisions','adoptions'].map(async table=>Number((await pool.query<{total:string}>(`SELECT count(*)::text total FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId])).rows[0]!.total)));}
function observedPool(observe:(client:PoolClient,text:string)=>Promise<void>,afterCommit?:()=>void,onRelease?:(destroy:boolean)=>void):Pool{
  const connect=async()=>{const client=await pool.connect();return new Proxy(client,{get(target,property){
    if(property==='query')return async(input:string|QueryConfig,values?:unknown[])=>{const text=typeof input==='string'?input:input.text;await observe(target,text);const result=await target.query(input,values);if(text.trim().toUpperCase()==='COMMIT')afterCommit?.();return result;};
    if(property==='release')return (destroy?:boolean)=>{onRelease?.(destroy===true);target.release(destroy);};
    const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});};
  // Preserve Pool identity so any Drizzle transaction paths still check out the observed connection.
  return new Proxy(pool,{get(target,property){if(property==='connect')return connect;const value:unknown=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
}
beforeAll(async()=>{await migrateVersioning(pool);await pool.query(`CREATE TABLE ${receiptTable}(tenant_id text NOT NULL,project_id text NOT NULL,receipt_key text NOT NULL,record jsonb NOT NULL,pid integer NOT NULL,txid bigint NOT NULL,PRIMARY KEY(tenant_id,project_id,receipt_key),FOREIGN KEY(tenant_id,project_id) REFERENCES camery_versioning.projects(tenant_id,project_id))`);tableCreated=true;});
afterAll(async()=>{
  let failed=false;
  for(const key of projects){const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');if(tableCreated)await client.query(`DELETE FROM ${receiptTable} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[key.tenantId,key.projectId]);await client.query('COMMIT');}catch{failed=true;await client.query('ROLLBACK').catch(()=>{});}finally{client.release();}}
  if(tableCreated)try{await pool.query(`DROP TABLE ${receiptTable}`);}catch{failed=true;}await pool.end();if(failed)throw new Error('Atomic version receipt fixture cleanup failed');
});
it('keeps submit and receipt invisible together until COMMIT on one actual backend and transaction',async()=>{
  const key=await fixture(false);const entered=gate();const proceed=gate();const phases:{phase:string;pid:number;txid:string}[]=[];
  const mark=async(client:PoolClient,phase:string)=>{phases.push({phase,...(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!});};
  const observed=new PostgresVersionStore(observedPool(async(client,text)=>{if(text.includes('FOR UPDATE'))await mark(client,'version-lock');if(text.startsWith('INSERT INTO camery_versioning.changes'))await mark(client,'formal-write');}));
  const submitting=observed.submitWithReceipt(key,request(),{expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}},async(client,result)=>{await mark(client,'receipt');await receipt(key,'prepare')(client,result);expect((await client.query<{count:string}>('SELECT count(*)::text count FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2',[key.tenantId,key.projectId])).rows[0]!.count).toBe('1');entered.resolve();await proceed.promise;});
  try{await Promise.race([entered.promise,submitting.then(()=>{throw new Error('Submit committed before its receipt checkpoint');})]);expect((await counts(key))[1]).toBe(0);expect(await saved(key)).toEqual([]);proceed.resolve();const result=await submitting;expect(result.status).toBe('candidate');expect(phases.map(x=>x.phase)).toEqual(['version-lock','formal-write','receipt']);expect(new Set(phases.map(x=>x.pid)).size).toBe(1);expect(new Set(phases.map(x=>x.txid)).size).toBe(1);expect((await saved(key))[0]).toMatchObject({record:outcome(result),pid:phases[0]!.pid,txid:phases[0]!.txid});}finally{proceed.resolve();await Promise.allSettled([submitting]);}
});
it('commits source guard, formal adoption and receipt in source→version→receipt order with equal backend and txid',async()=>{
  const key=await fixture();const phases:{phase:string;pid:number;txid:string}[]=[];const mark=async(client:PoolClient,phase:string)=>{phases.push({phase,...(await client.query<{pid:number;txid:string}>('SELECT pg_backend_pid() pid,txid_current()::text txid')).rows[0]!});};
  const observed=new PostgresVersionStore(observedPool(async(client,text)=>{if(text.includes('FOR UPDATE'))await mark(client,'version-lock');if(text.startsWith('INSERT INTO camery_versioning.adoptions'))await mark(client,'adoption-write');}));
  const result=await observed.adoptGuarded(key,request().id,approval(),async client=>{await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['receipt-source:'+key.tenantId]);await mark(client,'source-guard');},async(client,result)=>{await mark(client,'receipt');await receipt(key,'adopt')(client,result);});
  expect(result.status).toBe('adopted');expect(phases.map(x=>x.phase)).toEqual(['source-guard','version-lock','adoption-write','receipt']);expect(new Set(phases.map(x=>x.pid)).size).toBe(1);expect(new Set(phases.map(x=>x.txid)).size).toBe(1);expect((await saved(key))[0]!.record).toEqual(outcome(result));expect((await store.read(key))!.state.adoptions).toHaveLength(1);
});
it.each(['submit','reject','adopt'] as const)('rolls back %s records and receipt when receipt storage fails after its INSERT',async action=>{
  const key=await fixture(action!=='submit');const before=await store.read(key);const beforeCounts=await counts(key);const fail:VersionTransactionReceipt=async(client,result)=>{await receipt(key,'failed')(client,result);throw new Error('Synthetic receipt storage failure');};
  const pending=action==='submit'?store.submitWithReceipt(key,request(),{},fail):action==='reject'?store.rejectWithReceipt(key,request().id,approval(),'Explicit human rejection',fail):store.adoptGuarded(key,request().id,approval(),async()=>{},fail);
  await expect(pending).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(await saved(key)).toEqual([]);expect(await store.read(key)).toEqual(before);expect(await counts(key)).toEqual(beforeCounts);
});
it('stores rejection and its declared actual decision receipt atomically without guessing a later rejection replay',async()=>{
  const key=await fixture();const result=await store.rejectWithReceipt(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}},'Explicit human rejection',receipt(key,'reject'));
  expect(result.status).toBe('rejected');expect(result.state.changes[0]!.rejection).toMatchObject({actor_id:approval().actor.id,reason:'Explicit human rejection'});expect((await saved(key))[0]!.record).toEqual(outcome(result));
  const old=await saved(key);const repeated=await store.rejectWithReceipt(key,request().id,approval(),'Explicit human rejection',receipt(key,'reject'));expect(repeated.issues.map(issue=>issue.code)).toContain('CHANGE_STATE');expect(await saved(key)).toEqual(old);expect((await store.read(key))!.state).toEqual(result.state);
});
it('aborts both formal adoption and an inserted receipt on actual backend termination during the callback',async()=>{
  const key=await fixture();const before=await store.read(key);const beforeCounts=await counts(key);let destroyed=false;let terminated=false;
  const observed=new PostgresVersionStore(observedPool(async()=>{},undefined,destroy=>{destroyed=destroy;}));
  await expect(observed.adoptGuarded(key,request().id,approval(),async()=>{},async(client,result)=>{await receipt(key,'terminated')(client,result);const pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;terminated=(await pool.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) terminated',[pid])).rows[0]!.terminated;await new Promise<void>(resolve=>{setImmediate(resolve);});await client.query('SELECT 1');})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(terminated).toBe(true);expect(destroyed).toBe(true);expect(await saved(key)).toEqual([]);expect(await counts(key)).toEqual(beforeCounts);const reopened=new Pool({connectionString:databaseUrl,max:1});try{expect(await new PostgresVersionStore(reopened).read(key)).toEqual(before);}finally{await reopened.end();}
});
it('recovers actual committed adoption and receipt after lost COMMIT ACK without another snapshot or guard',async()=>{
  const key=await fixture();let lose=true;const observed=new PostgresVersionStore(observedPool(async()=>{},()=>{if(lose){lose=false;throw new Error('Synthetic committed acknowledgement lost');}}));
  await expect(observed.adoptGuarded(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}},async()=>{},receipt(key,'adopt'))).rejects.toMatchObject({code:'DATABASE_ERROR'});
  const reopened=new Pool({connectionString:databaseUrl,max:1});try{const actual=(await new PostgresVersionStore(reopened).read(key))!;expect(actual.state.changes[0]!.status).toBe('adopted');expect(actual.state.adoptions).toHaveLength(1);expect((await saved(key))[0]!.record).toEqual(outcome({state:actual.state,status:'adopted',issues:[],warnings:[],writeVersion:actual.writeVersion}));}finally{await reopened.end();}
  const actual=(await store.read(key))!;const beforeCounts=await counts(key);const guard=vi.fn(async()=>{throw new Error('Changed source should not be consulted after adoption');});const authorize=vi.fn(()=>true);
  const retry=await observed.adoptGuarded(key,request().id,{...approval(),authorize,expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}},guard,receipt(key,'adopt'));expect(retry.state).toEqual(actual.state);expect(guard).not.toHaveBeenCalled();expect(authorize).toHaveBeenCalledWith(approval().actor,key,approval().scope);expect(await counts(key)).toEqual(beforeCounts);expect(await saved(key)).toHaveLength(1);
});
it('preserves the first submission receipt across exact stale-CAS retries and later adoption',async()=>{
  const key=await fixture(false);let lose=true;const observed=new PostgresVersionStore(observedPool(async()=>{},()=>{if(lose){lose=false;throw new Error('Synthetic submitted ACK lost');}}));const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};
  await expect(observed.submitWithReceipt(key,request(),{expectation},receipt(key,'prepare'))).rejects.toMatchObject({code:'DATABASE_ERROR'});const original=(await saved(key))[0]!;expect(original.record).toMatchObject({status:'candidate',revision:5,writeVersion:2});expect((await store.submitWithReceipt(key,request(),{expectation},receipt(key,'prepare'))).status).toBe('candidate');
  await store.adoptGuarded(key,request().id,approval(),async()=>{},receipt(key,'adopt'));expect((await store.submitWithReceipt(key,request(),{expectation},receipt(key,'prepare'))).status).toBe('adopted');expect((await saved(key)).find(row=>row.receipt_key==='prepare')).toEqual(original);expect((await store.read(key))!.state.adoptions).toHaveLength(1);
});
it('does not write a receipt for failed CAS and only receipts a source-refusal recovery after actual adoption authorization',async()=>{
  const key=await fixture();const before=await store.read(key);await expect(store.rejectWithReceipt(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}},'refuse',receipt(key,'stale'))).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});expect(await saved(key)).toEqual([]);expect(await store.read(key)).toEqual(before);
  const guard=vi.fn(async()=>{await store.adopt(key,request().id,approval());throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source guard',key.projectId);});const authorize=vi.fn(()=>true);
  const result=await store.adoptGuarded(key,request().id,{...approval(),authorize},guard,receipt(key,'recovered'));expect(result.status).toBe('adopted');expect(guard).toHaveBeenCalledOnce();expect(authorize).toHaveBeenCalledWith(approval().actor,key,approval().scope);expect((await saved(key))[0]!.record).toEqual(outcome(result));expect((await store.read(key))!.state.adoptions).toHaveLength(1);
});
it('reports frozen actual submit, newly adopted and rejected execution contexts instead of caller-mutated claims',async()=>{
  const key=await fixture(false);const contexts:VersionTransactionContext[]=[];
  await store.submitWithReceipt(key,request(),{},async(client,result,context)=>{contexts.push(context);expect(context).toEqual({operation:'submit',project:key,requestSignature:jsonSignature(request())});expect(Object.isFrozen(context)).toBe(true);expect(Object.isFrozen(context.project)).toBe(true);expect(Object.hasOwn(context,'expectation')).toBe(false);await receipt(key,'prepare-context')(client,result);});
  const options=approval();const original={actor:{...options.actor},scope:{...options.scope},at:options.at};
  const adopted=await store.adoptGuarded(key,request().id,options,async()=>{options.actor.id=id('late-pg-human');options.scope.id=id('late-pg-scope');options.at='2026-11-17T08:00:00.000Z';},async(client,result,context)=>{
    contexts.push(context);expect(context).toEqual({operation:'adopt',project:key,changeId:request().id,...original,replayed:false});expect(Object.isFrozen(context)).toBe(true);if(context.operation!=='adopt')throw new Error('Missing actual adoption context');expect(Object.isFrozen(context.actor)).toBe(true);expect(Object.isFrozen(context.scope)).toBe(true);expect(result.state.adoptions[0]).toMatchObject({actor_id:context.actor.id,scope:context.scope,at:context.at});await receipt(key,'adopt-context')(client,result);
  });expect(adopted.status).toBe('adopted');
  const historicalOptions={...approval(),actor:{kind:'user' as const,id:id('new-authorized-retry')},at:'2026-11-17T09:00:00.000Z'};
  await store.adoptGuarded(key,request().id,historicalOptions,async()=>{throw new Error('Historical source guard must be skipped');},async(client,result,context)=>{contexts.push(context);expect(context).toEqual({operation:'adopt',project:key,changeId:request().id,actor:historicalOptions.actor,scope:historicalOptions.scope,at:historicalOptions.at,replayed:true});expect(result.state.adoptions[0]).toMatchObject({actor_id:original.actor.id,scope:original.scope,at:original.at});await receipt(key,'historical-context')(client,result);});
  const rejectedKey=await fixture();const rejecting={...approval(),scope:{kind:'scene' as const,id:id('sc_1')}};
  await store.rejectWithReceipt(rejectedKey,request().id,rejecting,'Original declared rejection',async(client,result,context)=>{contexts.push(context);expect(context).toEqual({operation:'reject',project:rejectedKey,changeId:request().id,actor:rejecting.actor,scope:rejecting.scope,at:rejecting.at,reason:'Original declared rejection'});expect(Object.isFrozen(context)).toBe(true);if(context.operation!=='reject')throw new Error('Missing actual rejection context');expect(Object.isFrozen(context.actor)).toBe(true);expect(Object.isFrozen(context.scope)).toBe(true);expect(result.state.changes[0]!.rejection).toEqual({actor_id:context.actor.id,at:context.at,reason:context.reason});await receipt(rejectedKey,'reject-context')(client,result);});
  expect(contexts.map(context=>context.operation)).toEqual(['submit','adopt','adopt','reject']);
});
it('determines replay after the actual row lock when another adoption commits after the early source status peek',async()=>{
  const key=await fixture();let competingAdopted=false;const observed=new PostgresVersionStore(observedPool(async(_client,text)=>{
    if(text.includes('FOR UPDATE')&&!competingAdopted){competingAdopted=true;expect((await store.adopt(key,request().id,approval())).status).toBe('adopted');}
  }));
  const guard=vi.fn(async()=>{});let actualContext:VersionTransactionContext|undefined;
  const result=await observed.adoptGuarded(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}},guard,async(client,result,context)=>{actualContext=context;await receipt(key,'locked-replay-context')(client,result);});
  expect(result.status).toBe('adopted');expect(guard).toHaveBeenCalledOnce();expect(actualContext).toMatchObject({operation:'adopt',replayed:true});expect((await store.read(key))!.state.adoptions).toHaveLength(1);expect((await saved(key))[0]!.record).toEqual(outcome(result));
});
it('distinguishes the complete IR tenant/project key and originally supplied CAS even when project IDs and snapshots are equal',async()=>{
  const first=await fixture(false);const second=await fixture(false);expect(first.projectId).toBe(second.projectId);expect(first.tenantId).not.toBe(second.tenantId);const contexts:VersionTransactionContext[]=[];
  for(const key of [first,second])await store.submitWithReceipt(key,request(),{expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}},async(client,result,context)=>{contexts.push(context);expect(context).toEqual({operation:'submit',project:key,expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1},requestSignature:jsonSignature(request())});expect(Object.isFrozen(context.project)).toBe(true);expect(Object.isFrozen(context.expectation)).toBe(true);await receipt(key,'exact-envelope')(client,result);});
  expect(contexts[0]?.project).not.toEqual(contexts[1]?.project);
  for(const expectedWriteVersion of [1,2])await store.submitWithReceipt(first,request(),{expectation:{expectedSnapshotRevision:5,expectedWriteVersion}},async(_client,_result,context)=>{expect(context.expectation).toEqual({expectedSnapshotRevision:5,expectedWriteVersion});expect(context.project).toEqual(first);});
  expect((await store.read(first))!.writeVersion).toBe(2);expect((await store.read(second))!.writeVersion).toBe(2);
});
it('identifies the actual adopted or rejected ChangeSet rather than another request present in the same result state',async()=>{
  const key=await fixture();const other=changeSet([{op:'update',op_id:id('receipt-other-op'),collection:'shots',target:id('sh_1'),set:{action:'Another pending request'}}],{id:id('receipt-other-change'),base_revisions:[{id:id('sh_1'),version:1}]});expect((await store.submit(key,other)).status).toBe('candidate');
  await store.adoptGuarded(key,other.id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:3}},async()=>{},async(client,result,context)=>{
    expect(result.state.changes.some(change=>change.request.id===request().id)).toBe(true);expect(context).toMatchObject({operation:'adopt',project:key,changeId:other.id,expectation:{expectedSnapshotRevision:5,expectedWriteVersion:3},replayed:false});await receipt(key,'other-change-adopt')(client,result);
  });
  await store.rejectWithReceipt(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:6,expectedWriteVersion:4}},'Reject the remaining candidate',async(client,result,context)=>{
    expect(result.state.changes.some(change=>change.request.id===other.id&&change.status==='adopted')).toBe(true);expect(context).toMatchObject({operation:'reject',project:key,changeId:request().id,expectation:{expectedSnapshotRevision:6,expectedWriteVersion:4},reason:'Reject the remaining candidate'});await receipt(key,'remaining-change-reject')(client,result);
  });
  expect((await store.read(key))!.state.adoptions).toHaveLength(1);
});

import {expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {PostgresVersionStore} from '../src/node/store';
import {VersionPersistenceError} from '../src/node/types';
import type {PersistedAdoptOptions} from '../src/node/types';
import {createVersionState,submitChangeSet,adoptChangeSet} from '../src/engine';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const key={tenantId:id('guarded-unit-tenant'),projectId:id('prj_demo')};
const options=():PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:key.projectId},at:'2026-11-17T01:00:00.000Z',authorize:()=>true});
const request=()=>changeSet([{op:'update',op_id:id('guarded-unit-op'),collection:'shots',target:id('sh_1'),set:{action:'Guarded change'}}],{id:id('guarded-unit-change'),base_revisions:[{id:id('sh_1'),version:1}]});
function fixture(adopted=false){
  const candidate=submitChangeSet(createVersionState(makePackage()),request()).state;
  let state=adopted?adoptChangeSet(candidate,request().id,{...options(),authorize:()=>true}).state:candidate;
  const events:string[]=[];const query=vi.fn(async(input:string|{text:string},_values?:unknown[])=>{
    const text=typeof input==='string'?input:input.text;events.push(text);
    if(text.startsWith('SELECT status FROM camery_versioning.changes'))return {rows:[{status:state.changes[0]!.status}]};
    if(text.startsWith('SELECT * FROM camery_versioning.projects'))return {rows:[{package_id:state.head.package_id,initial_revision:'5',head_revision:String(state.head.revision.number),write_version:state.changes[0]!.status==='adopted'?'3':'2'}]};
    if(text.startsWith('SELECT package FROM camery_versioning.snapshots'))return {rows:[{package:state.head}]};
    if(text.startsWith('SELECT record FROM camery_versioning.changes'))return {rows:state.changes.map(record=>({record}))};
    if(text.startsWith('SELECT record FROM camery_versioning.object_revisions'))return {rows:state.revisions.map(record=>({record}))};
    if(text.startsWith('SELECT record FROM camery_versioning.adoptions'))return {rows:state.adoptions.map(record=>({record}))};
    if(text.startsWith('INSERT INTO camery_versioning.changes'))return {rows:[{change_id:request().id}]};
    if(text.startsWith('UPDATE camery_versioning.projects'))return {rows:[{write_version:'3'}]};
    return {rows:[]};
  });
  const client=Object.assign(new EventEmitter(),{query,release:vi.fn()});const pool={connect:vi.fn(async()=>client),query};
  return {store:new PostgresVersionStore(pool as unknown as Pool),pool,client,events,get state(){return state;},adoptExternally(){state=adoptChangeSet(candidate,request().id,{...options(),authorize:()=>true}).state;}};
}
it('runs the trusted source guard on the same client before taking the version project lock',async()=>{
  const f=fixture();const guard=vi.fn(async client=>{expect(client).toBe(f.client);await client.query('source-guard-check');});
  const result=await f.store.adoptGuarded(key,request().id,options(),guard);expect(result.status).toBe('adopted');expect(result.state.adoptions).toHaveLength(1);expect(guard).toHaveBeenCalledOnce();
  expect(f.events[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');expect(f.events.indexOf('source-guard-check')).toBeLessThan(f.events.findIndex(text=>text.includes('FOR UPDATE')));expect(f.events.at(-1)).toBe('COMMIT');expect(f.client.release).toHaveBeenCalledWith(false);
});
it('recovers an already adopted ACK without rechecking a changed source and still reauthorizes the actual scope',async()=>{
  const f=fixture(true);const guard=vi.fn(async()=>{throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source',key.projectId);});const authorize=vi.fn(()=>true);
  const result=await f.store.adoptGuarded(key,request().id,{...options(),authorize},guard);expect(result.status).toBe('adopted');expect(result.state).toEqual(f.state);expect(result.writeVersion).toBe(3);expect(guard).not.toHaveBeenCalled();expect(authorize).toHaveBeenCalledWith(options().actor,key,options().scope);
  expect(f.events.some(text=>text.startsWith('INSERT')||text.startsWith('UPDATE'))).toBe(false);
  const denied=await f.store.adoptGuarded(key,request().id,{...options(),authorize:()=>false},guard);expect(denied.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(guard).not.toHaveBeenCalled();
});
it('rolls back a typed source refusal before any version lock or write',async()=>{
  const f=fixture();await expect(f.store.adoptGuarded(key,request().id,options(),async()=>{throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source',key.projectId);})).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});
  expect(f.events.some(text=>text.includes('FOR UPDATE')||text.startsWith('INSERT')||text.startsWith('UPDATE'))).toBe(false);expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.client.release).toHaveBeenCalledWith(false);
});
it('captures identity and host authority before waiting for a client',async()=>{
  const f=fixture();let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});f.pool.connect.mockImplementation(async()=>{await gate;return f.client;});
  const mutable={...key};const host=options();const pending=f.store.adoptGuarded(mutable,request().id,host,async()=>{});mutable.tenantId=id('late-tenant');host.actor.kind='agent_run';host.scope.id=id('late-project');host.authorize=()=>false;release();expect((await pending).status).toBe('adopted');
});
it('rejects invalid scope, change identity and missing host guard before connecting',async()=>{
  const f=fixture();for(const [scope,change,guard] of [[{...key,tenantId:'foreign'},request().id,async()=>{}],[key,'foreign',async()=>{}],[key,request().id,undefined]] as const)await expect(f.store.adoptGuarded(scope,change,options(),guard as never)).rejects.toBeInstanceOf(VersionPersistenceError);
  expect(f.pool.connect).not.toHaveBeenCalled();
});
it('sanitizes unexpected guard failures and releases a destroyed client when rollback fails',async()=>{
  const f=fixture();const original=f.client.query.getMockImplementation()!;f.client.query.mockImplementation(async(...args)=>{if(args[0]==='ROLLBACK')throw new Error('private rollback URL');return original(...args);});
  let failure:unknown;try{await f.store.adoptGuarded(key,request().id,options(),async()=>{throw Object.assign(new Error('postgresql://private-credential'),{code:'40001'});});}catch(error){failure=error;}
  expect(failure).toMatchObject({code:'DATABASE_ERROR',databaseCode:'40001'});expect(failure instanceof Error?failure.message:'missing error').not.toContain('credential');expect(f.client.release).toHaveBeenCalledWith(true);
});
it('sanitizes connect, commit and release errors without leaking credentials',async()=>{
  for(const phase of ['connect','commit','release'] as const){const f=fixture();const original=f.client.query.getMockImplementation()!;
    if(phase==='connect')f.pool.connect.mockRejectedValue(new Error('postgresql://private-connect'));
    if(phase==='commit')f.client.query.mockImplementation(async(...args)=>{if(args[0]==='COMMIT')throw new Error('postgresql://private-commit');return original(...args);});
    if(phase==='release')f.client.release.mockImplementation(()=>{throw new Error('postgresql://private-release');});
    await expect(f.store.adoptGuarded(key,request().id,options(),async()=>{})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  }
});
it.each(['guard','version','commit'] as const)('observes a checked-out client error during %s without an unhandled error or an automatic retry',async phase=>{
  const f=fixture();let listened=false;const fail=()=>{listened=f.client.listenerCount('error')>0;f.client.emit('error',new Error('private socket failure'));};const query=f.client.query.getMockImplementation()!;
  f.client.query.mockImplementation(async(...args)=>{const text=typeof args[0]==='string'?args[0]:args[0].text;const result=await query(...args);if(phase==='version'&&text.includes('FOR UPDATE')||phase==='commit'&&text==='COMMIT')fail();return result;});
  await expect(f.store.adoptGuarded(key,request().id,options(),async()=>{if(phase==='guard')fail();})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(listened).toBe(true);expect(f.client.release).toHaveBeenCalledWith(true);expect(f.client.listenerCount('error')).toBe(0);expect(f.pool.connect).toHaveBeenCalledOnce();if(phase!=='commit')expect(f.events).not.toContain('COMMIT');
});
it('recovers at most once after a source refusal when another adoption became authoritative while waiting',async()=>{
  const f=fixture();const guard=vi.fn(async()=>{f.adoptExternally();throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source guard',key.projectId);});
  const result=await f.store.adoptGuarded(key,request().id,options(),guard);expect(result.status).toBe('adopted');expect(result.state).toEqual(f.state);expect(guard).toHaveBeenCalledOnce();expect(f.pool.connect).toHaveBeenCalledTimes(2);
  const rollback=f.events.indexOf('ROLLBACK');expect(rollback).toBeGreaterThan(0);expect(f.events.findIndex(text=>text.includes('FOR UPDATE'))).toBeGreaterThan(rollback);expect(f.events.filter(text=>text.startsWith('INSERT')||text.startsWith('UPDATE'))).toEqual([]);
});
it('keeps a source refusal authoritative when no adoption appeared and rechecks changed authorization on a historical recovery',async()=>{
  const f=fixture();const refusal=new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source guard',key.projectId);const guard=vi.fn(async()=>{throw refusal;});
  await expect(f.store.adoptGuarded(key,request().id,options(),guard)).rejects.toBe(refusal);expect(guard).toHaveBeenCalledOnce();expect(f.events.some(text=>text.includes('FOR UPDATE'))).toBe(false);
  const g=fixture();let authorized=true;const denied=await g.store.adoptGuarded(key,request().id,{...options(),authorize:()=>authorized},async()=>{g.adoptExternally();authorized=false;throw refusal;});expect(denied.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(g.state.adoptions).toHaveLength(1);
});
it('never turns database or non-source guard failures into historical recovery attempts',async()=>{
  for(const failure of [new Error('private SQL failure'),new VersionPersistenceError('DATABASE_ERROR','source guard',key.projectId),new VersionPersistenceError('OTHER_REFUSAL','source guard',key.projectId)]){const f=fixture();await expect(f.store.adoptGuarded(key,request().id,options(),async()=>{f.adoptExternally();throw failure;})).rejects.toBeInstanceOf(Error);expect(f.pool.connect).toHaveBeenCalledOnce();}
});

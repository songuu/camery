import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {PostgresVersionStore} from '../src/node/store';
import type {PersistedAdoptOptions,PersistedSubmitOptions} from '../src/node/types';
import {adoptChangeSet,createVersionState,submitChangeSet} from '../src/engine';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const key={tenantId:id('cas-unit-tenant'),projectId:id('prj_demo')};
const approval=():PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:key.projectId},at:'2026-11-17T05:00:00.000Z',authorize:()=>true});
const request=()=>changeSet([{op:'update',op_id:id('cas-unit-op'),collection:'shots',target:id('sh_1'),set:{action:'Explicit CAS update'}}],{id:id('cas-unit-change'),base_revisions:[{id:id('sh_1'),version:1}]});
function fixture(status:'empty'|'candidate'|'adopted'='candidate',connectGate?:Promise<void>){
  const candidate=submitChangeSet(createVersionState(makePackage()),request()).state;
  const state=status==='empty'?createVersionState(makePackage()):status==='adopted'?adoptChangeSet(candidate,request().id,{...approval(),authorize:()=>true}).state:candidate;
  const writeVersion=status==='empty'?1:status==='candidate'?2:3;const events:string[]=[];
  const query=vi.fn(async(input:string|{text:string})=>{
    const text=typeof input==='string'?input:input.text;events.push(text);
    if(text.startsWith('SELECT status FROM camery_versioning.changes'))return {rows:state.changes.map(change=>({status:change.status}))};
    if(text.startsWith('SELECT * FROM camery_versioning.projects'))return {rows:[{package_id:state.head.package_id,initial_revision:'5',head_revision:String(state.head.revision.number),write_version:String(writeVersion)}]};
    if(text.startsWith('SELECT package FROM camery_versioning.snapshots'))return {rows:[{package:state.head}]};
    if(text.startsWith('SELECT record FROM camery_versioning.changes'))return {rows:state.changes.map(record=>({record}))};
    if(text.startsWith('SELECT record FROM camery_versioning.object_revisions'))return {rows:state.revisions.map(record=>({record}))};
    if(text.startsWith('SELECT record FROM camery_versioning.adoptions'))return {rows:state.adoptions.map(record=>({record}))};
    if(text.startsWith('INSERT INTO camery_versioning.changes'))return {rows:[{change_id:request().id}]};
    if(text.startsWith('UPDATE camery_versioning.projects'))return {rows:[{write_version:String(writeVersion+1)}]};
    return {rows:[]};
  });
  const client=Object.assign(new EventEmitter(),{query,release:vi.fn()});const pool={query,connect:vi.fn(async()=>{await connectGate;return client;})};
  return {store:new PostgresVersionStore(pool as unknown as Pool),events,pool,state,writeVersion,client};
}
const writes=(events:string[])=>events.filter(text=>/^(INSERT|UPDATE|DELETE)/.test(text));
const invalid=[null,{},[],'5',()=>1,{expectedSnapshotRevision:5},{expectedSnapshotRevision:5,expectedWriteVersion:0},{expectedSnapshotRevision:0,expectedWriteVersion:1},{expectedSnapshotRevision:NaN,expectedWriteVersion:1},{expectedSnapshotRevision:5,expectedWriteVersion:Infinity},{expectedSnapshotRevision:5,expectedWriteVersion:1.5},{expectedSnapshotRevision:Number.MAX_SAFE_INTEGER+1,expectedWriteVersion:1},{expectedSnapshotRevision:'5',expectedWriteVersion:1},{expectedSnapshotRevision:5,expectedWriteVersion:1,extra:true},Object.assign(Object.create({}),{expectedSnapshotRevision:5,expectedWriteVersion:1}),{expectedSnapshotRevision:5,expectedWriteVersion:1,[Symbol('hidden')]:true},Object.defineProperty({expectedWriteVersion:1},'expectedSnapshotRevision',{value:5}),Object.defineProperty({expectedSnapshotRevision:5},'expectedWriteVersion',{value:1})];
it.each(invalid)('rejects malformed expectation %# before database access',async expectation=>{
  const f=fixture('empty');await expect(f.store.submit(key,request(),{expectation} as unknown as PersistedSubmitOptions)).rejects.toMatchObject({code:'INVALID_EXPECTATION'});expect(f.pool.connect).not.toHaveBeenCalled();expect(f.pool.query).not.toHaveBeenCalled();
});
it('rejects expectation and field accessors without invoking them',async()=>{
  const f=fixture('empty');const getter=vi.fn(()=>1);const field=Object.defineProperty({expectedSnapshotRevision:5},'expectedWriteVersion',{get:getter,enumerable:true});
  await expect(f.store.submit(key,request(),{expectation:field} as unknown as PersistedSubmitOptions)).rejects.toMatchObject({code:'INVALID_EXPECTATION'});
  const option=Object.defineProperty({},'expectation',{get:getter,enumerable:true});await expect(f.store.submit(key,request(),option)).rejects.toMatchObject({code:'INVALID_EXPECTATION'});expect(getter).not.toHaveBeenCalled();expect(f.pool.connect).not.toHaveBeenCalled();
});
it('rejects inherited expectation options without invoking a prototype getter',async()=>{
  const f=fixture('empty');const getter=vi.fn(()=>({expectedSnapshotRevision:5,expectedWriteVersion:1}));const options=Object.create(Object.defineProperty({},'expectation',{get:getter}));await expect(f.store.submit(key,request(),options)).rejects.toMatchObject({code:'INVALID_EXPECTATION'});expect(getter).not.toHaveBeenCalled();expect(f.pool.connect).not.toHaveBeenCalled();
});
it('accepts plain null-prototype expectations and treats explicit undefined as omitted',async()=>{
  const f=fixture('empty');const expectation=Object.assign(Object.create(null),{expectedSnapshotRevision:5,expectedWriteVersion:1});expect((await f.store.submit(key,request(),{expectation})).status).toBe('candidate');const old=fixture('empty');expect((await old.store.submit(key,request(),{expectation:undefined} as unknown as PersistedSubmitOptions)).status).toBe('candidate');
});
it.each(['submit','adopt','adoptGuarded','reject'] as const)('rejects stale snapshot in %s without writing',async method=>{
  const f=fixture(method==='submit'?'empty':'candidate');const expectation={expectedSnapshotRevision:4,expectedWriteVersion:f.writeVersion};
  const operation=method==='submit'?f.store.submit(key,request(),{expectation}):method==='adopt'?f.store.adopt(key,request().id,{...approval(),expectation}):method==='reject'?f.store.reject(key,request().id,{...approval(),expectation},'No longer suitable'):f.store.adoptGuarded(key,request().id,{...approval(),expectation},async client=>{await client.query('source-cas-guard');});
  await expect(operation).rejects.toMatchObject({code:'SNAPSHOT_STALE'});expect(writes(f.events)).toEqual([]);expect(f.events.some(text=>text.includes('FOR UPDATE'))).toBe(true);
  if(method==='adoptGuarded')expect(f.events.indexOf('source-cas-guard')).toBeLessThan(f.events.findIndex(text=>text.includes('FOR UPDATE')));
});
it('distinguishes a stale write version and leaves the candidate untouched',async()=>{
  const f=fixture();await expect(f.store.adopt(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}})).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});expect(writes(f.events)).toEqual([]);expect(f.state.changes[0]!.status).toBe('candidate');
});
it('allows a current expected write and preserves the old no-expectation path',async()=>{
  const current=fixture('empty');expect((await current.store.submit(key,request(),{expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}})).status).toBe('candidate');expect(writes(current.events)).not.toEqual([]);
  const old=fixture('empty');expect((await old.store.submit(key,request())).status).toBe('candidate');
});
it('recovers an exact stored request before stale CAS but never exempts a changed body',async()=>{
  const f=fixture();const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};const result=await f.store.submit(key,request(),{expectation});expect(result.state).toEqual(f.state);expect(result.writeVersion).toBe(2);expect(writes(f.events)).toEqual([]);
  const changed=request();changed.author.id=id('another-author');await expect(f.store.submit(key,changed,{expectation})).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});expect(writes(f.events)).toEqual([]);
});
it.each(['adopt','adoptGuarded'] as const)('reauthorizes an adopted %s ACK before returning despite old expectations',async method=>{
  const f=fixture('adopted');const expectation={expectedSnapshotRevision:5,expectedWriteVersion:2};const authorize=vi.fn(()=>true);const guard=vi.fn(async()=>{throw new Error('Historical source must not be revisited');});const options={...approval(),expectation,authorize};
  const result=method==='adopt'?await f.store.adopt(key,request().id,options):await f.store.adoptGuarded(key,request().id,options,guard);expect(result.status).toBe('adopted');expect(authorize).toHaveBeenCalledWith(options.actor,key,options.scope);expect(writes(f.events)).toEqual([]);expect(guard).not.toHaveBeenCalled();
  const denied={...options,authorize:()=>false};const revoked=method==='adopt'?await f.store.adopt(key,request().id,denied):await f.store.adoptGuarded(key,request().id,denied,guard);expect(revoked.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(writes(f.events)).toEqual([]);
});
it('captures expectations before a connection wait and caller mutation',async()=>{
  let proceed=()=>{};const gate=new Promise<void>(resolve=>{proceed=resolve;});const f=fixture('empty',gate);const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};const pending=f.store.submit(key,request(),{expectation});expectation.expectedSnapshotRevision=100;expectation.expectedWriteVersion=100;proceed();expect((await pending).status).toBe('candidate');
});

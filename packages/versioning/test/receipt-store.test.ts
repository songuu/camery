import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {PostgresVersionStore} from '../src/node/store';
import {VersionPersistenceError} from '../src/node/types';
import type {PersistedAdoptOptions,VersionTransactionReceipt,VersionTransactionContext} from '../src/node/types';
import {adoptChangeSet,createVersionState,submitChangeSet} from '../src/engine';
import {jsonSignature} from '../src/objects';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const key={tenantId:id('receipt-unit-tenant'),projectId:id('prj_demo')};
const approval=():PersistedAdoptOptions=>({actor:{kind:'user',id:id('user_1')},scope:{kind:'project',id:key.projectId},at:'2026-11-17T06:00:00.000Z',authorize:()=>true});
const request=()=>changeSet([{op:'update',op_id:id('receipt-unit-op'),collection:'shots',target:id('sh_1'),set:{action:'Actual receipt work'}}],{id:id('receipt-unit-change'),base_revisions:[{id:id('sh_1'),version:1}]});
function fixture(status:'empty'|'candidate'|'adopted'='candidate',gate?:Promise<void>){
  const candidate=submitChangeSet(createVersionState(makePackage()),request()).state;
  let state=status==='empty'?createVersionState(makePackage()):status==='adopted'?adoptChangeSet(candidate,request().id,{...approval(),authorize:()=>true}).state:candidate;
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
  const client=Object.assign(new EventEmitter(),{query,release:vi.fn()});const pool={query,connect:vi.fn(async()=>{await gate;return client;})};
  return {store:new PostgresVersionStore(pool as unknown as Pool),client,pool,events,adoptExternally(){state=adoptChangeSet(candidate,request().id,{...approval(),authorize:()=>true}).state;}};
}
const receiptFor=(f:ReturnType<typeof fixture>)=>vi.fn<VersionTransactionReceipt>(async(client,result)=>{expect(client).toBe(f.client);await client.query('receipt-check');expect(result.writeVersion).toBeGreaterThan(0);});
it('submits with an actual result receipt after all formal writes and before the owned COMMIT',async()=>{
  const f=fixture('empty');const receipt=receiptFor(f);const result=await f.store.submitWithReceipt(key,request(),{expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}},receipt);
  expect(result.status).toBe('candidate');expect(receipt).toHaveBeenCalledWith(f.client,result,{operation:'submit',project:key,expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1},requestSignature:jsonSignature(request())});expect(f.events[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
  expect(f.events.indexOf('receipt-check')).toBeGreaterThan(f.events.findIndex(text=>text.startsWith('UPDATE camery_versioning.projects')));expect(f.events.at(-1)).toBe('COMMIT');expect(f.client.release).toHaveBeenCalledWith(false);expect(f.client.listenerCount('error')).toBe(0);
});
it('rejects a candidate and receipts the actual rejection in the same owned transaction',async()=>{
  const f=fixture();const receipt=receiptFor(f);const result=await f.store.rejectWithReceipt(key,request().id,approval(),'Explicit human refusal',receipt);
  expect(result.state.changes[0]!.rejection).toMatchObject({actor_id:approval().actor.id,reason:'Explicit human refusal'});expect(receipt).toHaveBeenCalledWith(f.client,result,{operation:'reject',project:key,changeId:request().id,actor:approval().actor,scope:approval().scope,at:approval().at,reason:'Explicit human refusal'});expect(f.events.at(-2)).toBe('receipt-check');expect(f.events.at(-1)).toBe('COMMIT');
});
it('keeps source→version→receipt order and the existing four-argument guard compatible',async()=>{
  const f=fixture();const receipt=receiptFor(f);const result=await f.store.adoptGuarded(key,request().id,approval(),async client=>{await client.query('source-check');},receipt);
  expect(result.status).toBe('adopted');expect(f.events.indexOf('source-check')).toBeLessThan(f.events.findIndex(text=>text.includes('FOR UPDATE')));expect(f.events.indexOf('receipt-check')).toBeGreaterThan(f.events.findIndex(text=>text.startsWith('UPDATE camery_versioning.projects')));
  const old=fixture();expect((await old.store.adoptGuarded(key,request().id,approval(),async()=>{})).status).toBe('adopted');expect(old.events).not.toContain('receipt-check');
});
it.each(['submit','reject','adopt'] as const)('rolls %s and receipt back together when the trusted receipt callback fails',async action=>{
  const f=fixture(action==='submit'?'empty':'candidate');const receipt=vi.fn<VersionTransactionReceipt>(async client=>{await client.query('receipt-before-failure');throw new Error('postgresql://private-receipt');});
  const pending=action==='submit'?f.store.submitWithReceipt(key,request(),{},receipt):action==='reject'?f.store.rejectWithReceipt(key,request().id,approval(),'Explicit refusal',receipt):f.store.adoptGuarded(key,request().id,approval(),async()=>{},receipt);
  await expect(pending).rejects.toMatchObject({code:'DATABASE_ERROR'});expect(receipt).toHaveBeenCalledOnce();expect(f.events).not.toContain('COMMIT');expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.pool.connect).toHaveBeenCalledOnce();
});
it.each([undefined,null,{},'callback',42])('rejects a non-function required receipt %# before checkout',async receipt=>{
  const f=fixture();await expect(f.store.submitWithReceipt(key,request(),{},receipt as never)).rejects.toMatchObject({code:'INVALID_RECEIPT'});await expect(f.store.rejectWithReceipt(key,request().id,approval(),'reason',receipt as never)).rejects.toMatchObject({code:'INVALID_RECEIPT'});expect(f.pool.connect).not.toHaveBeenCalled();
});
it('rejects invalid optional receipt values and preserves explicitly absent receipt compatibility',async()=>{
  const f=fixture();await expect(f.store.adoptGuarded(key,request().id,approval(),async()=>{},null as never)).rejects.toMatchObject({code:'INVALID_RECEIPT'});expect(f.pool.connect).not.toHaveBeenCalled();expect((await f.store.adoptGuarded(key,request().id,approval(),async()=>{},undefined)).status).toBe('adopted');
});
it('never calls receipt when source validation or CAS fails',async()=>{
  const f=fixture();const receipt=receiptFor(f);await expect(f.store.adoptGuarded(key,request().id,approval(),async()=>{throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source',key.projectId);},receipt)).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});expect(receipt).not.toHaveBeenCalled();
  const g=fixture();await expect(g.store.rejectWithReceipt(key,request().id,{...approval(),expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}},'refuse',receipt)).rejects.toMatchObject({code:'WRITE_VERSION_CONFLICT'});expect(receipt).not.toHaveBeenCalled();
});
it('does not mistake a receipt error carrying a source refusal code for recoverable source validation',async()=>{
  const f=fixture();await expect(f.store.adoptGuarded(key,request().id,approval(),async()=>{},async()=>{throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','receipt',key.projectId);})).rejects.toMatchObject({code:'ADOPTION_SOURCE_CHANGED'});expect(f.pool.connect).toHaveBeenCalledOnce();
});
it('receipts exact historical submit/adopt results after stale CAS while preserving current adoption authorization',async()=>{
  const f=fixture('adopted');const receipt=receiptFor(f);const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};const authorize=vi.fn(()=>true);
  expect((await f.store.submitWithReceipt(key,request(),{expectation},receipt)).status).toBe('adopted');
  const guard=vi.fn(async()=>{throw new Error('Must not inspect historical source');});expect((await f.store.adoptGuarded(key,request().id,{...approval(),expectation,authorize},guard,receipt)).status).toBe('adopted');expect(guard).not.toHaveBeenCalled();expect(authorize).toHaveBeenCalledWith(approval().actor,key,approval().scope);
  const denied=await f.store.adoptGuarded(key,request().id,{...approval(),expectation,authorize:()=>false},guard,receipt);expect(denied.issues.map(issue=>issue.code)).toContain('ADOPTION_AUTHORITY');expect(receipt.mock.calls.at(-1)?.[1].status).toBe('rejected');
});
it('only receipts a concurrent historical recovery after renewed engine authorization',async()=>{
  const f=fixture();const receipt=receiptFor(f);const guard=vi.fn(async()=>{f.adoptExternally();throw new VersionPersistenceError('ADOPTION_SOURCE_CHANGED','source',key.projectId);});
  const result=await f.store.adoptGuarded(key,request().id,approval(),guard,receipt);expect(result.status).toBe('adopted');expect(f.pool.connect).toHaveBeenCalledTimes(2);expect(receipt).toHaveBeenCalledOnce();expect(receipt.mock.calls[0]?.[2]).toMatchObject({operation:'adopt',replayed:true});expect(f.events.indexOf('receipt-check')).toBeGreaterThan(f.events.indexOf('ROLLBACK'));
});
it('observes receipt-time checked-out connection errors, destroys it, and never commits',async()=>{
  const f=fixture();let handled=false;await expect(f.store.adoptGuarded(key,request().id,approval(),async()=>{},async()=>{handled=f.client.listenerCount('error')>0;f.client.emit('error',new Error('private socket failure'));})).rejects.toMatchObject({code:'DATABASE_ERROR'});
  expect(handled).toBe(true);expect(f.client.release).toHaveBeenCalledWith(true);expect(f.events).not.toContain('COMMIT');expect(f.client.listenerCount('error')).toBe(0);expect(f.pool.connect).toHaveBeenCalledOnce();
});
it('captures request, authority and expectation before awaiting a checked-out client',async()=>{
  let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const f=fixture('empty',gate);const command=request();const options={expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}};
  const pending=f.store.submitWithReceipt(key,command,options,async(_client,result,context)=>{expect(result.state.changes[0]!.request).toEqual(request());expect(context).toMatchObject({operation:'submit',requestSignature:jsonSignature(request())});});command.author.id=id('late-author');options.expectation.expectedWriteVersion=99;release();expect((await pending).status).toBe('candidate');
});
it('supplies frozen store-built submit and human decision contexts',async()=>{
  for(const action of ['submit','adopt','reject'] as const){const f=fixture(action==='submit'?'empty':'candidate');let context:VersionTransactionContext|undefined;
    const receipt:VersionTransactionReceipt=async(_client,_result,actual)=>{context=actual;};
    if(action==='submit')await f.store.submitWithReceipt(key,request(),{},receipt);else if(action==='adopt')await f.store.adoptGuarded(key,request().id,approval(),async()=>{},receipt);else await f.store.rejectWithReceipt(key,request().id,approval(),'Explicit reason',receipt);
    expect(context).toEqual(action==='submit'?{operation:'submit',project:key,requestSignature:jsonSignature(request())}:action==='adopt'?{operation:'adopt',project:key,changeId:request().id,actor:approval().actor,scope:approval().scope,at:approval().at,replayed:false}:{operation:'reject',project:key,changeId:request().id,actor:approval().actor,scope:approval().scope,at:approval().at,reason:'Explicit reason'});
    expect(Object.hasOwn(context!,'expectation')).toBe(false);expect(Object.isFrozen(context?.project)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);if(context?.operation!=='submit'){expect(Object.isFrozen(context?.actor)).toBe(true);expect(Object.isFrozen(context?.scope)).toBe(true);}
  }
});
it('captures decision actor, scope and time before checkout and reports the actual request on historical replay',async()=>{
  let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const f=fixture('adopted',gate);const options=approval();options.actor.id=id('current-retry-human');options.at='2026-11-17T07:00:00.000Z';const expected={operation:'adopt',project:key,changeId:request().id,actor:{...options.actor},scope:{...options.scope},at:options.at,replayed:true};const receipt=vi.fn<VersionTransactionReceipt>(async()=>{});
  const pending=f.store.adoptGuarded(key,request().id,options,async()=>{throw new Error('Historical source is not read');},receipt);options.actor.id=id('mutated');options.scope.id=id('mutated-project');options.at='2026-11-17T08:00:00.000Z';release();expect((await pending).status).toBe('adopted');expect(receipt.mock.calls[0]?.[2]).toEqual(expected);
});
it('computes adopted replay under the actual project lock rather than the earlier status peek',async()=>{
  const f=fixture();const original=f.client.query.getMockImplementation()!;let changed=false;f.client.query.mockImplementation(async input=>{const text=typeof input==='string'?input:input.text;if(text.includes('FOR UPDATE')&&!changed){changed=true;f.adoptExternally();}return original(input);});
  const receipt=vi.fn<VersionTransactionReceipt>(async()=>{});const guard=vi.fn(async()=>{});expect((await f.store.adoptGuarded(key,request().id,approval(),guard,receipt)).status).toBe('adopted');expect(guard).toHaveBeenCalledOnce();expect(receipt.mock.calls[0]?.[2]).toMatchObject({operation:'adopt',replayed:true});
});
it('sets replay false for a newly refused adoption even though no formal mutation occurred',async()=>{
  const f=fixture();const receipt=vi.fn<VersionTransactionReceipt>(async()=>{});const result=await f.store.adoptGuarded(key,request().id,{...approval(),authorize:()=>false},async()=>{},receipt);expect(result.status).toBe('rejected');expect(receipt.mock.calls[0]?.[2]).toMatchObject({operation:'adopt',replayed:false});
});
it('preserves captured rejection scope and reason in the receipt context after an asynchronous wait',async()=>{
  let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const f=fixture('candidate',gate);const options=approval();options.scope={kind:'scene',id:id('sc_1')};const receipt=vi.fn<VersionTransactionReceipt>(async()=>{});
  const pending=f.store.rejectWithReceipt(key,request().id,options,'Original reason',receipt);options.scope.kind='project';options.scope.id=id('mutated');options.actor.id=id('mutated');options.at='2026-11-17T08:00:00.000Z';release();expect((await pending).status).toBe('rejected');expect(receipt.mock.calls[0]?.[2]).toEqual({operation:'reject',project:key,changeId:request().id,actor:approval().actor,scope:{kind:'scene',id:id('sc_1')},at:approval().at,reason:'Original reason'});
});
it.each(['submit','adopt','reject'] as const)('binds the captured project and original CAS to the %s execution envelope',async action=>{
  let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});const f=fixture(action==='submit'?'empty':'candidate',gate);const mutableKey={...key};const expectation={expectedSnapshotRevision:5,expectedWriteVersion:action==='submit'?1:2};const originalExpectation={...expectation};const receipt=vi.fn<VersionTransactionReceipt>(async()=>{});
  const pending=action==='submit'?f.store.submitWithReceipt(mutableKey,request(),{expectation},receipt):action==='adopt'?f.store.adoptGuarded(mutableKey,request().id,{...approval(),expectation},async()=>{},receipt):f.store.rejectWithReceipt(mutableKey,request().id,{...approval(),expectation},'original reason',receipt);
  mutableKey.tenantId=id('mutated-tenant');mutableKey.projectId=id('mutated-project');expectation.expectedSnapshotRevision=99;expectation.expectedWriteVersion=99;release();await pending;
  const context=receipt.mock.calls[0]?.[2];expect(context?.project).toEqual(key);expect(context?.expectation).toEqual(originalExpectation);expect(Object.isFrozen(context?.project)).toBe(true);expect(Object.isFrozen(context?.expectation)).toBe(true);
  if(context?.operation==='submit')expect(context.requestSignature).toBe(jsonSignature(request()));else expect(context?.changeId).toBe(request().id);
});
it('keeps the originally supplied CAS in a historical adoption envelope instead of substituting the current head',async()=>{
  const f=fixture('adopted');const receipt=vi.fn<VersionTransactionReceipt>(async()=>{});const expectation={expectedSnapshotRevision:5,expectedWriteVersion:1};await f.store.adoptGuarded(key,request().id,{...approval(),expectation},async()=>{},receipt);expect(receipt.mock.calls[0]?.[2]).toMatchObject({operation:'adopt',project:key,changeId:request().id,expectation,replayed:true});
});
it('never reads exception code or cause getters while sanitizing receipt failures',async()=>{
  const getter=vi.fn(()=>{throw new Error('private error getter');});
  const failures=[Object.defineProperty({},'code',{get:getter}),Object.defineProperty(new Error('private'),'cause',{get:getter}),new Error('private',{cause:Object.defineProperty({},'code',{get:getter})}),Object.create(Object.defineProperty({},'code',{get:getter}))];
  for(const failure of failures){const f=fixture();const actual=await f.store.adoptGuarded(key,request().id,approval(),async()=>{},async()=>{throw failure;}).catch((error:unknown)=>error);expect(actual).toBeInstanceOf(VersionPersistenceError);expect(actual).toMatchObject({code:'DATABASE_ERROR',databaseCode:undefined});expect((actual as Error).message).not.toContain('private');expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.pool.connect).toHaveBeenCalledOnce();}expect(getter).not.toHaveBeenCalled();
});
it('sanitizes throwing proxy traps without leaking their exception or retrying',async()=>{
  const failures=[new Proxy({},{getOwnPropertyDescriptor(){throw new Error('private descriptor');}}),new Proxy({},{getPrototypeOf(){throw new Error('private prototype');}})];
  for(const failure of failures){const f=fixture();const actual=await f.store.adoptGuarded(key,request().id,approval(),async()=>{},async()=>{throw failure;}).catch((error:unknown)=>error);expect(actual).toBeInstanceOf(VersionPersistenceError);expect(actual).toMatchObject({code:'DATABASE_ERROR',databaseCode:undefined});expect((actual as Error).message).not.toContain('private');expect(f.events.at(-1)).toBe('ROLLBACK');expect(f.pool.connect).toHaveBeenCalledOnce();}
});
it.each([{code:'40001'},new Error('private',{cause:{code:'23505'}})])('preserves only an own data SQLSTATE from the driver error %#',async failure=>{
  const f=fixture();await expect(f.store.adoptGuarded(key,request().id,approval(),async()=>{},async()=>{throw failure;})).rejects.toMatchObject({code:'DATABASE_ERROR',databaseCode:failure instanceof Error?'23505':'40001'});
});
it.each(['23505\n','private',null,42])('discards a noncanonical driver SQLSTATE %#',async code=>{
  const f=fixture();await expect(f.store.adoptGuarded(key,request().id,approval(),async()=>{},async()=>{throw {code};})).rejects.toMatchObject({code:'DATABASE_ERROR',databaseCode:undefined});
});

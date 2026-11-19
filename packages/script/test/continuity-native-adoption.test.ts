import {expect,it,vi} from 'vitest';
import {submitChangeSet,adoptChangeSet} from '@camery/versioning';
import type {VersionTransactionContext,PersistedChangeResult} from '@camery/versioning/node';
import {nativeContinuityFixture,id} from './continuity-native-support.js';
import {createContinuityNativeSubmissionReceipt,createContinuityNativeAdoptionHooks} from '../src/continuity/node/native-adoption.js';
import {readContinuityNativeAdoption} from '../src/continuity/node/source.js';
import {captureContinuityContext} from '../src/continuity/context.js';
import {reviewContinuityCandidate} from '../src/continuity/node/review.js';
import {continuityReviewDigest} from '../src/continuity/node/history.js';
import {CONTINUITY_NATIVE_RECORD_BYTES} from '../src/continuity/node/native-contracts.js';
import {continuityDigest} from '../src/continuity/node/digest.js';

type AdoptionContext=Extract<VersionTransactionContext,{operation:'adopt'}>;

async function prepared(){
  const f=await nativeContinuityFixture(false),client=await f.pool.connect(),expectation={expectedSnapshotRevision:f.mapping.binding.sourceRevision,expectedWriteVersion:1};
  const callback=createContinuityNativeSubmissionReceipt({mapping:f.mapping,expectation},f.store,f.memory.host),native=submitChangeSet(f.memory.state,f.mapping.request);f.memory.state=native.state;
  const result:PersistedChangeResult={...native,writeVersion:2},context:VersionTransactionContext={project:f.memory.target,expectation,operation:'submit',requestSignature:JSON.stringify(f.mapping.request)};
  await callback(client,result,context);return {...f,client,result,context,callback};
}
async function adopted(persistProof=true){
  const f=await prepared(),expectation={expectedSnapshotRevision:f.mapping.binding.sourceRevision,expectedWriteVersion:2},actorId=id('actual-adopter');
  const hooks=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation,actorId},f.store,f.memory.host);await hooks.guard(f.client);
  const adoptionContext:AdoptionContext={project:f.memory.target,expectation,operation:'adopt',changeId:f.mapping.request.id,actor:{kind:'user',id:actorId},scope:{kind:'episode',id:f.mapping.binding.episodeId},at:f.memory.host.at,replayed:false};
  const native=adoptChangeSet(f.memory.state,f.mapping.request.id,{actor:adoptionContext.actor,scope:adoptionContext.scope,at:adoptionContext.at,authorize:()=>true});
  if(native.status!=='adopted')throw new Error('Expected actual pure native adoption');f.memory.state=native.state;f.memory.snapshots.set(native.state.head.revision.number,structuredClone(native.state.head));
  const nativeResult:PersistedChangeResult={...native,writeVersion:3};if(persistProof)await hooks.receipt(f.client,nativeResult,adoptionContext);
  return {...f,hooks,nativeResult,adoptionContext,actorId,expectation};
}
function writes(sql:readonly string[]):string[]{return sql.filter(text=>text.startsWith('INSERT'));}
it('binds a reviewed candidate on submit and writes a verified proof on the actual native adoption callback',async()=>{
  const f=await prepared();try{
    expect(f.tables.native_bindings).toHaveLength(1);const expectation={expectedSnapshotRevision:f.mapping.binding.sourceRevision,expectedWriteVersion:2};
    const hooks=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation,actorId:id('actual-adopter')},f.store,f.memory.host);await hooks.guard(f.client);
    const context:VersionTransactionContext={project:f.memory.target,expectation,operation:'adopt',changeId:f.mapping.request.id,actor:{kind:'user',id:id('actual-adopter')},scope:{kind:'episode',id:f.mapping.binding.episodeId},at:f.memory.host.at,replayed:false};
    const native=adoptChangeSet(f.memory.state,f.mapping.request.id,{actor:context.actor,scope:context.scope,at:context.at,authorize:()=>true});expect(native.status).toBe('adopted');f.memory.state=native.state;f.memory.snapshots.set(native.state.head.revision.number,structuredClone(native.state.head));
    await hooks.receipt(f.client,{...native,writeVersion:3},context);expect(f.tables.native_adoptions).toHaveLength(1);
    const proof=await readContinuityNativeAdoption(f.client,{scope:f.memory.scope,target:f.memory.target,changeId:f.mapping.request.id});expect(proof.ledger).toEqual(f.mapping.snapshot.ledger);expect(proof.origin.bindingDigest).toBe(f.mapping.binding.digest);
    await hooks.receipt(f.client,{...native,writeVersion:3},{...context,replayed:true});expect(f.tables.native_adoptions).toHaveLength(1);
  }finally{f.client.release();}
});
it('refuses a mismatched execution request and current-source guard after the native head advances',async()=>{
  const f=await prepared();try{
    await expect(f.callback(f.client,f.result,{...f.context,operation:'submit',requestSignature:JSON.stringify({...f.mapping.request,author:{kind:'user',id:id('forged')}})})).rejects.toMatchObject({code:'CONFLICT'});
    f.memory.advance();const hooks=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation:{expectedSnapshotRevision:f.mapping.binding.sourceRevision,expectedWriteVersion:2},actorId:id('actual-adopter')},f.store,f.memory.host);
    await expect(hooks.guard(f.client)).rejects.toMatchObject({code:'ADOPTION_SOURCE_INVALID'});
  }finally{f.client.release();}
});
it('re-authorizes even an existing submission acknowledgement',async()=>{
  const f=await prepared();try{
    const denied=createContinuityNativeSubmissionReceipt({mapping:f.mapping,expectation:f.context.expectation!},f.store,{...f.memory.host,authorize:()=>false});
    await expect(denied(f.client,f.result,f.context)).rejects.toMatchObject({code:'FORBIDDEN'});
  }finally{f.client.release();}
});

it('refuses to invent a missing proof for an already-adopted native ACK',async()=>{
  const f=await adopted(false);try{
    expect(f.memory.state.changes.find(row=>row.request.id===f.mapping.request.id)?.status).toBe('adopted');expect(f.tables.native_adoptions).toEqual([]);const before=f.calls.length;
    await expect(f.hooks.receipt(f.client,f.nativeResult,{...f.adoptionContext,replayed:true})).rejects.toMatchObject({code:'CONFLICT',path:'missing original adoption proof'});
    expect(f.tables.native_adoptions).toEqual([]);expect(writes(f.calls.slice(before))).toEqual([]);
  }finally{f.client.release();}
});

it('denies a revoked historical adoption ACK before any database lookup',async()=>{
  const f=await adopted();try{
    const denied=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation:f.expectation,actorId:f.actorId},f.store,{...f.memory.host,authorize:()=>false});
    const beforeNative=f.calls.length,beforeSource=f.memory.calls.length;
    await expect(denied.receipt(f.client,f.nativeResult,{...f.adoptionContext,replayed:true})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(f.calls).toHaveLength(beforeNative);expect(f.memory.calls).toHaveLength(beforeSource);expect(f.tables.native_adoptions).toHaveLength(1);
    await expect(denied.guard(f.client)).rejects.toMatchObject({code:'ADOPTION_SOURCE_INVALID'});expect(f.calls).toHaveLength(beforeNative);expect(f.memory.calls).toHaveLength(beforeSource);
  }finally{f.client.release();}
});

it.each(['actor','actor-kind','scope','scope-kind','time','change','expectation','tenant','project','operation'] as const)('refuses mismatched actual adoption context %s',async field=>{
  const f=await adopted(false);try{
    const base=f.adoptionContext,context:AdoptionContext={...base,
      actor:field==='actor'?{...base.actor,id:id('wrong-adopter')}:field==='actor-kind'?{...base.actor,kind:'agent_run'}:base.actor,
      scope:field==='scope'?{...base.scope,id:id('wrong-episode')}:field==='scope-kind'?{...base.scope,kind:'project'}:base.scope,
      at:field==='time'?'2026-11-19T04:01:00.000Z':base.at,changeId:field==='change'?id('wrong-change'):base.changeId,
      expectation:field==='expectation'?{...f.expectation,expectedWriteVersion:f.expectation.expectedWriteVersion+1}:f.expectation,
      project:field==='tenant'?{...base.project,tenantId:id('wrong-native-tenant')}:field==='project'?{...base.project,projectId:id('wrong-native-project')}:base.project};
    const actual:VersionTransactionContext=field==='operation'?{operation:'submit',project:context.project,expectation:f.expectation,requestSignature:JSON.stringify(f.mapping.request)}:context,before=f.calls.length;
    await expect(f.hooks.receipt(f.client,f.nativeResult,actual)).rejects.toMatchObject({code:'CONFLICT'});expect(f.tables.native_adoptions).toEqual([]);expect(writes(f.calls.slice(before))).toEqual([]);
  }finally{f.client.release();}
});

it.each(['value','collection','object-change','version','object-id','snapshot-revision','missing-object','from','to','audit-scope','audit-actor','audit-time','missing-audit','change-status','missing-change','request','target'] as const)('rejects inconsistent actual native history %s before writing proof',async field=>{
  const f=await adopted(false);try{
    const result=structuredClone(f.nativeResult),object=result.state.revisions.find(row=>row.object_id===f.mapping.snapshot.id)!,audit=result.state.adoptions.find(row=>row.change_set_id===f.mapping.request.id)!,change=result.state.changes.find(row=>row.request.id===f.mapping.request.id)!;
    if(field==='value')object.value={...object.value,ledger:{...f.mapping.snapshot.ledger,episodeId:id('wrong-ledger-episode')}};
    else if(field==='collection')object.collection='episode_state_snapshots';else if(field==='object-change')object.change_set_id=id('wrong-object-change');else if(field==='version')object.version++;else if(field==='object-id')object.object_id=id('wrong-object');else if(field==='snapshot-revision')object.snapshot_revision++;else if(field==='missing-object')result.state.revisions=result.state.revisions.filter(row=>row!==object);
    else if(field==='from')audit.from_revision++;else if(field==='to')audit.to_revision++;else if(field==='audit-scope')audit.scope.id=id('wrong-audit-episode');else if(field==='audit-actor')audit.actor_id=id('wrong-audit-actor');else if(field==='audit-time')audit.at='2026-11-19T04:02:00.000Z';else if(field==='missing-audit')result.state.adoptions=[];else if(field==='change-status')change.status='candidate';else if(field==='missing-change')result.state.changes=[];else if(field==='request')change.request.author.id=id('changed-native-request-author');else result.state.head.project.id=id('wrong-result-project');
    const before=f.calls.length;await expect(f.hooks.receipt(f.client,result,f.adoptionContext)).rejects.toMatchObject({code:'CONFLICT'});expect(f.tables.native_adoptions).toEqual([]);expect(writes(f.calls.slice(before))).toEqual([]);
  }finally{f.client.release();}
});

it.each(['status','request','missing'] as const)('requires the guarded native request itself to remain a matching live candidate: %s',async field=>{
  const f=await prepared();try{
    const change=f.memory.state.changes.find(row=>row.request.id===f.mapping.request.id)!;
    if(field==='status')change.status='rejected';else if(field==='request')change.request.author.id=id('changed-guard-request-author');else f.memory.state.changes=[];
    const hooks=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation:{expectedSnapshotRevision:f.mapping.binding.sourceRevision,expectedWriteVersion:2},actorId:id('actual-adopter')},f.store,f.memory.host),before=f.calls.length;
    await expect(hooks.guard(f.client)).rejects.toMatchObject({code:'ADOPTION_SOURCE_INVALID'});expect(writes(f.calls.slice(before))).toEqual([]);expect(f.tables.native_adoptions).toEqual([]);
  }finally{f.client.release();}
});

it('refuses to rebind an existing native request to a different self-consistent review digest',async()=>{
  const f=await prepared();try{
    const mapping=structuredClone(f.mapping);mapping.binding.reviewDigest='a'.repeat(64);const {digest:_digest,...body}=mapping.binding;mapping.binding.digest=continuityDigest(body,CONTINUITY_NATIVE_RECORD_BYTES);
    const callback=createContinuityNativeSubmissionReceipt({mapping,expectation:f.context.expectation!},f.store,f.memory.host),before=f.calls.length;
    await expect(callback(f.client,f.result,f.context)).rejects.toMatchObject({code:'CONFLICT',path:'immutable submission'});expect(writes(f.calls.slice(before))).toEqual([]);
  }finally{f.client.release();}
});

it('recovers the original proof after an unrelated head change with a different currently-authorized human and time',async()=>{
  const f=await adopted();try{
    const original=structuredClone(f.tables.native_adoptions);f.memory.advance();const actorId=id('new-ack-human'),at='2026-11-19T05:00:00.000Z',authorize=vi.fn(()=>true),hostAuthorize=vi.fn(()=>true);
    const host={...f.memory.host,actor:{kind:'human' as const,id:'new-ack-reviewer'},at,authorize:hostAuthorize},hooks=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation:f.expectation,actorId},f.store,host);
    const native=adoptChangeSet(f.memory.state,f.mapping.request.id,{actor:{kind:'user',id:actorId},scope:f.adoptionContext.scope,at,authorize});expect(native.status).toBe('adopted');expect(authorize).toHaveBeenCalledOnce();
    const before=f.calls.length;await hooks.receipt(f.client,{...native,writeVersion:5},{...f.adoptionContext,actor:{kind:'user',id:actorId},at,replayed:true});
    expect(hostAuthorize).toHaveBeenCalledWith({action:'continuity:review',scope:f.memory.scope});expect(f.tables.native_adoptions).toEqual(original);expect(writes(f.calls.slice(before))).toEqual([]);
    const proof=await readContinuityNativeAdoption(f.client,{scope:f.memory.scope,target:f.memory.target,changeId:f.mapping.request.id});expect(proof.adoptedRevision).toBe(f.mapping.binding.sourceRevision+1);expect(f.memory.state.head.revision.number).toBeGreaterThan(proof.adoptedRevision);
  }finally{f.client.release();}
});

it('restores an existing submission ACK from its historical source without authorizing a new adoption',async()=>{
  const f=await prepared();try{
    const original=structuredClone(f.tables.native_bindings);f.memory.advance();const replay=submitChangeSet(f.memory.state,f.mapping.request);expect(replay.status).toBe('candidate');const before=f.calls.length;
    await f.callback(f.client,{...replay,writeVersion:4},f.context);expect(f.tables.native_bindings).toEqual(original);expect(writes(f.calls.slice(before))).toEqual([]);
    const hooks=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation:{expectedSnapshotRevision:f.mapping.binding.sourceRevision,expectedWriteVersion:2},actorId:id('actual-adopter')},f.store,f.memory.host);await expect(hooks.guard(f.client)).rejects.toMatchObject({code:'ADOPTION_SOURCE_INVALID'});
  }finally{f.client.release();}
});

it('rejects a replaced but fully-valid human review when restoring an existing submission ACK',async()=>{
  const f=await prepared();try{
    const context=captureContinuityContext(f.memory.snapshots.get(f.mapping.binding.sourceRevision)!),draft=structuredClone(f.command.draft),fact=draft.events[0]!;if(fact.op!=='assert_fact')throw new Error('Expected fact');fact.text='另一份自洽的人审输出。';
    const decision={candidateDigest:f.original.preparation.candidate.digest,draft,waivers:[]},review=reviewContinuityCandidate(context,f.original.preparation.candidate,decision,f.memory.host),row=f.memory.reviewRow();
    row['record']=review;row['digest']=review.digest;row['request_digest']=continuityReviewDigest('reviewed',decision,f.memory.host.actor.id);f.memory.advance();
    const before=f.calls.length;await expect(f.callback(f.client,{...submitChangeSet(f.memory.state,f.mapping.request),writeVersion:4},f.context)).rejects.toMatchObject({code:'CONFLICT',path:'complete reviewed mapping'});expect(writes(f.calls.slice(before))).toEqual([]);expect(f.tables.native_adoptions).toEqual([]);
  }finally{f.client.release();}
});

it('keeps native authorization failure as a refusal without manufacturing adopted ledger authority',async()=>{
  const f=await prepared();try{
    const expectation={expectedSnapshotRevision:f.mapping.binding.sourceRevision,expectedWriteVersion:2},actorId=id('actual-adopter'),hooks=createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation,actorId},f.store,f.memory.host),context:AdoptionContext={project:f.memory.target,expectation,operation:'adopt',changeId:f.mapping.request.id,actor:{kind:'user',id:actorId},scope:{kind:'episode',id:f.mapping.binding.episodeId},at:f.memory.host.at,replayed:false};
    const refused=adoptChangeSet(f.memory.state,f.mapping.request.id,{actor:context.actor,scope:context.scope,at:context.at,authorize:()=>false});expect(refused.status).not.toBe('adopted');const before=f.calls.length;
    await hooks.receipt(f.client,{...refused,writeVersion:2},context);expect(f.tables.native_adoptions).toEqual([]);expect(writes(f.calls.slice(before))).toEqual([]);
  }finally{f.client.release();}
});

it.each(['bad-json','wrong-json','over-budget'] as const)('refuses %s execution signatures without exposing their contents',async kind=>{
  const f=await prepared();try{
    const requestSignature=kind==='bad-json'?'{"private-credential":':kind==='wrong-json'?'{}':'x'.repeat(CONTINUITY_NATIVE_RECORD_BYTES+1);
    const before=f.calls.length,error=await f.callback(f.client,f.result,{...f.context,operation:'submit',requestSignature}).catch(value=>value as Error);expect(error).toBeInstanceOf(Error);if(!(error instanceof Error))throw new Error('Expected safe signature refusal');expect(error.message).not.toContain('private-credential');expect(writes(f.calls.slice(before))).toEqual([]);
  }finally{f.client.release();}
});

it('captures strict factory data without invoking caller accessors and rejects mismatched source expectations',async()=>{
  const f=await prepared();try{
    let touched=false;const unsafe=Object.defineProperty({mapping:f.mapping,expectation:f.context.expectation!},'mapping',{enumerable:true,get:()=>{touched=true;return f.mapping;}});
    expect(()=>createContinuityNativeSubmissionReceipt(unsafe,f.store,f.memory.host)).toThrow('INVALID_INPUT');expect(touched).toBe(false);
    expect(()=>createContinuityNativeSubmissionReceipt({mapping:f.mapping,expectation:{expectedSnapshotRevision:f.mapping.binding.sourceRevision+1,expectedWriteVersion:1}},f.store,f.memory.host)).toThrow('CONFLICT');
    expect(()=>createContinuityNativeAdoptionHooks({mapping:f.mapping,expectation:{expectedSnapshotRevision:f.mapping.binding.sourceRevision+1,expectedWriteVersion:2},actorId:id('actual-adopter')},f.store,f.memory.host)).toThrow('CONFLICT');
    const statusClaim=Object.assign({mapping:f.mapping,expectation:f.context.expectation!},{status:'adopted'});expect(()=>createContinuityNativeSubmissionReceipt(statusClaim,f.store,f.memory.host)).toThrow('INVALID_INPUT');
  }finally{f.client.release();}
});

it('sanitizes an underlying source-port failure and preserves the unbound candidate for a later explicit retry',async()=>{
  const f=await prepared();try{
    f.tables.native_bindings.length=0;const broken={readForAdoption:async()=>{throw new Error('postgresql://private-source-credential');}},callback=createContinuityNativeSubmissionReceipt({mapping:f.mapping,expectation:f.context.expectation!},broken,f.memory.host),before=f.calls.length;
    const error=await callback(f.client,f.result,f.context).catch(value=>value as Error);expect(error).toMatchObject({code:'STORAGE_FAILED'});if(!(error instanceof Error))throw new Error('Expected source-port failure');expect(error.message).not.toContain('private-source-credential');expect(writes(f.calls.slice(before))).toEqual([]);expect(f.tables.native_bindings).toEqual([]);
    await f.callback(f.client,f.result,f.context);expect(f.tables.native_bindings).toHaveLength(1);expect(f.tables.native_adoptions).toEqual([]);
  }finally{f.client.release();}
});

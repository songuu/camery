import type {PoolClient} from 'pg';
import {expect,it,vi} from 'vitest';
import {StoryboardPackageV07} from '@camery/ir';
import {createVersionState} from '@camery/versioning';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {CONTINUITY_NATIVE_RECORD_BYTES} from '../src/continuity/node/native-contracts.js';
import type {ContinuityNativeBinding,ContinuityNativeReceipt} from '../src/continuity/node/native-contracts.js';
import {continuityProofWalk,enqueueContinuityNativeProof,drainContinuityNativeProofs} from '../src/continuity/node/native-proof.js';
import type {ContinuityProofWalk} from '../src/continuity/node/native-proof.js';
import {readContinuityNativeBinding,readContinuityNativeReceipt} from '../src/continuity/node/native-records.js';
import {readStoredContinuitySource,resolveContinuityNativePredecessor} from '../src/continuity/node/source.js';
import {nativeContinuityFixture,id} from './continuity-native-support.js';
import type {NativeFixture} from './continuity-native-support.js';

function signed<T extends {digest:string}>(record:T):T{const {digest:_digest,...body}=record;return {...record,digest:continuityDigest(body,CONTINUITY_NATIVE_RECORD_BYTES)};}
function saveBinding(f:NativeFixture,record:ContinuityNativeBinding){
  const value=signed(record);f.tables.native_bindings[0]={tenant_id:value.key.tenantId,project_id:value.key.projectId,candidate_id:value.key.candidateId,
    formal_tenant_id:value.target.tenantId,formal_project_id:value.target.projectId,change_id:value.changeId,snapshot_id:value.snapshot.id,snapshot_version:value.snapshot.version,
    source_revision:value.sourceRevision,candidate_digest:value.candidateDigest,review_digest:value.reviewDigest,request_digest:value.requestDigest,digest:value.digest,record:value};return value;
}
function saveReceipt(f:NativeFixture,record:ContinuityNativeReceipt){
  const value=signed(record);f.tables.native_adoptions[0]={formal_tenant_id:value.target.tenantId,formal_project_id:value.target.projectId,change_id:value.changeId,
    snapshot_id:value.snapshot.id,snapshot_version:value.snapshot.version,from_revision:value.fromRevision,to_revision:value.toRevision,binding_digest:value.bindingDigest,
    review_digest:value.reviewDigest,ledger_digest:value.ledgerDigest,digest:value.digest,record:value};return value;
}
const predecessorSelection=(f:NativeFixture)=>({...f.selection,episodeId:f.mapping.binding.episodeId});
async function assertSelfConsistent(client:PoolClient,binding:ContinuityNativeBinding,receipt:ContinuityNativeReceipt){
  expect(await readContinuityNativeBinding(client,binding.target,binding.changeId)).toEqual(binding);
  expect(await readContinuityNativeReceipt(client,receipt.target,receipt.changeId)).toEqual(receipt);
}
async function enqueueActual(f:NativeFixture,client:PoolClient,walk:ContinuityProofWalk){
  const previous=await resolveContinuityNativePredecessor(client,predecessorSelection(f));if(previous?.version!==2)throw new Error('Expected actual reviewed native predecessor');
  const audit=f.memory.state.adoptions.find(row=>row.change_set_id===previous.changeId)!,change=f.memory.state.changes.find(row=>row.request.id===previous.changeId)!;
  await enqueueContinuityNativeProof(client,previous,f.mapping.snapshot,audit,change.request,walk);return {previous,audit,request:change.request};
}

it.each(['legacy-schema','no-typed-snapshot'] as const)('returns no typed authority for %s',async kind=>{
  const f=await nativeContinuityFixture(false);
  if(kind==='legacy-schema'){
    const head=f.memory.state.head;if(head.schema_version!=='0.8.0-draft')throw new Error('Expected v08 fixture');
    const {continuity_snapshots:_typed,...legacy}=head,old=StoryboardPackageV07.parse({...legacy,schema_version:'0.7.0-draft'});
    f.memory.state=createVersionState(old);f.memory.snapshots=new Map([[old.revision.number,structuredClone(old)]]);
  }
  const client=await f.pool.connect();try{expect(await resolveContinuityNativePredecessor(client,predecessorSelection(f))).toBeNull();}finally{client.release();}
});

it.each(['ordinary-scope','candidate-digest','review-digest','package-digest','operation-id','author'] as const)('rejects a self-consistent %s binding against actual native and human records',async kind=>{
  const f=await nativeContinuityFixture(),raw=structuredClone(f.mapping.binding);
  if(kind==='ordinary-scope')raw.key.tenantId='different-ordinary-tenant';
  else if(kind==='candidate-digest')raw.candidateDigest='0'.repeat(64);
  else if(kind==='review-digest')raw.reviewDigest='0'.repeat(64);
  else if(kind==='package-digest')raw.packageDigest='0'.repeat(64);
  else if(kind==='operation-id')raw.operationId=id('different-reviewed-operation');
  else raw.author.id=id('different-native-author');
  const binding=saveBinding(f,raw);if(!f.receipt)throw new Error('Expected adopted receipt');
  const receipt=saveReceipt(f,{...structuredClone(f.receipt),key:binding.key,bindingDigest:binding.digest,reviewDigest:binding.reviewDigest});
  const client=await f.pool.connect();try{
    await assertSelfConsistent(client,binding,receipt);
    await expect(resolveContinuityNativePredecessor(client,predecessorSelection(f))).rejects.toMatchObject({code:'UNADOPTED_SNAPSHOT'});
  }finally{client.release();}
});

it('does not substitute a different real reviewed candidate even after every binding and receipt hash is replaced',async()=>{
  const f=await nativeContinuityFixture(false),key={...f.command.key,candidateId:'different-real-candidate'},draft=structuredClone(f.command.draft),fact=draft.events[0]!;
  if(fact.op!=='assert_fact')throw new Error('Expected fixture fact');fact.text='另一候选明确审阅了不同的事实。';
  const source=await f.store.describeSource({...f.selection,episodeId:draft.episodeId},f.memory.host);
  const prepared=await f.store.prepare({key,target:f.memory.target,expectedSnapshotRevision:source.source.snapshotRevision,expectedPackageDigest:source.source.packageDigest,draft},f.memory.host);
  const reviewed=await f.store.confirm(key,{candidateDigest:prepared.preparation.candidate.digest,draft,waivers:[]},f.memory.host);
  if(reviewed.review?.status!=='reviewed')throw new Error('Expected two actual human reviews');const actualReceipt=await f.commit();
  const binding=saveBinding(f,{...structuredClone(f.mapping.binding),key,candidateDigest:reviewed.preparation.candidate.digest,reviewDigest:reviewed.review.digest,
    sourceRevision:reviewed.preparation.source.snapshotRevision,packageDigest:reviewed.preparation.source.packageDigest});
  const receipt=saveReceipt(f,{...structuredClone(actualReceipt),key,bindingDigest:binding.digest,reviewDigest:binding.reviewDigest});
  const client=await f.pool.connect();try{
    await assertSelfConsistent(client,binding,receipt);
    await expect(resolveContinuityNativePredecessor(client,predecessorSelection(f))).rejects.toMatchObject({code:'UNADOPTED_SNAPSHOT',path:'historical human review'});
  }finally{client.release();}
});

it.each(['actor','episode-scope','timestamp','from-to-revisions'] as const)('binds self-consistent receipt %s to the actual native adoption audit',async kind=>{
  const f=await nativeContinuityFixture();if(!f.receipt)throw new Error('Expected adopted receipt');const raw=structuredClone(f.receipt);
  if(kind==='actor')raw.actor.id=id('different-approving-human');
  else if(kind==='episode-scope')raw.scope.id=id('ep_2');
  else if(kind==='timestamp')raw.at='2026-11-19T03:01:00.000Z';
  else{raw.fromRevision--;raw.toRevision--;}
  const receipt=saveReceipt(f,raw),client=await f.pool.connect();try{
    await assertSelfConsistent(client,f.mapping.binding,receipt);
    await expect(resolveContinuityNativePredecessor(client,predecessorSelection(f))).rejects.toMatchObject({name:'ContinuityError'});
  }finally{client.release();}
});

it('recompiles the historical human mapping when a native request and all its advertised hashes consistently change',async()=>{
  const f=await nativeContinuityFixture(),change=f.memory.state.changes.find(row=>row.request.id===f.mapping.binding.changeId)!;
  change.request.ops[0]!.op_id=id('request-operation-never-fixed-by-human-mapping');
  const binding=saveBinding(f,{...structuredClone(f.mapping.binding),requestDigest:continuityDigest(change.request,CONTINUITY_NATIVE_RECORD_BYTES)});
  if(!f.receipt)throw new Error('Expected adopted receipt');const receipt=saveReceipt(f,{...structuredClone(f.receipt),bindingDigest:binding.digest});
  const client=await f.pool.connect();try{
    await assertSelfConsistent(client,binding,receipt);
    await expect(resolveContinuityNativePredecessor(client,predecessorSelection(f))).rejects.toMatchObject({code:'UNADOPTED_SNAPSHOT',path:'replayed native request'});
  }finally{client.release();}
});

it.each(['identity','version','full-digest','missing-current'] as const)('refuses a queued historical proof with a changed current snapshot %s',async kind=>{
  const f=await nativeContinuityFixture(),head=f.memory.state.head;if(head.schema_version!=='0.8.0-draft')throw new Error('Expected v08 fixture');
  const walk=continuityProofWalk(head),client=await f.pool.connect();try{
    await enqueueActual(f,client,walk);const current=new Map(walk.currentSnapshots),episode=f.mapping.binding.episodeId,old=current.get(episode)!;
    if(kind==='identity')current.set(episode,{...old,id:id('different-current-snapshot')});else if(kind==='version')current.set(episode,{...old,version:old.version+1});
    else if(kind==='full-digest')current.set(episode,{...old,digest:'0'.repeat(64)});else current.delete(episode);walk.currentSnapshots=current;
    await expect(drainContinuityNativeProofs(client,walk,readStoredContinuitySource)).rejects.toMatchObject({code:'CONFLICT',path:'current predecessor ledger chain'});
  }finally{client.release();}
});

it('rejects a repeated actual proof task instead of re-entering its history indefinitely',async()=>{
  const f=await nativeContinuityFixture(),client=await f.pool.connect(),walk=continuityProofWalk();try{
    const task=await enqueueActual(f,client,walk);await enqueueContinuityNativeProof(client,task.previous,f.mapping.snapshot,task.audit,task.request,walk);
    await expect(drainContinuityNativeProofs(client,walk,readStoredContinuitySource)).rejects.toMatchObject({code:'CONFLICT',path:'cyclic predecessor proof'});
  }finally{client.release();}
});

it.each([99,100])('enforces the proof walk bound with one real task after a prior count of %i',async prior=>{
  const f=await nativeContinuityFixture(),client=await f.pool.connect(),walk=continuityProofWalk();try{
    await enqueueActual(f,client,walk);walk.count=prior;const readSource=vi.fn(readStoredContinuitySource),pending=drainContinuityNativeProofs(client,walk,readSource);
    if(prior===99){await expect(pending).resolves.toBeUndefined();expect(walk.count).toBe(100);expect(readSource).toHaveBeenCalledTimes(1);}
    else{await expect(pending).rejects.toMatchObject({code:'INPUT_LIMIT',path:'predecessor proof chain'});expect(readSource).not.toHaveBeenCalled();}
  }finally{client.release();}
});

it.each(['missing','ambiguous'] as const)('rejects a %s historical mapping package after its human record replay',async kind=>{
  const f=await nativeContinuityFixture(),client=await f.pool.connect(),walk=continuityProofWalk();try{
    await enqueueActual(f,client,walk);const history=await readStoredContinuitySource(client,{source:f.reviewed.preparation.source,previous:f.reviewed.preparation.previous});
    f.memory.transform=(sql,rows)=>sql.includes('FROM camery_versioning.snapshots')?(kind==='missing'?[]:[...rows,...structuredClone(rows)]):rows;
    await expect(drainContinuityNativeProofs(client,walk,async()=>history)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'historical mapping source'});
  }finally{client.release();}
});

it.each(['multiple','non-string-change'] as const)('rejects %s snapshot receipt discovery instead of choosing one proof',async kind=>{
  const f=await nativeContinuityFixture();if(kind==='multiple')f.tables.native_adoptions.push(structuredClone(f.tables.native_adoptions[0]!));else f.tables.native_adoptions[0]!['change_id']=123;
  const client=await f.pool.connect();try{await expect(resolveContinuityNativePredecessor(client,predecessorSelection(f))).rejects.toMatchObject({code:'STORAGE_FAILED',path:'snapshot proof cardinality'});}finally{client.release();}
});

it('redacts an opaque source driver error and leaves the caller connection owned by its caller',async()=>{
  const f=await nativeContinuityFixture(),client=await f.pool.connect(),before=f.memory.releases.length;
  f.memory.before=sql=>{if(sql.includes('FROM camery_versioning.projects'))throw new Proxy({}, {getPrototypeOf(){throw new Error('postgres://private-source-credential');}});};
  try{await expect(resolveContinuityNativePredecessor(client,predecessorSelection(f))).rejects.toMatchObject({code:'STORAGE_FAILED',message:'Continuity native source failed (STORAGE_FAILED) at storage'});expect(f.memory.releases).toHaveLength(before);}finally{client.release();}
});

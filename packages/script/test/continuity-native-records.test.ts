import type {PoolClient} from 'pg';
import {expect,it,vi} from 'vitest';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import {CONTINUITY_NATIVE_RECORD_BYTES} from '../src/continuity/node/native-contracts.js';
import {readContinuityNativeBinding,readContinuityNativeReceipt,insertContinuityNativeBinding,insertContinuityNativeReceipt} from '../src/continuity/node/native-records.js';

const body={version:1 as const,key:{tenantId:'tenant',projectId:'project',candidateId:'candidate'},target:{tenantId:id('tenant'),projectId:id('project')},
  candidateDigest:'1'.repeat(64),reviewDigest:'2'.repeat(64),sourceRevision:5,packageDigest:'3'.repeat(64),episodeId:id('episode'),changeId:id('change'),snapshot:{id:id('snapshot'),version:1},operationId:id('op'),author:{kind:'user' as const,id:id('human')},requestDigest:'4'.repeat(64)};
const binding={...body,digest:continuityDigest(body,CONTINUITY_NATIVE_RECORD_BYTES)};
const receiptBody={version:1 as const,key:body.key,target:body.target,bindingDigest:binding.digest,reviewDigest:binding.reviewDigest,changeId:binding.changeId,snapshot:binding.snapshot,ledgerDigest:'5'.repeat(64),fromRevision:5,toRevision:6,actor:body.author,scope:{kind:'episode' as const,id:body.episodeId},at:'2026-11-19T03:00:00.000Z'};
const receipt={...receiptBody,digest:continuityDigest(receiptBody,CONTINUITY_NATIVE_RECORD_BYTES)};
function fixture(){
  const bindingRow:Record<string,unknown>={tenant_id:body.key.tenantId,project_id:body.key.projectId,candidate_id:body.key.candidateId,formal_tenant_id:body.target.tenantId,formal_project_id:body.target.projectId,change_id:body.changeId,snapshot_id:body.snapshot.id,snapshot_version:'1',source_revision:'5',candidate_digest:body.candidateDigest,review_digest:body.reviewDigest,request_digest:body.requestDigest,digest:binding.digest,record:binding};
  const receiptRow:Record<string,unknown>={formal_tenant_id:body.target.tenantId,formal_project_id:body.target.projectId,change_id:body.changeId,snapshot_id:body.snapshot.id,snapshot_version:'1',from_revision:'5',to_revision:'6',binding_digest:binding.digest,review_digest:body.reviewDigest,ledger_digest:receipt.ledgerDigest,digest:receipt.digest,record:receipt};
  const state={bindings:[bindingRow],receipts:[receiptRow]};
  const query=vi.fn(async(text:string)=>({rows:text.startsWith('INSERT')?[]:text.includes('native_bindings')?state.bindings:state.receipts}));
  return {state,query,client:{query} as unknown as PoolClient};
}
it('reads exact immutable binding and adoption records without owning or releasing the caller transaction',async()=>{
  const f=fixture();expect(await readContinuityNativeBinding(f.client,body.target,body.changeId)).toEqual(binding);expect(await readContinuityNativeReceipt(f.client,body.target,body.changeId)).toEqual(receipt);
  await insertContinuityNativeBinding(f.client,binding);await insertContinuityNativeReceipt(f.client,receipt);
  expect(f.query.mock.calls.every(call=>/^(SELECT|INSERT)/.test(call[0]))).toBe(true);
});
it('distinguishes missing rows and rejects ambiguous records',async()=>{
  const f=fixture();f.state.bindings=[];f.state.receipts=[];expect(await readContinuityNativeBinding(f.client,body.target,body.changeId)).toBeNull();expect(await readContinuityNativeReceipt(f.client,body.target,body.changeId)).toBeNull();
  await expect(insertContinuityNativeBinding(f.client,binding)).rejects.toMatchObject({code:'CONFLICT'});await expect(insertContinuityNativeReceipt(f.client,receipt)).rejects.toMatchObject({code:'CONFLICT'});
  const ambiguous=fixture();ambiguous.state.bindings.push(ambiguous.state.bindings[0]!);ambiguous.state.receipts.push(ambiguous.state.receipts[0]!);
  await expect(readContinuityNativeBinding(ambiguous.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(readContinuityNativeReceipt(ambiguous.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it.each(['tenant_id','project_id','candidate_id','formal_tenant_id','formal_project_id','change_id','snapshot_id','snapshot_version','source_revision','candidate_digest','review_digest','request_digest','digest'])('rejects tampered binding column %s',async column=>{
  const f=fixture();f.state.bindings[0]![column]='tampered';await expect(readContinuityNativeBinding(f.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it.each(['formal_tenant_id','formal_project_id','change_id','snapshot_id','snapshot_version','from_revision','to_revision','binding_digest','review_digest','ledger_digest','digest'])('rejects tampered adoption column %s',async column=>{
  const f=fixture();f.state.receipts[0]![column]='tampered';await expect(readContinuityNativeReceipt(f.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('rejects mismatched stored hashes and prevents a second body under an existing immutable identity',async()=>{
  const f=fixture();f.state.bindings[0]!['record']={...binding,operationId:id('different')};f.state.receipts[0]!['record']={...receipt,at:'2026-11-19T03:01:00.000Z'};
  await expect(readContinuityNativeBinding(f.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(readContinuityNativeReceipt(f.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const changed={...binding,key:{...body.key,candidateId:'other'}};await expect(insertContinuityNativeBinding(fixture().client,{...changed,digest:continuityDigest({...body,key:changed.key},CONTINUITY_NATIVE_RECORD_BYTES)})).rejects.toMatchObject({code:'CONFLICT'});
  const other={...receiptBody,at:'2026-11-19T03:02:00.000Z'};await expect(insertContinuityNativeReceipt(fixture().client,{...other,digest:continuityDigest(other,CONTINUITY_NATIVE_RECORD_BYTES)})).rejects.toMatchObject({code:'CONFLICT'});
});
it('redacts even opaque driver failures',async()=>{
  const f=fixture();f.query.mockRejectedValue(new Proxy({},{getPrototypeOf(){throw new Error('private credential');}}));
  await expect(readContinuityNativeBinding(f.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(readContinuityNativeReceipt(f.client,body.target,body.changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

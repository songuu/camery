import type {PoolClient} from 'pg';
import {expect,it,vi} from 'vitest';
import {adoptChangeSet,createVersionState,submitChangeSet} from '@camery/versioning';
import {SCREENPLAY_CANDIDATE_BYTES} from '../src/screenplay/contracts.js';
import {continuityDigest} from '../src/continuity/node/digest.js';
import type {ScreenplayNativeBinding,ScreenplayNativeReceipt} from '../src/screenplay/node/native-contracts.js';
import {readScreenplayNativeBinding,insertScreenplayNativeBinding,readScreenplayNativeReceipt,insertScreenplayNativeReceipt} from '../src/screenplay/node/native-records.js';
import {screenplayNativeFixture} from './screenplay-native-support.js';

type Row=Record<string,unknown>;
function signed<T extends {digest:string}>(record:T):T{const {digest:_digest,...body}=record;return {...record,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)};}

/** SQL protocol fixture only: real pure native audit values do not prove PostgreSQL persistence or transactions. */
async function fixture(){
  const f=await screenplayNativeFixture(),body={version:1 as const,key:f.key,mapping:f.mapping,ids:f.ids},binding:ScreenplayNativeBinding={...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)};
  const pending=submitChangeSet(createVersionState(f.head),f.mapping.request),adopted=adoptChangeSet(pending.state,f.mapping.request.id,{actor:f.author,scope:{kind:'episode',id:f.context.episode.id},at:f.host.at,authorize:()=>true});
  if(adopted.status!=='adopted')throw new Error('Expected actual pure native human adoption');const audit=adopted.state.adoptions.at(-1)!;
  const receiptBody={version:1 as const,key:f.key,target:f.target,changeId:f.mapping.request.id,reviewDigest:f.mapping.reviewDigest,bindingDigest:binding.digest,
    fromRevision:audit.from_revision,toRevision:audit.to_revision,actor:{kind:'user' as const,id:audit.actor_id},scope:{kind:'episode' as const,id:audit.scope.id},at:audit.at};
  const receipt:ScreenplayNativeReceipt={...receiptBody,digest:continuityDigest(receiptBody,SCREENPLAY_CANDIDATE_BYTES)};
  const bindingRow:Row={tenant_id:f.key.tenantId,project_id:f.key.projectId,candidate_id:f.key.candidateId,formal_tenant_id:f.target.tenantId,formal_project_id:f.target.projectId,
    change_id:f.mapping.request.id,source_revision:String(f.mapping.sourceRevision),mapping_digest:f.mapping.digest,review_digest:f.mapping.reviewDigest,digest:binding.digest,record:structuredClone(binding)};
  const receiptRow:Row={formal_tenant_id:f.target.tenantId,formal_project_id:f.target.projectId,change_id:f.mapping.request.id,from_revision:String(receipt.fromRevision),to_revision:String(receipt.toRevision),binding_digest:binding.digest,digest:receipt.digest,record:structuredClone(receipt)};
  const state={bindings:[bindingRow],receipts:[receiptRow]},query=vi.fn(async(sql:string,_values:unknown[]=[])=>({rows:sql.startsWith('INSERT')?[]:sql.includes('camery_screenplay.native_bindings')?state.bindings:state.receipts})),release=vi.fn();
  return {...f,binding,receipt,state,query,release,client:{query,release} as unknown as PoolClient};
}

it('reads complete frozen records, appends with exact reread and keeps transaction ownership on the caller',async()=>{
  const f=await fixture();expect(await readScreenplayNativeBinding(f.client,f.target,f.mapping.request.id)).toEqual(f.binding);expect(await readScreenplayNativeReceipt(f.client,f.target,f.mapping.request.id)).toEqual(f.receipt);
  await insertScreenplayNativeBinding(f.client,f.binding);await insertScreenplayNativeReceipt(f.client,f.receipt);
  const inserts=f.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT'));expect(inserts).toHaveLength(2);expect(inserts.every(([sql])=>sql.includes('ON CONFLICT DO NOTHING'))).toBe(true);
  expect(f.query.mock.calls.map(([sql])=>sql.split(' ',1)[0])).toEqual(['SELECT','SELECT','INSERT','SELECT','INSERT','SELECT']);expect(f.release).not.toHaveBeenCalled();
  expect(Object.isFrozen((await readScreenplayNativeBinding(f.client,f.target,f.mapping.request.id))!.mapping.request.ops)).toBe(true);expect(Object.isFrozen((await readScreenplayNativeReceipt(f.client,f.target,f.mapping.request.id))!.actor)).toBe(true);
  for(const [sql,values] of f.query.mock.calls){expect(sql).not.toContain(f.target.tenantId);expect(sql).not.toContain(f.target.projectId);expect(sql).not.toContain(f.mapping.request.id);
    expect(sql).toMatch(/^(SELECT .+ FROM|INSERT INTO) camery_screenplay\.native_(bindings|adoptions)/);if(sql.startsWith('SELECT'))expect(values).toEqual([f.target.tenantId,f.target.projectId,f.mapping.request.id]);
  }
  expect(JSON.parse(String(inserts[0]![1]!.at(-1)))).toEqual(f.binding);expect(JSON.parse(String(inserts[1]![1]!.at(-1)))).toEqual(f.receipt);
});

it('accepts exact integer columns supplied as either pg strings or numbers',async()=>{
  const f=await fixture();f.state.bindings[0]!['source_revision']=f.mapping.sourceRevision;f.state.receipts[0]!['from_revision']=f.receipt.fromRevision;f.state.receipts[0]!['to_revision']=f.receipt.toRevision;
  expect(await readScreenplayNativeBinding(f.client,f.target,f.mapping.request.id)).toEqual(f.binding);expect(await readScreenplayNativeReceipt(f.client,f.target,f.mapping.request.id)).toEqual(f.receipt);
});

it.each(['bindings','receipts'] as const)('distinguishes absent %s from ambiguous rows',async table=>{
  const f=await fixture(),read=table==='bindings'?readScreenplayNativeBinding:readScreenplayNativeReceipt;f.state[table]=[];expect(await read(f.client,f.target,f.mapping.request.id)).toBeNull();
  const original=await fixture();f.state[table]=[...original.state[table],...structuredClone(original.state[table])];await expect(read(f.client,f.target,f.mapping.request.id)).rejects.toMatchObject({code:'STORAGE_FAILED',path:table==='bindings'?'binding cardinality':'receipt cardinality'});
});

it.each(['tenant_id','project_id','candidate_id','formal_tenant_id','formal_project_id','change_id','source_revision','mapping_digest','review_digest','digest'] as const)('rejects altered binding column %s',async field=>{
  const f=await fixture();f.state.bindings[0]![field]=field==='source_revision'?f.mapping.sourceRevision+1:'changed';await expect(readScreenplayNativeBinding(f.client,f.target,f.mapping.request.id)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'binding columns'});
});

it.each(['formal_tenant_id','formal_project_id','change_id','from_revision','to_revision','binding_digest','digest'] as const)('rejects altered receipt column %s',async field=>{
  const f=await fixture();f.state.receipts[0]![field]=field==='from_revision'?f.receipt.fromRevision+1:field==='to_revision'?f.receipt.toRevision+1:'changed';await expect(readScreenplayNativeReceipt(f.client,f.target,f.mapping.request.id)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'receipt columns'});
});

it.each(['ordinary-tenant','ordinary-project','candidate','nested-request','identity-slot','mapping-digest','body-digest','extra-field'] as const)('rejects changed binding %s body rather than trusting its unchanged columns',async kind=>{
  const f=await fixture(),value=f.state.bindings[0]!['record'] as ScreenplayNativeBinding;
  if(kind==='ordinary-tenant')value.key.tenantId='other-ordinary-tenant';else if(kind==='ordinary-project')value.key.projectId='other-ordinary-project';else if(kind==='candidate')value.key.candidateId='other-candidate';
  else if(kind==='nested-request')value.mapping.request.ops[0]!.op_id=f.id('unrecorded-native-operation');else if(kind==='identity-slot')value.ids[0]!.id=f.id('different-identity-slot');else if(kind==='mapping-digest')value.mapping.digest='0'.repeat(64);else if(kind==='body-digest')value.digest='0'.repeat(64);else (value as unknown as Row)['extra']=true;
  await expect(readScreenplayNativeBinding(f.client,f.target,f.mapping.request.id)).rejects.toMatchObject({name:'ScreenplayError'});
});

it.each(['key','actor','scope','time','review','body-digest','extra-field'] as const)('rejects changed receipt %s body',async kind=>{
  const f=await fixture(),value=f.state.receipts[0]!['record'] as ScreenplayNativeReceipt;
  if(kind==='key')value.key.candidateId='other-candidate';else if(kind==='actor')value.actor.id=f.id('other-native-human');else if(kind==='scope')value.scope.id=f.id('other-episode');else if(kind==='time')value.at='2026-11-19T06:00:00.000Z';else if(kind==='review')value.reviewDigest='0'.repeat(64);else if(kind==='body-digest')value.digest='0'.repeat(64);else (value as unknown as Row)['extra']=true;
  await expect(readScreenplayNativeReceipt(f.client,f.target,f.mapping.request.id)).rejects.toMatchObject({name:'ScreenplayError'});
});

it.each(['tenant','project','change'] as const)('rejects a %s lookup that receives a foreign row',async kind=>{
  const f=await fixture(),target={...f.target},changeId=kind==='change'?f.id('different-request'):f.mapping.request.id;if(kind==='tenant')target.tenantId=f.id('different-formal-tenant');if(kind==='project')target.projectId=f.id('different-formal-project');
  await expect(readScreenplayNativeBinding(f.client,target,changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});await expect(readScreenplayNativeReceipt(f.client,target,changeId)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

it.each(['target','change'] as const)('does not treat recomputed record hashes as authority for another binding %s',async kind=>{
  const f=await fixture(),raw=f.state.bindings[0]!['record'] as ScreenplayNativeBinding;
  if(kind==='target')raw.mapping.target.projectId=f.id('body-foreign-target');else raw.mapping.request.id=f.id('body-foreign-request');raw.mapping=signed(raw.mapping);
  const changed=signed(raw);Object.assign(f.state.bindings[0]!,{mapping_digest:changed.mapping.digest,digest:changed.digest,record:changed});
  await expect(readScreenplayNativeBinding(f.client,f.target,f.mapping.request.id)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'binding columns'});
});

it.each(['target','change','nonadjacent-revision'] as const)('does not accept self-consistent receipt %s outside its native lookup or revision relationship',async kind=>{
  const f=await fixture(),raw=f.state.receipts[0]!['record'] as ScreenplayNativeReceipt;
  if(kind==='target')raw.target.tenantId=f.id('receipt-foreign-tenant');else if(kind==='change')raw.changeId=f.id('receipt-foreign-request');else raw.toRevision++;
  const changed=signed(raw);Object.assign(f.state.receipts[0]!,{from_revision:changed.fromRevision,to_revision:changed.toRevision,digest:changed.digest,record:changed});
  await expect(readScreenplayNativeReceipt(f.client,f.target,f.mapping.request.id)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'receipt columns'});
});

it.each(['binding','receipt'] as const)('requires an exact %s reread after append, including a missing ON CONFLICT result',async kind=>{
  const f=await fixture();if(kind==='binding'){f.state.bindings=[];await expect(insertScreenplayNativeBinding(f.client,f.binding)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'immutable binding'});}
  else{f.state.receipts=[];await expect(insertScreenplayNativeReceipt(f.client,f.receipt)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'immutable receipt'});}
  expect(f.query.mock.calls.map(([sql])=>sql.split(' ',1)[0])).toEqual(['INSERT','SELECT']);expect(f.release).not.toHaveBeenCalled();
});

it('keeps the first exact binding and receipt when a later append uses another well-hashed body',async()=>{
  const f=await fixture(),binding=signed({...structuredClone(f.binding),key:{...f.key,candidateId:'changed-binding-candidate'}}),receipt=signed({...structuredClone(f.receipt),at:'2026-11-19T07:00:00.000Z'});
  await expect(insertScreenplayNativeBinding(f.client,binding)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'immutable binding'});await expect(insertScreenplayNativeReceipt(f.client,receipt)).rejects.toMatchObject({code:'STORAGE_FAILED',path:'immutable receipt'});
  expect(await readScreenplayNativeBinding(f.client,f.target,f.mapping.request.id)).toEqual(f.binding);expect(await readScreenplayNativeReceipt(f.client,f.target,f.mapping.request.id)).toEqual(f.receipt);expect(f.release).not.toHaveBeenCalled();
});

it('rejects malformed append records before issuing SQL or invoking getters',async()=>{
  const f=await fixture();let touched=false;const binding=Object.defineProperty({},'key',{enumerable:true,get(){touched=true;throw new Error('private binding getter');}});
  await expect(insertScreenplayNativeBinding(f.client,binding as ScreenplayNativeBinding)).rejects.toMatchObject({code:'INVALID_INPUT'});await expect(insertScreenplayNativeReceipt(f.client,{...f.receipt,extra:true} as ScreenplayNativeReceipt)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(touched).toBe(false);expect(f.query).not.toHaveBeenCalled();expect(f.release).not.toHaveBeenCalled();
});

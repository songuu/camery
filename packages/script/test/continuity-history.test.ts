import {createHash} from 'node:crypto';
import {z} from 'zod';
import {expect,it,vi} from 'vitest';
import {StableId} from '@camery/ir';
import {Id,Hash,Integer} from '../src/contracts.js';
import {CONTINUITY_CANDIDATE_BYTES,ContinuityLedgerSchema} from '../src/continuity/contracts.js';
import {canonicalContinuity,continuityDigest} from '../src/continuity/node/digest.js';
import {captureStoredContinuityPreparation,readStoredContinuityProgress} from '../src/continuity/node/history.js';
import {CONTINUITY_RECORD_BYTES,ContinuityPreviousV1Schema,ContinuityPreviousSchema,ContinuityScopeSchema,ContinuityTargetSchema} from '../src/continuity/node/persistence-contracts.js';
import type {ContinuityPreparation,ContinuityReview} from '../src/continuity/node/persistence-contracts.js';
import {readStoredContinuitySource} from '../src/continuity/node/source.js';
import {ContinuityMemory,continuityPreviousFixture,id} from './continuity-store-protocol-support.js';
import type {Row} from './continuity-store-protocol-support.js';

async function prepared(review:'reviewed'|'rejected'|null='reviewed'){
  const memory=new ContinuityMemory(),command=memory.command(),evidence=structuredClone(command.draft.events[0]!.evidence);
  command.draft.events.push({id:'state-note',op:'set_character',value:{characterId:id('char_lin'),summary:'保留便签并继续调查',appearance:null,spot:null,holding:[]},evidence},
    {id:'thread-note',op:'plant',threadId:'note-origin',summary:'便签来源尚待确认',payoffEpisodeId:id('ep_2'),evidence:structuredClone(evidence)});
  const original=await memory.store.prepare(command,memory.host);
  let progress=original;
  if(review==='reviewed'){
    const draft=structuredClone(command.draft);draft.events[0]={...draft.events[0]!,text:'人工核对后的完整事实'} as typeof draft.events[number];
    progress=await memory.store.confirm(memory.key,{candidateDigest:original.preparation.candidate.digest,draft,waivers:[]},memory.host);
  }else if(review==='rejected')progress=await memory.store.reject(memory.key,{candidateDigest:original.preparation.candidate.digest,reason:'保留完整拒绝理由'},memory.host);
  const client=await memory.pool.connect();return {memory,client,original,progress};
}

it('replays a human-edited historical candidate on the caller client without owning a transaction or releasing it',async()=>{
  const f=await prepared();f.memory.advance();const counts=f.memory.counts(),releases=f.memory.releases.length,calls=f.memory.calls.length,clients=f.memory.clients.length;
  const readSource=vi.fn(readStoredContinuitySource),result=await readStoredContinuityProgress(f.client,f.memory.key,readSource);
  expect(result.progress).toEqual({...f.progress,current:false});expect(result.view.current).toBe(false);
  expect(result.progress.preparation.candidate.ledger.facts[0]!.text).toBe('发现便签');
  expect(result.progress.review?.status).toBe('reviewed');if(result.progress.review?.status!=='reviewed')throw new Error('Expected reviewed history');
  expect(result.progress.review.output.ledger.facts[0]!.text).toBe('人工核对后的完整事实');
  for(const ledger of [result.progress.preparation.candidate.ledger,result.progress.review.output.ledger])for(const collection of ['facts','knowledge','characters','threads'] as const)expect(ledger[collection]).toHaveLength(1);
  expect(result.progress.review.output.ledger.characters).toEqual(result.progress.preparation.candidate.ledger.characters);expect(result.progress.review.output.ledger.threads).toEqual(result.progress.preparation.candidate.ledger.threads);
  expect(readSource).toHaveBeenCalledExactlyOnceWith(f.client,{source:f.progress.preparation.source,previous:f.progress.preparation.previous});
  expect(f.memory.calls.slice(calls).every(sql=>sql.startsWith('SELECT '))).toBe(true);
  expect(f.memory.calls.slice(calls).some(sql=>sql.includes('FOR UPDATE')||sql.includes('advisory'))).toBe(false);
  expect(f.memory.counts()).toEqual(counts);expect(f.memory.releases).toHaveLength(releases);expect(f.memory.clients).toHaveLength(clients);
  expect(Object.isFrozen(result.progress.preparation.candidate.draft.events)).toBe(true);expect(Object.isFrozen(result.progress.review.output.ledger.facts)).toBe(true);
  f.client.release();
});

it.each([null,'rejected'] as const)('preserves %s review history without inventing approval',async kind=>{
  const f=await prepared(kind),result=await readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource);
  expect(result.progress).toEqual(f.progress);expect(result.view.source).toEqual(f.progress.preparation.source);f.client.release();
});

it('captures its key before awaiting storage and keeps source inputs frozen',async()=>{
  const f=await prepared(),key={...f.memory.key};let started!:()=>void,continueRead!:()=>void;
  const reached=new Promise<void>(resolve=>{started=resolve;}),blocked=new Promise<void>(resolve=>{continueRead=resolve;});
  f.memory.before=async sql=>{if(sql.includes('FROM camery_continuity.candidates')){started();await blocked;}};
  const readSource=vi.fn<Parameters<typeof readStoredContinuityProgress>[2]>(async(client,input)=>{expect(Object.isFrozen(input.source)).toBe(true);return readStoredContinuitySource(client,input);});
  const pending=readStoredContinuityProgress(f.client,key,readSource);await reached;key.candidateId='changed-while-awaiting';continueRead();
  expect((await pending).progress).toEqual(f.progress);f.client.release();
});

it('reads preparation timestamps supplied by pg as Date objects without changing persisted bytes',async()=>{
  const f=await prepared(),before=canonicalContinuity(f.progress.preparation,CONTINUITY_RECORD_BYTES),row=structuredClone(f.memory.candidateRow());row['created_at']=new Date(String(row['created_at']));
  expect(canonicalContinuity(captureStoredContinuityPreparation(row,f.memory.key),CONTINUITY_RECORD_BYTES)).toBe(before);
  f.memory.reviewRow()['created_at']=new Date(String(f.memory.reviewRow()['created_at']));
  expect((await readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource)).progress).toEqual(f.progress);f.client.release();
});

const preparationColumns=['tenant_id','project_id','candidate_id','formal_tenant_id','formal_project_id','source_revision','episode_id','author_id','package_digest','context_digest','command_digest','digest','created_at'] as const;
it.each(preparationColumns)('refuses altered preparation column %s',async column=>{
  const f=await prepared(),row=f.memory.candidateRow();row[column]=column==='source_revision'?999:column==='created_at'?'not-a-time':'altered';
  await expect(readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource)).rejects.toMatchObject({code:'STORAGE_FAILED'});f.client.release();
});

it.each(['invalid-shape','digest','command','candidate-scope','candidate-episode','candidate-context','previous-scope','key','invalid-date'] as const)('refuses %s preparation content even when outer columns agree',async kind=>{
  const f=await prepared(),row=structuredClone(f.memory.candidateRow()),record=row['record'] as ContinuityPreparation;
  if(kind==='invalid-shape'){(record as unknown as Row)['unexpected']=true;}
  else if(kind==='digest')record.digest='0'.repeat(64);
  else if(kind==='command')record.commandDigest='0'.repeat(64);
  else if(kind==='candidate-scope')record.candidate.scope.projectId='foreign-project';
  else if(kind==='candidate-episode')record.candidate.draft.episodeId=id('ep_2');
  else if(kind==='candidate-context')record.candidate.contextDigest='0'.repeat(64);
  else if(kind==='previous-scope'){record.previous=continuityPreviousFixture().previous;record.previous.scope.tenantId='foreign';}
  else if(kind==='key')record.key.candidateId='changed-key';
  else record.createdAt='not-a-time';
  if(kind!=='digest'){
    const {digest:_digest,...body}=record;record.digest=continuityDigest(body,CONTINUITY_RECORD_BYTES);
  }
  row['digest']=record.digest;row['command_digest']=record.commandDigest;row['created_at']=record.createdAt;
  expect(()=>captureStoredContinuityPreparation(row,f.memory.key)).toThrow('STORAGE_FAILED');f.client.release();
});

it('rebuilds source-dependent ledger content after consistently replaced envelope and candidate hashes',async()=>{
  const f=await prepared(null),row=f.memory.candidateRow(),record=row['record'] as ContinuityPreparation;record.candidate.ledger.facts[0]!.text='未被原始声明支持的事实';
  const {digest:_candidate,...candidateBody}=record.candidate;record.candidate.digest=continuityDigest(candidateBody,CONTINUITY_CANDIDATE_BYTES);
  const {digest:_preparation,...body}=record;record.digest=continuityDigest(body,CONTINUITY_RECORD_BYTES);row['digest']=record.digest;
  await expect(readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource)).rejects.toMatchObject({code:'STORAGE_FAILED',operation:'stored candidate source'});f.client.release();
});

it('replays the complete human draft instead of trusting consistently replaced output and review hashes',async()=>{
  const f=await prepared(),row=f.memory.reviewRow(),review=row['record'] as ContinuityReview;if(review.status!=='reviewed')throw new Error('Expected reviewed history');
  review.output.ledger.characters[0]!.value.summary='人审草稿未声明的替换状态';
  const {digest:_output,...output}=review.output;review.output.digest=continuityDigest(output,CONTINUITY_CANDIDATE_BYTES);
  const {digest:_review,...body}=review;review.digest=continuityDigest(body,CONTINUITY_RECORD_BYTES);row['digest']=review.digest;
  await expect(readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource)).rejects.toMatchObject({code:'STORAGE_FAILED',operation:'stored review'});f.client.release();
});

it.each(['tenant_id','project_id','candidate_id','status','actor_id','request_digest','digest','created_at','record'] as const)('refuses altered review column %s',async column=>{
  const f=await prepared(),row=f.memory.reviewRow();if(column==='record')(row['record'] as Row)['digest']='0'.repeat(64);else row[column]=column==='created_at'?'bad time':'altered';
  await expect(readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource)).rejects.toMatchObject({code:'STORAGE_FAILED',operation:'stored review'});f.client.release();
});

it.each(['candidate','review'] as const)('refuses ambiguous %s rows',async table=>{
  const f=await prepared();f.memory.transform=(sql,rows)=>sql.includes('FROM camery_continuity.'+(table==='candidate'?'candidates':'reviews'))?[...rows,...structuredClone(rows)]:rows;
  await expect(readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource)).rejects.toMatchObject({code:'STORAGE_FAILED'});f.client.release();
});

it('reports a missing candidate without consulting source or allocating records',async()=>{
  const memory=new ContinuityMemory(),client=await memory.pool.connect(),readSource=vi.fn(readStoredContinuitySource);
  await expect(readStoredContinuityProgress(client,memory.key,readSource)).rejects.toMatchObject({code:'NOT_FOUND'});expect(readSource).not.toHaveBeenCalled();expect(memory.counts()).toEqual({candidates:0,reviews:0});client.release();
});

it.each(['candidate-read','review-read'] as const)('redacts an opaque %s driver exception without releasing the caller client',async point=>{
  const f=await prepared(),releases=f.memory.releases.length;f.memory.fail(point,new Proxy({}, {getPrototypeOf(){throw new Error('postgres://private-credential');}}));
  await expect(readStoredContinuityProgress(f.client,f.memory.key,readStoredContinuitySource)).rejects.toMatchObject({code:'STORAGE_FAILED',operation:'stored history',path:'storage',message:'Continuity stored history failed (STORAGE_FAILED) at storage'});expect(f.memory.releases).toHaveLength(releases);f.client.release();
});

it('normalizes source replay failures without leaking driver text',async()=>{
  const f=await prepared();await expect(readStoredContinuityProgress(f.client,f.memory.key,async()=>{throw new Error('postgres://private-credential');})).rejects.toThrow('Continuity stored candidate source failed (STORAGE_FAILED) at storage');f.client.release();
});

it('never evaluates unsafe stored preparation getters',async()=>{
  const f=await prepared(),row=structuredClone(f.memory.candidateRow());let touched=false;
  Object.defineProperty(row['record'],'candidate',{enumerable:true,get(){touched=true;throw new Error('postgres://private-getter');}});
  expect(()=>captureStoredContinuityPreparation(row,f.memory.key)).toThrow('STORAGE_FAILED');expect(touched).toBe(false);f.client.release();
});

it('preserves the exact v1 predecessor reader and record while the new reader accepts v1 unchanged',()=>{
  const legacy=z.strictObject({version:z.literal(1),id:Id,digest:Hash,scope:ContinuityScopeSchema,target:ContinuityTargetSchema,
    snapshot:z.strictObject({id:StableId,version:Integer.min(1)}),changeId:StableId,adoptedRevision:Integer.min(1),ledger:ContinuityLedgerSchema});
  const hash=(schema:z.ZodType)=>createHash('sha256').update(JSON.stringify(z.toJSONSchema(schema))).digest('hex');
  expect(hash(ContinuityPreviousV1Schema)).toBe(hash(legacy));
  const previous=continuityPreviousFixture().previous,before=JSON.stringify(legacy.parse(previous));
  expect(JSON.stringify(ContinuityPreviousV1Schema.parse(previous))).toBe(before);expect(JSON.stringify(ContinuityPreviousSchema.parse(previous))).toBe(before);
});

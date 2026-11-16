import { expect, it } from 'vitest';
import { importNovel, importFountain } from '@camery/ingest';
import { importDocx } from '@camery/ingest/node';
import { docx } from '../../ingest/test/fixtures/docx.js';
import { captureSource, ensureSource, asSourceInput, copy, hash, boundary } from '../src/data.js';
import { createChunkPlan } from '../src/chunks.js';
import { validateChunkOutput } from '../src/evidence.js';
import type { ChunkOutput, SourceInput } from '../src/contracts.js';
const input = (text='小林😀见到了阿青。'): SourceInput => ({tenantId:'tenant',projectId:'project',documentId:'book',kind:'novel',revision:1,document:importNovel(text)});
const output = (): ChunkOutput => ({entities:[{id:'lin',kind:'character',name:'小林',aliases:[],description:'小林来到车站。',evidence:[{start:0,end:2,quote:'小林'}]}],relations:[],claims:[]});
it('binds script revisions and keeps DOCX archive and extracted-text digests distinct',async()=>{
  const word=await importDocx(docx('<w:p><w:r><w:t>小林来到车站。😀</w:t></w:r></w:p>'));
  expect(word.originalDigest).not.toBe(word.sourceDigest);
  for(const document of [importFountain('.内景 车站\n\n@小林\n你好。\n'),word]){
    const raw:SourceInput={tenantId:'t',projectId:'p',documentId:'script',kind:'script',revision:1,document};
    const snapshot=captureSource(raw);const plan=createChunkPlan(raw);const candidate=output();const start=document.text.indexOf('小林');
    candidate.entities[0]!.evidence=[{start,end:start+2,quote:'小林'}];
    expect(validateChunkOutput(snapshot,plan,plan.chunks[0]!.id,candidate)).toEqual(candidate);
    expect(snapshot.source.originalDigest).toBe(document.originalDigest);expect(snapshot.source.sourceDigest).toBe(document.sourceDigest);
  }
});
it('captures an immutable validated source identity without changing UTF-8 or UTF-16 semantics',()=>{
  const raw=input('\uFEFF第一章\r\n小林😀'); const source=captureSource(raw); const plain=structuredClone(source);
  expect(ensureSource(source)).toBe(source); expect(ensureSource(plain)).toEqual(source); expect(asSourceInput(source)).toEqual(raw);
  expect(Object.isFrozen(source.document.units)).toBe(true); expect(source.source.sourceDigest).toBe(raw.document.sourceDigest);
  expect(()=>ensureSource({...plain,source:{...plain.source,revision:2,sourceDigest:'a'.repeat(64)}})).toThrow();
  expect(()=>ensureSource({...plain,extra:true} as typeof source)).toThrow();
});
it.each([{tenantId:'tenant\n'},{kind:'script'},{revision:0},{document:{}}])('rejects bad source identity %j',patch=>{
  expect(()=>captureSource({...input(),...patch} as SourceInput)).toThrow();
});
it('rejects changed original text and a non-first immutable script revision',()=>{
  const raw=input(); expect(()=>captureSource({...raw,document:{...raw.document,text:'伪造'}})).toThrow();
  expect(()=>captureSource({...raw,kind:'script',revision:2,document:{...raw.document,format:'fountain'}})).toThrow();
});
it('copies JSON without accessors/prototypes and reports bounded contextual errors',()=>{
  expect(copy({text:'来源'})).toEqual({text:'来源'}); const getter=Object.defineProperty({},'secret',{enumerable:true,get(){throw new Error('sensitive');}});
  expect(()=>copy(getter)).toThrow('JSON snapshot'); expect(()=>hash(getter)).toThrow('digest');
  expect(boundary('😀',1)).toBe(false); expect(boundary('😀',2)).toBe(true);
});
it('validates precise relative quotes and returns an independent frozen model candidate',()=>{
  const raw=input(); const source=captureSource(raw); const plan=createChunkPlan(raw); const candidate=output();
  const valid=validateChunkOutput(source,plan,plan.chunks[0]!.id,candidate);
  candidate.entities[0]!.name='被修改'; expect(valid.entities[0]!.name).toBe('小林'); expect(Object.isFrozen(valid.entities[0]!.evidence)).toBe(true);
});
it.each([{start:-1,end:2,quote:'小林'},{start:0,end:99,quote:'小林'},{start:0,end:1,quote:'小林'},
  {start:0,end:2,quote:'阿青'},{start:2,end:3,quote:'\ud83d'},{start:3,end:4,quote:'\ude00'},{start:0,end:0,quote:'小林'}])('rejects forged or split references %j',evidence=>{
  const raw=input(); const plan=createChunkPlan(raw); const value=output(); value.entities[0]!.evidence=[evidence];
  expect(()=>validateChunkOutput(captureSource(raw),plan,plan.chunks[0]!.id,value)).toThrow();
});
it('validates every entity, relation and claim reference against the same chunk',()=>{
  const raw=input(); const source=captureSource(raw); const plan=createChunkPlan(raw); const value=output();
  value.entities.push({...value.entities[0]!,id:'qing',name:'阿青',evidence:[{start:7,end:9,quote:'阿青'}]});
  value.relations.push({id:'r',from:'lin',to:'qing',label:'相遇',evidence:[{start:0,end:9,quote:'小林😀见到了阿青'}]});
  value.claims.push({id:'f',kind:'fact',text:'小林与阿青相遇。',entityIds:['lin','qing'],evidence:[{start:7,end:9,quote:'阿青'}]});
  // Correct the fixture from actual UTF-16 positions rather than trusting prose intuition.
  const start=raw.document.text.indexOf('阿青'); value.entities[1]!.evidence=[{start,end:start+2,quote:'阿青'}];
  value.relations[0]!.evidence=[{start:0,end:start+2,quote:raw.document.text.slice(0,start+2)}]; value.claims[0]!.evidence=value.entities[1]!.evidence;
  expect(validateChunkOutput(source,plan,plan.chunks[0]!.id,value)).toEqual(value);
  for(const broken of [ {...value,entities:[value.entities[0],value.entities[0]]},
    {...value,relations:[{...value.relations[0],to:'missing'}]}, {...value,relations:[value.relations[0],value.relations[0]]},
    {...value,claims:[{...value.claims[0],entityIds:['missing']}]}, {...value,claims:[{...value.claims[0],entityIds:['lin','lin']}]},
    {...value,claims:[value.claims[0],value.claims[0]]} ]) expect(()=>validateChunkOutput(source,plan,plan.chunks[0]!.id,broken)).toThrow();
});
it('allows an honestly empty extraction but never unknown fields or oversized projections',()=>{
  const raw=input(); const source=captureSource(raw); const plan=createChunkPlan(raw); const id=plan.chunks[0]!.id;
  expect(validateChunkOutput(source,plan,id,{entities:[],relations:[],claims:[]})).toEqual({entities:[],relations:[],claims:[]});
  expect(()=>validateChunkOutput(source,plan,id,{...output(),approved:true})).toThrow();
  expect(()=>validateChunkOutput(source,plan,id,{...output(),entities:Array.from({length:33},()=>output().entities[0])})).toThrow();
  expect(()=>validateChunkOutput(source,plan,id,{...output(),claims:[{id:'a',kind:'fact',text:'x'.repeat(131073),entityIds:[],evidence:[]}]})).toThrow('INPUT_LIMIT');
  expect(()=>validateChunkOutput(source,plan,'unknown',output())).toThrow();
});
it('stops logical JSON expansion before traversing all shared oversized model rows',()=>{
  const raw=input(); const source=captureSource(raw); const plan=createChunkPlan(raw); let visits=0;
  const row=new Proxy({...output().entities[0],description:'x'.repeat(3000)},{ownKeys(target){visits++;return Reflect.ownKeys(target);}});
  expect(()=>validateChunkOutput(source,plan,plan.chunks[0]!.id,{entities:Array(5000).fill(row),relations:[],claims:[]})).toThrow();
  expect(visits).toBeLessThan(100);
});
it('rejects accessors without executing them or exposing their exception text',()=>{
  const raw=input(); const source=captureSource(raw); const plan=createChunkPlan(raw); let reads=0;
  const getter=()=>{reads++;throw new Error('sensitive-plan-secret');};
  const forged=Object.defineProperty({...plan},'chunks',{enumerable:true,get:getter});
  expect(()=>validateChunkOutput(source,forged,plan.chunks[0]!.id,output())).toThrow('StoryBible');
  expect(reads).toBe(0);
  const forgedSource=Object.defineProperty({...raw},'document',{enumerable:true,get:getter});
  expect(()=>captureSource(forgedSource)).toThrow('StoryBible'); expect(reads).toBe(0);
});

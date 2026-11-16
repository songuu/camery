import { expect, it, vi } from 'vitest';
import { RecordingTransport, ReplayTransport } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import { createChunkPlan, extractChunk, assembleBibleCandidate, confirmBible, rejectBibleCandidate } from '../src/index.js';
import type { ChunkOutput, ChunkRecord } from '../src/index.js';
import { fixtureRunner, fixtureContext, sourceInput } from './extraction-support.js';

it('runs an original ten-chapter source through protocol extraction, exact replay, review grouping and source-bound confirmation',async()=>{
  const text='\uFEFF'+Array.from({length:10},(_,i)=>`第${i+1}章 雾港来信\r\n小林与阿青核对第${i+1}封信。😀\r\n`).join('');
  const source=sourceInput(text); const plan=createChunkPlan(source,{maxCharacters:40,maxBytes:120});
  expect(plan.chunks).toHaveLength(10); expect(source.document.units.filter(u=>u.kind==='chapter')).toHaveLength(10);
  const exchange=vi.fn<HttpTransport['exchange']>(async request=>{
    const body=request.body as {messages:{content:string}[]};
    const input=JSON.parse(body.messages.at(-1)!.content).untrustedSource as {text:string;chunk:{id:string;ordinal:number}};
    const lin=input.text.indexOf('小林'); const qing=input.text.indexOf('阿青'); const letter=input.text.lastIndexOf('信');
    const linEvidence=[{start:lin,end:lin+2,quote:'小林'}]; const qingEvidence=[{start:qing,end:qing+2,quote:'阿青'}];
    const output:ChunkOutput={entities:[{id:'lin',kind:'character',name:'小林',aliases:[],description:'第'+(input.chunk.ordinal+1)+'块中的小林候选。',evidence:linEvidence},
      {id:'qing',kind:'character',name:'阿青',aliases:[],description:'本块同行的人物。',evidence:qingEvidence}],
      relations:[{id:'together',from:'lin',to:'qing',label:'一起核对信件',evidence:[{start:lin,end:qing+2,quote:'小林与阿青'}]}],
      claims:[{id:'letter',kind:'foreshadowing',text:'信件需要后续核对。',entityIds:['lin','qing'],evidence:[{start:letter,end:letter+1,quote:'信'}]}]};
    return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'response-'+input.chunk.id,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:50,completion_tokens:30}}}};
  });
  const recording=new RecordingTransport({exchange},{kind:'synthetic_contract',source:'Original ten-chapter StoryBible protocol fixture; no actual model inference or real human approval.',recordedAt:'2026-11-16T10:00:00.000Z'});
  const run=async(transport:HttpTransport)=>{
    const {runner,method,session}=fixtureRunner(transport); const records:ChunkRecord[]=[];
    for(const chunk of plan.chunks)records.push(await extractChunk({runner,method,source,plan,chunkId:chunk.id,context:fixtureContext('golden-'+chunk.id)}));
    expect(session.callsUsed).toBe(10); return assembleBibleCandidate(source,plan,records.reverse(),method);
  };
  const candidate=await run(recording); const cassette=recording.exportCassette(); const replay=new ReplayTransport(cassette);
  expect(await run(replay)).toEqual(candidate); replay.assertComplete(); expect(exchange).toHaveBeenCalledTimes(10);
  expect(candidate.entities).toHaveLength(20); expect(candidate.mergeSuggestions).toHaveLength(2); expect(candidate.relations).toHaveLength(10);
  const ids=(name:string)=>candidate.entities.filter(e=>e.name===name).map(e=>e.id);
  const decision={candidateDigest:candidate.digest,groups:[{id:'lin',name:'小林',memberIds:ids('小林')},{id:'qing',name:'阿青',memberIds:ids('阿青')}],
    rejectedEntityIds:[],selectedRelationIds:candidate.relations.map(r=>r.id),selectedClaimIds:candidate.claims.map(c=>c.id)};
  const host={actor:{kind:'human' as const,id:'human-fixture'},tenantId:source.tenantId,projectId:source.projectId,at:'2026-11-16T10:00:00.000Z',authorize:()=>true};
  // JSON round-trip proves the domain can rebuild a stored value, not that a database or paid task recovered.
  const stored=JSON.parse(JSON.stringify(candidate)); const confirmed=confirmBible(source,stored,decision,host);
  expect(confirmed.entities).toHaveLength(2); expect(confirmed.entities.find(e=>e.id==='lin')!.descriptions).toHaveLength(10);
  expect(confirmed.claims.every(c=>c.entityIds.join(',')==='lin,qing')).toBe(true);
  for(const entity of confirmed.entities)for(const description of entity.descriptions)for(const citation of description.evidence)
    expect(text.slice(citation.start,citation.end)).toBe(citation.quote);
  expect(confirmBible(source,stored,decision,host)).toEqual(confirmed);
  expect(()=>confirmBible({...source,revision:2},stored,decision,host)).toThrow();
  expect(rejectBibleCandidate(source,stored,'需要真人复核语义和身份。',host).status).toBe('rejected'); expect(candidate.status).toBe('candidate');
});

import { importNovel } from '@camery/ingest';
import type { ModelReceipt } from '@camery/methods';
import { createChunkPlan } from '../src/chunks.js';
import { assembleBibleCandidate } from '../src/candidate.js';
import { hash } from '../src/data.js';
import type { ChunkOutput, ReviewDecision, ReviewHost, SourceInput } from '../src/contracts.js';
export function reviewFixture() {
  const source: SourceInput={tenantId:'tenant',projectId:'project',documentId:'book',kind:'novel',revision:1,
    document:importNovel('第一章 雾港\n小林和阿青相遇。\n第二章 夜站\n小林与阿青核对那封信。\n')};
  const plan=createChunkPlan(source,{maxCharacters:22,maxBytes:88});
  const method={id:'story-bible-extract',version:'1.0.0',digest:hash('synthetic-review-fixture')};
  const records=plan.chunks.map(chunk=>{
    const text=source.document.text.slice(chunk.start,chunk.end); const quote=text.trim();
    const evidence=[{start:text.indexOf(quote),end:text.indexOf(quote)+quote.length,quote}];
    const output:ChunkOutput={entities:[
      {id:'lin',kind:'character',name:'小林',aliases:['林先生'],description:chunk.ordinal===0?'小林不识字。':'小林读懂了信。',evidence},
      {id:'qing',kind:'character',name:'阿青',aliases:[],description:'阿青在场。',evidence}],
    relations:[{id:'meet',from:'lin',to:'qing',label:'同行',evidence}],
    claims:[{id:'letter',kind:'foreshadowing',text:'信件的来历仍待解释。',entityIds:['lin'],evidence}]};
    const model:ModelReceipt={tenantId:source.tenantId,connectionId:'fixture',modeDigest:hash('fixture-mode'),modelIdentity:'fixture-model',evidence:'synthetic_replay',
      callId:'call-'+chunk.id,providerRequestId:'response-'+chunk.id,inputDigest:hash(chunk),outputDigest:hash(output),usage:{inputTokens:1,outputTokens:1}};
    const body={version:1 as const,planDigest:plan.digest,chunkId:chunk.id,method,output,model}; return {...body,digest:hash(body)};
  });
  const candidate=assembleBibleCandidate(source,plan,records,method);
  const decision:ReviewDecision={candidateDigest:candidate.digest,groups:[
    {id:'lin',memberIds:candidate.entities.filter(value=>value.name==='小林').map(value=>value.id),name:'小林'},
    {id:'qing',memberIds:candidate.entities.filter(value=>value.name==='阿青').map(value=>value.id),name:'阿青'}],rejectedEntityIds:[],
    selectedRelationIds:candidate.relations.map(value=>value.id),selectedClaimIds:candidate.claims.map(value=>value.id)};
  const host:ReviewHost={actor:{kind:'human',id:'reviewer'},tenantId:source.tenantId,projectId:source.projectId,at:'2026-11-16T10:00:00.000Z',authorize:()=>true};
  return {source,plan,candidate,decision,host};
}

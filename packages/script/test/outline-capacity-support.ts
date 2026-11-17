import { assembleBibleCandidate,captureSource,confirmBible,createChunkPlan } from '@camery/bible';
import { bibleRunDigest } from '@camery/bible/node';
import { reviewFixture } from '../../bible/test/review-support.js';
import type { OutlineSourceSnapshot } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import { captureStoredOutlineSource } from '../src/outline/node/source.js';

/** Synthetic extraction payloads with genuine source evidence; no live inference, billing or quality signoff. */
export function largeBibleFixture():ReturnType<typeof reviewFixture>{
  const f=reviewFixture();
  const records=f.candidate.records.map(record=>{
    const evidence=record.output.claims[0]!.evidence;
    const output={...record.output,claims:Array.from({length:64},(_,index)=>({id:`claim-${index}`,kind:'foreshadowing' as const,text:'c'.repeat(1000),entityIds:['lin'],evidence}))};
    const {digest:_digest,...fields}=record;const body={...fields,output,model:{...record.model,outputDigest:hash(output)}};
    return {...body,digest:hash(body)};
  });
  const candidate=assembleBibleCandidate(f.source,f.plan,records,f.candidate.method);
  return {...f,candidate,decision:{...f.decision,candidateDigest:candidate.digest,selectedClaimIds:candidate.claims.map(claim=>claim.id)}};
}

/** Actual domain confirmation by an explicit synthetic human test host, then the normal trusted-store projection. */
export function largeBibleOutlineSource(chunkCharacters?:number):OutlineSourceSnapshot{
  const f=chunkCharacters===undefined?largeBibleFixture():progressBibleFixture(chunkCharacters);
  const review=confirmBible(f.source,f.candidate,f.decision,f.host),source=captureSource(f.source),model=f.candidate.records[0]!.model;
  const execution={connectionId:model.connectionId,modeDigest:model.modeDigest,modelIdentity:model.modelIdentity,evidence:'synthetic_replay' as const,modelTier:'economy' as const,currency:'CNY',
    reservation:{tokens:100,costMicros:0},limits:{steps:f.plan.chunks.length,tokens:100*f.plan.chunks.length,costMicros:0}};
  const run={tenantId:f.source.tenantId,projectId:f.source.projectId,runId:'capacity-bible',source,plan:f.plan,method:f.candidate.method,execution,
    digest:bibleRunDigest(f.plan,f.candidate.method,execution),createdAt:f.host.at};
  const descriptor={kind:'bible' as const,tenantId:run.tenantId,projectId:run.projectId,runId:run.runId,runDigest:run.digest,
    documentId:source.source.documentId,revision:source.source.revision,sourceDigest:source.source.sourceDigest,reviewDigest:review.digest};
  return captureStoredOutlineSource(descriptor,{run,records:f.candidate.records,candidate:f.candidate,review});
}

/** More real UTF16 chunks grow independently bounded envelopes without inventing an approved JSON snapshot. */
export function progressBibleFixture(chunkCharacters:number):ReturnType<typeof reviewFixture>{
  const f=largeBibleFixture(),plan=createChunkPlan(f.source,{maxCharacters:chunkCharacters,maxBytes:88});
  const records=plan.chunks.map((chunk,index)=>{
    const template=f.candidate.records[index%f.candidate.records.length]!;
    const text=f.source.document.text.slice(chunk.start,chunk.end),quote=text.trim(),start=text.indexOf(quote),evidence=[{start,end:start+quote.length,quote}];
    const output={entities:template.output.entities.map(entity=>({...entity,evidence})),relations:template.output.relations.map(relation=>({...relation,evidence})),
      claims:template.output.claims.map(claim=>({...claim,evidence}))};
    const body={version:1 as const,planDigest:plan.digest,chunkId:chunk.id,method:f.candidate.method,output,
      model:{...template.model,callId:'call-'+chunk.id,providerRequestId:'response-'+chunk.id,inputDigest:hash(chunk),outputDigest:hash(output)}};
    return {...body,digest:hash(body)};
  });
  const candidate=assembleBibleCandidate(f.source,plan,records,f.candidate.method);
  const groups=f.decision.groups.map(group=>({...group,memberIds:candidate.entities.filter(entity=>entity.name===group.name).map(entity=>entity.id)}));
  return {...f,plan,candidate,decision:{...f.decision,groups,candidateDigest:candidate.digest,selectedRelationIds:candidate.relations.map(relation=>relation.id),selectedClaimIds:candidate.claims.map(claim=>claim.id)}};
}

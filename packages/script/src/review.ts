import { z } from 'zod';
import { Hash,Id,Text,Stage,DevelopmentError,ENVELOPE_BYTES } from './contracts.js';
import type { DevelopmentBrief,DevelopmentCandidate,DevelopmentReviewHost,ReviewedDevelopment,RejectedDevelopment,DevelopmentStage,OutputByStage } from './contracts.js';
import { validateBrief } from './brief.js';
import { validateFoundation } from './foundation.js';
import { validateEpisodes } from './episodes.js';
import { validateFoundationCandidate,validateEpisodeCandidate } from './development.js';
import { validateReviewedFoundation,canonicalTime } from './reviewed.js';
import { copy,freeze,hash,parse } from './data.js';

const Decision=z.strictObject({candidateDigest:Hash,output:z.unknown()});
const Identity=z.strictObject({tenantId:Id,projectId:Id,actor:z.strictObject({kind:z.literal('human'),id:Id}),at:z.string().max(24)});
function captureHost(supplied:DevelopmentReviewHost){
  try{
    const fields:Record<string,unknown>={};
    for(const name of ['tenantId','projectId','actor','at','authorize']){
      const descriptor=Object.getOwnPropertyDescriptor(supplied,name);if(!descriptor||!('value' in descriptor))throw new Error();fields[name]=descriptor.value;
    }
    const callback=fields['authorize'];if(typeof callback!=='function')throw new Error();delete fields['authorize'];
    const identity=Identity.parse(copy(fields));if(!canonicalTime(identity.at))throw new Error();
    return {identity:freeze(identity),authorize:callback as DevelopmentReviewHost['authorize']};
  }catch{throw new DevelopmentError('FORBIDDEN','human review host');}
}
function permit(brief:DevelopmentBrief,stage:DevelopmentStage,supplied:DevelopmentReviewHost){
  const host=captureHost(supplied);if(host.identity.tenantId!==brief.tenantId||host.identity.projectId!==brief.projectId)throw new DevelopmentError('FORBIDDEN','human review scope');
  try{
    const allowed:unknown=host.authorize(freeze({actorId:host.identity.actor.id,brief,stage,action:'development:review' as const}));
    if(allowed!==true){
      // A mistaken async predicate must fail closed without leaving an unhandled rejection in the host process.
      void Promise.resolve(allowed).catch(()=>{});throw new Error();
    }
  }
  catch{throw new DevelopmentError('FORBIDDEN','human review authorization');}
  return host.identity;
}
function review<S extends DevelopmentStage>(candidate:DevelopmentCandidate<S>,decisionInput:unknown,outputFor:(value:unknown)=>OutputByStage[S],host:DevelopmentReviewHost):ReviewedDevelopment<S>{
  const decision=parse(Decision,copy(decisionInput,ENVELOPE_BYTES),'review decision');if(decision.candidateDigest!==candidate.digest)throw new DevelopmentError('CONFLICT','review candidate digest');
  const output=outputFor(decision.output);const identity=permit(candidate.brief,candidate.stage,host);
  const body={version:1 as const,status:'reviewed' as const,stage:candidate.stage,brief:candidate.brief,candidateDigest:candidate.digest,upstreamDigest:candidate.upstreamDigest,output,actorId:identity.actor.id,at:identity.at};
  copy(body);return freeze({...body,digest:hash(body)});
}
/** A stage review unlocks the next development step, never formal IR adoption. */
export function reviewFoundation(current:DevelopmentBrief,candidate:DevelopmentCandidate<'foundation'>,decision:unknown,host:DevelopmentReviewHost):ReviewedDevelopment<'foundation'>{
  const actual=validateFoundationCandidate(current,candidate);return review(actual,decision,validateFoundation,host);
}
export function reviewEpisodes(current:DevelopmentBrief,foundation:ReviewedDevelopment<'foundation'>,candidate:DevelopmentCandidate<'episodes'>,decision:unknown,host:DevelopmentReviewHost):ReviewedDevelopment<'episodes'>{
  const brief=validateBrief(current);const upstream=validateReviewedFoundation(brief,foundation);const actual=validateEpisodeCandidate(brief,upstream,candidate);
  return review(actual,decision,value=>validateEpisodes(brief,upstream.output,value),host);
}
/** A historical candidate may be rejected against its own frozen brief/upstream; the host must still authorize this project. */
export function rejectDevelopment(current:DevelopmentBrief,candidate:DevelopmentCandidate,reasonInput:unknown,host:DevelopmentReviewHost,foundation?:ReviewedDevelopment<'foundation'>):RejectedDevelopment{
  const brief=validateBrief(current);const snapshot=copy(candidate);const stage=parse(z.object({stage:Stage}),snapshot,'rejection candidate').stage;let actual:DevelopmentCandidate;
  if(stage==='foundation')actual=validateFoundationCandidate(brief,snapshot);
  else{if(!foundation)throw new DevelopmentError('INCOMPLETE','foundation review required');actual=validateEpisodeCandidate(brief,foundation,snapshot);}
  const reason=parse(Text(1000),copy(reasonInput),'rejection reason');const identity=permit(brief,actual.stage,host);
  const body={version:1 as const,status:'rejected' as const,stage:actual.stage,brief,candidateDigest:actual.digest,actorId:identity.actor.id,at:identity.at,reason};
  return freeze({...body,digest:hash(body)});
}

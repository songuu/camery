import { z } from 'zod';
import { Hash,Id,Text } from '../../contracts.js';
import { canonicalTime } from '../../reviewed.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { AblationAssessmentSchema,OutlineBriefSchema,OutlineWaiverSchema,OUTLINE_ENVELOPE_BYTES } from '../generation-contracts.js';
import type { OutlineBrief,OutlineCandidate,OutlineReviewHost,ReviewedOutline,RejectedOutline } from '../generation-contracts.js';
import { reviewOutlineCraft,validateOutline } from '../outline.js';
import { copy,hash } from './data.js';
import { outlineContext,validateOutlineCandidate } from './generation.js';

const Decision=z.strictObject({candidateDigest:Hash,output:z.unknown(),ablations:z.array(AblationAssessmentSchema).max(2),waivers:z.array(OutlineWaiverSchema).max(400)});
const Identity=z.strictObject({tenantId:Id,projectId:Id,actor:z.strictObject({kind:z.literal('human'),id:Id}),at:z.string().max(24)});
const Reviewed=z.strictObject({version:z.literal(1),status:z.literal('reviewed'),brief:OutlineBriefSchema,source:z.unknown(),candidateDigest:Hash,
  output:z.unknown(),report:z.unknown(),ablations:Decision.shape.ablations,waivers:Decision.shape.waivers,actorId:Id,at:z.string().max(24),digest:Hash});

/** Capture a trusted host before persistence waits; it grants no permission by itself. */
export function captureOutlineReviewHost(input:OutlineReviewHost):OutlineReviewHost{
  try{
    const fields:Record<string,unknown>={};
    for(const name of ['tenantId','projectId','actor','at','authorize']){
      const descriptor=Object.getOwnPropertyDescriptor(input,name);if(!descriptor||!('value' in descriptor))throw new Error();fields[name]=descriptor.value;
    }
    const authorize=fields['authorize'];delete fields['authorize'];if(typeof authorize!=='function')throw new Error();
    const identity=capture(Identity,fields,'review host',2048);if(!canonicalTime(identity.at))throw new Error();
    return Object.freeze({...deepFreeze(identity),authorize:authorize as OutlineReviewHost['authorize']});
  }catch{throw new OutlineError('FORBIDDEN','human host','host');}
}
function permit(brief:OutlineBrief,action:'outline:review'|'outline:reject',host:OutlineReviewHost){
  if(host.tenantId!==brief.tenantId||host.projectId!==brief.projectId)throw new OutlineError('FORBIDDEN','review scope','host');
  try{
    const allowed:unknown=host.authorize(deepFreeze({actorId:host.actor.id,brief,action}));
    if(allowed!==true){void Promise.resolve(allowed).catch(()=>{});throw new Error();}
  }catch{throw new OutlineError('FORBIDDEN','human authorization','host');}
}
function build(candidate:OutlineCandidate,input:unknown,actorId:string,at:string):ReviewedOutline{
  const decision=capture(Decision,input,'review decision',OUTLINE_ENVELOPE_BYTES);
  if(decision.candidateDigest!==candidate.digest)throw new OutlineError('CONFLICT','review candidate','candidateDigest');
  const context=outlineContext(candidate.brief,candidate.source);const output=validateOutline(context,decision.output);
  const report=reviewOutlineCraft(context,output,candidate.brief.thresholds);
  const auxiliary=candidate.brief.auxiliaryGenres;const byGenre=new Map(decision.ablations.map(item=>[item.genre,item]));
  if(byGenre.size!==decision.ablations.length||decision.ablations.some(item=>!auxiliary.includes(item.genre)))throw new OutlineError('INVALID_REFERENCE','ablation assessments','ablations');
  if(byGenre.size!==auxiliary.length)throw new OutlineError('INCOMPLETE','ablation assessments','ablations');
  const ablations=auxiliary.map(genre=>byGenre.get(genre)!);
  const required=report.issues.filter(issue=>{
    if(issue.code!=='ABLATION_REVIEW')return true;
    const index=Number(issue.path.split('.').at(-1));return byGenre.get(output.recipe.ablations[index]!.genre)!.judgment==='label_only';
  });
  const requiredIds=new Set(required.map(issue=>issue.id));const byIssue=new Map(decision.waivers.map(item=>[item.issueId,item]));
  if(byIssue.size!==decision.waivers.length||decision.waivers.some(item=>!requiredIds.has(item.issueId)))throw new OutlineError('INVALID_REFERENCE','located waivers','waivers');
  if(byIssue.size!==requiredIds.size)throw new OutlineError('INCOMPLETE','unresolved craft issues','waivers');
  const waivers=required.map(issue=>byIssue.get(issue.id)!);
  const body={version:1 as const,status:'reviewed' as const,brief:candidate.brief,source:candidate.source,candidateDigest:candidate.digest,output,report,ablations,waivers,actorId,at};
  copy(body);return deepFreeze({...body,digest:hash(body)});
}
/** A review is not formal adoption, legal clearance or proof of measured creative quality. */
export function reviewOutline(brief:unknown,source:unknown,candidateInput:unknown,decision:unknown,suppliedHost:OutlineReviewHost):ReviewedOutline{
  const host=captureOutlineReviewHost(suppliedHost);const candidate=validateOutlineCandidate(brief,source,candidateInput);
  const reviewed=build(candidate,decision,host.actor.id,host.at);permit(candidate.brief,'outline:review',host);return reviewed;
}
/** Integrity replay of an actual stored audit, never a way to authorize a caller-provided JSON approval. */
export function validateReviewedOutline(brief:unknown,source:unknown,candidateInput:unknown,input:unknown):ReviewedOutline{
  const candidate=validateOutlineCandidate(brief,source,candidateInput);const raw=capture(Reviewed,input,'stored review',OUTLINE_ENVELOPE_BYTES);
  if(!canonicalTime(raw.at))throw new OutlineError('INVALID_INPUT','review timestamp','at');
  const actual=build(candidate,{candidateDigest:raw.candidateDigest,output:raw.output,ablations:raw.ablations,waivers:raw.waivers},raw.actorId,raw.at);
  const {digest:_digest,...body}=raw;
  if(actual.digest!==raw.digest||hash(body)!==actual.digest)throw new OutlineError('CONFLICT','stored review binding','review');return actual;
}
export function rejectOutline(brief:unknown,source:unknown,candidateInput:unknown,reasonInput:unknown,suppliedHost:OutlineReviewHost):RejectedOutline{
  const host=captureOutlineReviewHost(suppliedHost);const candidate=validateOutlineCandidate(brief,source,candidateInput);
  const reason=capture(Text(1000),reasonInput,'rejection reason',8192);permit(candidate.brief,'outline:reject',host);
  const body={version:1 as const,status:'rejected' as const,brief:candidate.brief,source:candidate.source,candidateDigest:candidate.digest,reason,actorId:host.actor.id,at:host.at};
  copy(body);return deepFreeze({...body,digest:hash(body)});
}

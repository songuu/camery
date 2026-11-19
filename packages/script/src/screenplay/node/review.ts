import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,SCREENPLAY_CANDIDATE_BYTES,ScreenplayError} from '../contracts.js';
import {inspectScreenplayDraft,validateScreenplayContext} from '../context.js';
import {checkScreenplay} from '../validate.js';
import {estimateScreenplayTiming,screenplayTimingIssues} from '../timing.js';
import {createScreenplayLineBook} from '../line-book.js';
import {projectScreenplayContinuity} from '../context.js';
import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import {ScreenplayScopeSchema,ScreenplayCandidateSchema,ScreenplayReviewSchema,ScreenplayReviewDecisionSchema} from './contracts.js';
import type {ScreenplayCandidate,ScreenplayReview} from './contracts.js';
import {authorizeScreenplayHost} from './host.js';
const equal=(a:unknown,b:unknown)=>canonicalContinuity(a,SCREENPLAY_CANDIDATE_BYTES)===canonicalContinuity(b,SCREENPLAY_CANDIDATE_BYTES);
function conflict(path:string):never{throw new ScreenplayError('CONFLICT','screenplay review binding',path);}
/** Pure integrity projection, never an approval. Trusted source readers establish adoption and currentness. */
export function createScreenplayCandidate(scopeInput:unknown,contextInput:unknown,draftInput:unknown):ScreenplayCandidate{
  const scope=captureScreenplay(ScreenplayScopeSchema,scopeInput,'candidate scope',1024),{context,draft,issues}=inspectScreenplayDraft(contextInput,draftInput);
  if(issues.some(row=>row.severity==='error'))throw new ScreenplayError('INVALID_REFERENCE','candidate structure',issues[0]!.path);
  const report=checkScreenplay(context,draft),timing=estimateScreenplayTiming(context,draft),lineBook=createScreenplayLineBook(context,draft),continuity=projectScreenplayContinuity(context,draft);
  const findings=[...new Map([...report.issues,...screenplayTimingIssues(context,draft)].map(row=>[row.id,row])).values()];
  const body={version:1 as const,status:'candidate' as const,scope,contextDigest:continuityDigest(context,SCREENPLAY_CONTEXT_BYTES),draft,report,issues:findings,timing,lineBook,continuity};
  return freezeScreenplay(captureScreenplay(ScreenplayCandidateSchema,{...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)},'screenplay candidate',SCREENPLAY_CANDIDATE_BYTES));
}
export function validateScreenplayCandidate(context:unknown,input:unknown):ScreenplayCandidate{
  const raw=captureScreenplay(ScreenplayCandidateSchema,input,'screenplay candidate',SCREENPLAY_CANDIDATE_BYTES),actual=createScreenplayCandidate(raw.scope,context,raw.draft);
  if(!equal(raw,actual))conflict('candidate');return actual;
}
function reviewed(context:unknown,original:ScreenplayCandidate,input:unknown,actorId:string,at:string):ScreenplayReview{
  const decision=captureScreenplay(ScreenplayReviewDecisionSchema,input,'human screenplay decision',SCREENPLAY_CANDIDATE_BYTES);
  if(decision.candidateDigest!==original.digest)conflict('candidateDigest');
  const output=createScreenplayCandidate(original.scope,context,decision.draft);
  if(output.issues.some(row=>row.severity==='error'))throw new ScreenplayError('INCOMPLETE','unresolved screenplay errors','issues');
  const required=new Set(output.issues.filter(row=>row.severity==='warning').map(row=>row.id)),seen=new Set<string>();
  for(const waiver of decision.waivers){if(!required.has(waiver.issueId)||seen.has(waiver.issueId))throw new ScreenplayError('INVALID_REFERENCE','located screenplay decisions','waivers');seen.add(waiver.issueId);}
  if(seen.size!==required.size)throw new ScreenplayError('INCOMPLETE','unresolved screenplay warnings','waivers');
  const body={version:1 as const,status:'reviewed' as const,candidateDigest:original.digest,output,waivers:decision.waivers,actorId,at};
  return freezeScreenplay(captureScreenplay(ScreenplayReviewSchema,{...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)},'screenplay review',SCREENPLAY_CANDIDATE_BYTES));
}
export function reviewScreenplayCandidate(contextInput:unknown,originalInput:unknown,decisionInput:unknown,hostInput:unknown):ScreenplayReview{
  const context=validateScreenplayContext(contextInput),original=validateScreenplayCandidate(context,originalInput),decision=freezeScreenplay(captureScreenplay(ScreenplayReviewDecisionSchema,decisionInput,'human screenplay decision',SCREENPLAY_CANDIDATE_BYTES)),host=authorizeScreenplayHost(hostInput,'screenplay:review',original.scope);
  return reviewed(context,original,decision,host.actor.id,host.at);
}
/** Replays immutable integrity only. It cannot replace a stored human audit or current authority. */
export function validateScreenplayReview(context:unknown,originalInput:unknown,input:unknown):ScreenplayReview{
  const original=validateScreenplayCandidate(context,originalInput),raw=captureScreenplay(ScreenplayReviewSchema,input,'stored screenplay review',SCREENPLAY_CANDIDATE_BYTES);
  const actual=reviewed(context,original,{candidateDigest:raw.candidateDigest,draft:raw.output.draft,waivers:raw.waivers},raw.actorId,raw.at);
  if(!equal(raw,actual))conflict('review');return actual;
}

import {z} from 'zod';
import {Id} from '../../contracts.js';
import {canonicalTime} from '../../reviewed.js';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {ContinuityError,ContinuityLedgerSchema,CONTINUITY_LEDGER_BYTES} from '../contracts.js';
import type {ContinuityCandidate} from '../contracts.js';
import {createContinuityCandidate,validateContinuityCandidate} from './candidate.js';
import {validateContinuityContext} from '../context.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
import {CONTINUITY_RECORD_BYTES,ContinuityRejectDecisionSchema,ContinuityReviewDecisionSchema,ContinuityReviewSchema,ContinuityScopeSchema} from './persistence-contracts.js';
import type {ContinuityAction,ContinuityReview,ContinuityReviewHost} from './persistence-contracts.js';

const Identity=z.strictObject({actor:z.strictObject({kind:z.literal('human'),id:Id}),scope:ContinuityScopeSchema,at:z.iso.datetime({precision:3})});
const Action=z.enum(['continuity:read','continuity:prepare','continuity:review','continuity:reject']);
const hostFields=['actor','scope','at','authorize'];
function failure(code:'FORBIDDEN'|'CONFLICT'|'INCOMPLETE'|'INVALID_REFERENCE'|'INVALID_INPUT',operation:string,path:string):never{throw new ContinuityError(code,operation,path);}

/** Capture trusted deployment authority without evaluating caller properties; capture itself grants no permission. */
export function captureContinuityReviewHost(input:unknown):ContinuityReviewHost{
  try{
    if(input===null||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.getOwnPropertySymbols(input).length)throw new Error();
    const descriptors=Object.getOwnPropertyDescriptors(input),names=Object.keys(descriptors);if(names.length!==hostFields.length||names.some(name=>!hostFields.includes(name)))throw new Error();
    const fields:Record<string,unknown>={};for(const name of hostFields){const descriptor=descriptors[name];if(!descriptor||!descriptor.enumerable||!('value' in descriptor))throw new Error();fields[name]=descriptor.value;}
    const authorize=fields['authorize'];delete fields['authorize'];if(typeof authorize!=='function')throw new Error();
    const identity=captureContinuity(Identity,fields,'human identity',2048);if(!canonicalTime(identity.at))throw new Error();
    return Object.freeze({...freezeContinuity(identity),authorize:authorize as ContinuityReviewHost['authorize']});
  }catch{throw new ContinuityError('FORBIDDEN','human host','host');}
}
/** Grants are synchronous literal true. Observe a mistaken real Promise while never assimilating arbitrary thenables. */
export function authorizeContinuityHost(hostInput:unknown,action:ContinuityAction,scopeInput:unknown):ContinuityReviewHost{
  const host=captureContinuityReviewHost(hostInput);
  try{
    const scope=captureContinuity(ContinuityScopeSchema,scopeInput,'authorization scope',1024);
    if(!Action.safeParse(action).success||scope.tenantId!==host.scope.tenantId||scope.projectId!==host.scope.projectId)throw new Error();
    const allowed:unknown=host.authorize(freezeContinuity({action,scope}));if(allowed!==true){try{void Promise.prototype.then.call(allowed as Promise<unknown>,undefined,()=>{});}catch{/* The intrinsic checks real Promise slots; this assertion never grants a thenable or reads its then property. */}throw new Error();}
    return host;
  }catch{throw new ContinuityError('FORBIDDEN','human authorization','host');}
}
const waiverKey=(value:{code:string;path:string})=>JSON.stringify([value.code,value.path]);
function sourceInputs(contextInput:unknown,previousInput:unknown){return {context:validateContinuityContext(contextInput),previous:previousInput===null?null:freezeContinuity(captureContinuity(ContinuityLedgerSchema,previousInput,'review predecessor',CONTINUITY_LEDGER_BYTES))};}
function reviewed(context:unknown,original:ContinuityCandidate,input:unknown,actorId:string,at:string,previous:unknown):ContinuityReview{
  const decision=captureContinuity(ContinuityReviewDecisionSchema,input,'review decision',CONTINUITY_RECORD_BYTES);
  if(decision.candidateDigest!==original.digest)failure('CONFLICT','review candidate','candidateDigest');
  if(decision.draft.episodeId!==original.draft.episodeId)failure('CONFLICT','review episode','draft.episodeId');
  const output=createContinuityCandidate(original.scope,context,decision.draft,previous);
  if(output.issues.some(issue=>issue.severity==='error'))failure('INCOMPLETE','review errors','output.issues');
  const warnings=new Set(output.issues.filter(issue=>issue.severity==='warning').map(waiverKey)),waivers=new Set<string>();
  for(const [index,value] of decision.waivers.entries()){const key=waiverKey(value);if(!warnings.has(key)||waivers.has(key))failure('INVALID_REFERENCE','located waivers',`waivers.${index}`);waivers.add(key);}
  if(waivers.size!==warnings.size)failure('INCOMPLETE','unresolved warnings','waivers');
  const body={version:1 as const,status:'reviewed' as const,candidateDigest:original.digest,output,waivers:decision.waivers,actorId,at};
  return freezeContinuity(captureContinuity(ContinuityReviewSchema,{...body,digest:continuityDigest(body,CONTINUITY_RECORD_BYTES)},'review record',CONTINUITY_RECORD_BYTES));
}
function rejected(original:ContinuityCandidate,input:unknown,actorId:string,at:string):ContinuityReview{
  const decision=captureContinuity(ContinuityRejectDecisionSchema,input,'rejection decision',CONTINUITY_RECORD_BYTES);if(decision.candidateDigest!==original.digest)failure('CONFLICT','rejection candidate','candidateDigest');
  const body={version:1 as const,status:'rejected' as const,candidateDigest:original.digest,reason:decision.reason,actorId,at};
  return freezeContinuity(captureContinuity(ContinuityReviewSchema,{...body,digest:continuityDigest(body,CONTINUITY_RECORD_BYTES)},'rejection record',CONTINUITY_RECORD_BYTES));
}
/** Review preserves the original candidate and separately recompiles the edited draft; it never creates native adoption authority. */
export function reviewContinuityCandidate(contextInput:unknown,originalInput:unknown,decisionInput:unknown,hostInput:unknown,previousInput:unknown=null):ContinuityReview{
  const captured=captureContinuityReviewHost(hostInput),{context,previous}=sourceInputs(contextInput,previousInput),original=validateContinuityCandidate(context,originalInput,previous),decision=captureContinuity(ContinuityReviewDecisionSchema,decisionInput,'review decision',CONTINUITY_RECORD_BYTES),host=authorizeContinuityHost(captured,'continuity:review',original.scope);
  return reviewed(context,original,decision,host.actor.id,host.at,previous);
}
/** The store may supply an actual historical source to record a refusal; currentness is not invented by this pure helper. */
export function rejectContinuityCandidate(contextInput:unknown,originalInput:unknown,decisionInput:unknown,hostInput:unknown,previousInput:unknown=null):ContinuityReview{
  const captured=captureContinuityReviewHost(hostInput),{context,previous}=sourceInputs(contextInput,previousInput),original=validateContinuityCandidate(context,originalInput,previous),decision=captureContinuity(ContinuityRejectDecisionSchema,decisionInput,'rejection decision',CONTINUITY_RECORD_BYTES),host=authorizeContinuityHost(captured,'continuity:reject',original.scope);
  return rejected(original,decision,host.actor.id,host.at);
}
/** Integrity replay only. Callers must read the original and audit from trusted storage; a digest or this function grants no permission. */
export function validateContinuityReview(contextInput:unknown,originalInput:unknown,input:unknown,previousInput:unknown=null):ContinuityReview{
  const original=validateContinuityCandidate(contextInput,originalInput,previousInput),raw=captureContinuity(ContinuityReviewSchema,input,'stored review',CONTINUITY_RECORD_BYTES);
  if(!canonicalTime(raw.at))failure('INVALID_INPUT','review timestamp','at');
  const actual=raw.status==='reviewed'?reviewed(contextInput,original,{candidateDigest:raw.candidateDigest,draft:raw.output.draft,waivers:raw.waivers},raw.actorId,raw.at,previousInput):rejected(original,{candidateDigest:raw.candidateDigest,reason:raw.reason},raw.actorId,raw.at);
  if(canonicalContinuity(raw,CONTINUITY_RECORD_BYTES)!==canonicalContinuity(actual,CONTINUITY_RECORD_BYTES))failure('CONFLICT','stored review binding','review');return actual;
}

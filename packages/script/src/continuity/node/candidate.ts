import {z} from 'zod';
import {Id} from '../../contracts.js';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {ContinuityCandidateSchema,ContinuityLedgerSchema,ContinuityError,CONTINUITY_CONTEXT_BYTES,CONTINUITY_CANDIDATE_BYTES,CONTINUITY_LEDGER_BYTES} from '../contracts.js';
import type {ContinuityCandidate} from '../contracts.js';
import {validateContinuityContext,validateContinuityDraft} from '../context.js';
import {reduceEpisodeContinuity} from '../reduce.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
const scopeSchema=z.strictObject({tenantId:Id,projectId:Id});
/** Integrity-only candidate compiler. The host must separately authenticate, review and formally adopt its eventual persisted record. */
export function createContinuityCandidate(scopeInput:unknown,contextInput:unknown,draftInput:unknown,previousInput:unknown=null):ContinuityCandidate{
  const scope=captureContinuity(scopeSchema,scopeInput,'candidate scope',1024),context=validateContinuityContext(contextInput),draft=validateContinuityDraft(context,draftInput);
  const previous=previousInput===null?null:captureContinuity(ContinuityLedgerSchema,previousInput,'previous ledger',CONTINUITY_LEDGER_BYTES);
  const reduction=reduceEpisodeContinuity(context,draft,previous),body={version:1 as const,status:'candidate' as const,scope,contextDigest:continuityDigest(context,CONTINUITY_CONTEXT_BYTES),previousDigest:previous===null?null:continuityDigest(previous,CONTINUITY_LEDGER_BYTES),draft,ledger:reduction.ledger,issues:reduction.issues};
  return freezeContinuity(captureContinuity(ContinuityCandidateSchema,{...body,digest:continuityDigest(body,CONTINUITY_CANDIDATE_BYTES)},'candidate envelope',CONTINUITY_CANDIDATE_BYTES));
}
/** Replays every field against the supplied actual context and predecessor; a matching caller-supplied digest alone is insufficient. */
export function validateContinuityCandidate(contextInput:unknown,input:unknown,previousInput:unknown=null):ContinuityCandidate{
  const candidate=captureContinuity(ContinuityCandidateSchema,input,'candidate record',CONTINUITY_CANDIDATE_BYTES),rebuilt=createContinuityCandidate(candidate.scope,contextInput,candidate.draft,previousInput);
  if(canonicalContinuity(candidate,CONTINUITY_CANDIDATE_BYTES)!==canonicalContinuity(rebuilt,CONTINUITY_CANDIDATE_BYTES))throw new ContinuityError('CONFLICT','candidate replay','digest');return rebuilt;
}

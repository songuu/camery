import {z} from 'zod';
import {StableId,RevisionRef,EventRefSchema,ContinuityDraftSchema,ContinuityLedgerSchema} from '@camery/ir';
export {CONTINUITY_DRAFT_BYTES,CONTINUITY_LEDGER_BYTES,EventRefSchema,EvidenceSchema,CharacterLedgerValueSchema,ContinuityEventSchema,ContinuityDraftSchema,LedgerEvidenceSchema,ContinuityLedgerSchema} from '@camery/ir';
export type {EventRef,Evidence,ContinuityEvent,ContinuityDraft,LedgerEvidence,ContinuityLedger} from '@camery/ir';
import {Id,Integer,LocalId,Text,Hash} from '../contracts.js';
import type {ContinuityLedger} from '@camery/ir';

export const CONTINUITY_CONTEXT_BYTES=67_108_864;
export const CONTINUITY_CANDIDATE_BYTES=8_388_608;
export const ContinuityContextSchema=z.strictObject({version:z.literal(1),projectId:StableId,packageId:StableId,snapshotRevision:Integer.min(1),
  episodes:z.array(z.strictObject({id:StableId,version:Integer.min(1),number:Integer.min(1)})).min(1).max(100),
  characters:z.array(RevisionRef),props:z.array(RevisionRef),
  appearances:z.array(z.strictObject({id:StableId,version:Integer.min(1),characterId:StableId})),
  spots:z.array(z.strictObject({id:StableId,location:RevisionRef})),
  events:z.array(z.strictObject({ref:EventRefSchema,episodeId:StableId,sequence:Integer.min(1),characterIds:z.array(StableId),speakerId:StableId.nullable(),lineKind:z.enum(['on_screen','inner_monologue','off_screen','narration']).nullable(),text:z.string()})),
});
export type ContinuityContext=z.infer<typeof ContinuityContextSchema>;
export const ContinuityIssueSchema=z.strictObject({code:z.enum(['UNKNOWN_FACT','RETIRED_FACT','FACT_CONFLICT','KNOWLEDGE_SOURCE','KNOWLEDGE_REQUIRED','UNKNOWN_THREAD','THREAD_CONFLICT','PAYOFF_ORDER','OVERDUE_THREAD']),
  severity:z.enum(['error','warning']),path:Text(2048),eventId:LocalId.nullable(),message:Text(1000)});
export type ContinuityIssue=z.infer<typeof ContinuityIssueSchema>;
export interface ContinuityReduction {readonly ledger:ContinuityLedger;readonly issues:readonly ContinuityIssue[]}
// This envelope is an integrity record, never a claim that a human or the formal version service adopted it.
export const ContinuityCandidateSchema=z.strictObject({version:z.literal(1),status:z.literal('candidate'),scope:z.strictObject({tenantId:Id,projectId:Id}),
  contextDigest:Hash,previousDigest:Hash.nullable(),draft:ContinuityDraftSchema,ledger:ContinuityLedgerSchema,issues:z.array(ContinuityIssueSchema).max(4096),digest:Hash});
export type ContinuityCandidate=z.infer<typeof ContinuityCandidateSchema>;
export class ContinuityError extends Error{
  override readonly name='ContinuityError';
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT'|'INVALID_REFERENCE'|'CONFLICT'|'INCOMPLETE'|'FORBIDDEN'|'NOT_FOUND'|'UNADOPTED_SNAPSHOT'|'STORAGE_FAILED',readonly operation:string,readonly path:string){super(`Continuity ${operation} failed (${code}) at ${path}`);}
}

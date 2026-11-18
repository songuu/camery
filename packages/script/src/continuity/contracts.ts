import {z} from 'zod';
import {StableId,RevisionRef} from '@camery/ir';
import {Id,Integer,LocalId,Text,Hash} from '../contracts.js';

export const CONTINUITY_CONTEXT_BYTES=67_108_864;
export const CONTINUITY_DRAFT_BYTES=524_288;
export const CONTINUITY_LEDGER_BYTES=2_097_152;
export const CONTINUITY_CANDIDATE_BYTES=8_388_608;
export const EventRefSchema=z.strictObject({kind:z.enum(['beat','line']),id:StableId,version:Integer.min(1)});
export type EventRef=z.infer<typeof EventRefSchema>;
export const EvidenceSchema=z.strictObject({event:EventRefSchema,quote:Text(2000)});
export type Evidence=z.infer<typeof EvidenceSchema>;
export const ContinuityContextSchema=z.strictObject({version:z.literal(1),projectId:StableId,packageId:StableId,snapshotRevision:Integer.min(1),
  episodes:z.array(z.strictObject({id:StableId,version:Integer.min(1),number:Integer.min(1)})).min(1).max(100),
  characters:z.array(RevisionRef),props:z.array(RevisionRef),
  appearances:z.array(z.strictObject({id:StableId,version:Integer.min(1),characterId:StableId})),
  spots:z.array(z.strictObject({id:StableId,location:RevisionRef})),
  events:z.array(z.strictObject({ref:EventRefSchema,episodeId:StableId,sequence:Integer.min(1),characterIds:z.array(StableId),speakerId:StableId.nullable(),lineKind:z.enum(['on_screen','inner_monologue','off_screen','narration']).nullable(),text:z.string()})),
});
export type ContinuityContext=z.infer<typeof ContinuityContextSchema>;
const eventBase={id:LocalId,evidence:EvidenceSchema};
const learning=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('witness')}),
  z.strictObject({kind:z.literal('told'),fromCharacterId:StableId}),
  z.strictObject({kind:z.literal('deduced'),factIds:z.array(LocalId).min(1).max(32)}),
]);
export const CharacterLedgerValueSchema=z.strictObject({characterId:StableId,summary:Text(1000),appearance:RevisionRef.nullable(),spot:z.strictObject({id:StableId,location:RevisionRef}).nullable(),holding:z.array(RevisionRef).max(64)});
export const ContinuityEventSchema=z.discriminatedUnion('op',[
  z.strictObject({...eventBase,op:z.literal('assert_fact'),factId:LocalId,kind:z.enum(['fact','world_rule','timeline']),text:Text(1000)}),
  z.strictObject({...eventBase,op:z.literal('retire_fact'),factId:LocalId}),
  z.strictObject({...eventBase,op:z.literal('learn'),characterId:StableId,factId:LocalId,source:learning}),
  z.strictObject({...eventBase,op:z.literal('use_fact'),characterId:StableId,factId:LocalId}),
  z.strictObject({...eventBase,op:z.literal('set_character'),value:CharacterLedgerValueSchema}),
  z.strictObject({...eventBase,op:z.literal('plant'),threadId:LocalId,summary:Text(1000),payoffEpisodeId:StableId.nullable()}),
  z.strictObject({...eventBase,op:z.literal('payoff'),threadId:LocalId}),
]);
export type ContinuityEvent=z.infer<typeof ContinuityEventSchema>;
export const ContinuityDraftSchema=z.strictObject({version:z.literal(1),episodeId:StableId,events:z.array(ContinuityEventSchema).max(2048)});
export type ContinuityDraft=z.infer<typeof ContinuityDraftSchema>;
export const LedgerEvidenceSchema=z.strictObject({episodeId:StableId,eventId:LocalId,order:Integer.min(1).max(2048),evidence:EvidenceSchema});
export type LedgerEvidence=z.infer<typeof LedgerEvidenceSchema>;
export const ContinuityLedgerSchema=z.strictObject({version:z.literal(1),projectId:StableId,packageId:StableId,episodeId:StableId,snapshotRevision:Integer.min(1),
  facts:z.array(z.strictObject({id:LocalId,kind:z.enum(['fact','world_rule','timeline']),text:Text(1000),introduced:LedgerEvidenceSchema,retired:LedgerEvidenceSchema.nullable()})).max(2048),
  knowledge:z.array(z.strictObject({characterId:StableId,factId:LocalId,source:learning,learned:LedgerEvidenceSchema})).max(8192),
  characters:z.array(z.strictObject({value:CharacterLedgerValueSchema,changed:LedgerEvidenceSchema})).max(256),
  threads:z.array(z.strictObject({id:LocalId,summary:Text(1000),payoffEpisodeId:StableId.nullable(),planted:LedgerEvidenceSchema,paidOff:LedgerEvidenceSchema.nullable()})).max(2048),
});
export type ContinuityLedger=z.infer<typeof ContinuityLedgerSchema>;
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
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT'|'INVALID_REFERENCE'|'CONFLICT'|'INCOMPLETE'|'NOT_FOUND'|'UNADOPTED_SNAPSHOT'|'STORAGE_FAILED',readonly operation:string,readonly path:string){super(`Continuity ${operation} failed (${code}) at ${path}`);}
}

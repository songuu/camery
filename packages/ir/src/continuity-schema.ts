import {z} from 'zod';
import {StableId,RevisionRef} from './legacy/v05-schema';
export const CONTINUITY_SCHEMA_VERSION='0.8.0-draft' as const;
export const CONTINUITY_DRAFT_BYTES=524_288;
export const CONTINUITY_LEDGER_BYTES=2_097_152;
const Integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const LocalId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$(?![\s\S])/);
const Text=(maximum:number)=>z.string().min(1).max(maximum).refine(value=>value.trim().length>0&&value.isWellFormed()&&!value.includes('\0'));
export const EventRefSchema=z.strictObject({kind:z.enum(['beat','line']),id:StableId,version:Integer.min(1)});
export type EventRef=z.infer<typeof EventRefSchema>;
export const EvidenceSchema=z.strictObject({event:EventRefSchema,quote:Text(2000)});
export type Evidence=z.infer<typeof EvidenceSchema>;
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
/** Only immutable native object/adoption history establishes adoption; this row has no caller-controlled status. */
export const ContinuitySnapshotSchema=z.strictObject({id:StableId,version:Integer.min(1),episode_id:StableId,based_on:z.array(RevisionRef).min(1).max(65536),ledger:ContinuityLedgerSchema});
export type ContinuitySnapshot=z.infer<typeof ContinuitySnapshotSchema>;
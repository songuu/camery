import { z } from 'zod';
import { ClaimKind, EntityKind, EvidenceSchema, Hash, Id, Integer, ReviewDecisionSchema, SourceIdentitySchema, Text } from './contracts.js';
import { snapshotJson } from './json.js';
// Browser-safe transport contracts: no credentials, method assets, model receipts or source snapshot bodies.
export const BibleSourceSchema=SourceIdentitySchema.omit({tenantId:true,projectId:true});
const Time=z.iso.datetime({precision:3});
const ReviewState=z.enum(['confirmed','rejected']);
const ChunkState=z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled']);
const Budget=z.strictObject({currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),tokens:Integer,costMicros:Integer});
export const BibleCapabilitiesSchema=z.strictObject({canStart:z.boolean(),modelLabel:Text(200).nullable(),budget:Budget.nullable()});
export type BibleCapabilities=z.infer<typeof BibleCapabilitiesSchema>;
export const BibleStartSchema=z.strictObject({runId:Id,documentId:Id,kind:z.enum(['novel','script']),expectedRevision:Integer.min(1),expectedSourceDigest:Hash});
export type BibleStart=z.infer<typeof BibleStartSchema>;
export const BibleListQuerySchema=z.strictObject({cursor:z.string().max(512).optional(),documentId:Id.optional(),kind:z.enum(['novel','script']).optional()});
const SummaryShape={runId:Id,createdAt:Time,source:BibleSourceSchema,completedChunks:Integer.max(4096),totalChunks:Integer.min(1).max(4096),
  candidateDigest:Hash.nullable(),reviewStatus:ReviewState.nullable(),sourceChanged:z.boolean()};
export const BibleRunSummarySchema=z.strictObject(SummaryShape).refine(value=>value.completedChunks<=value.totalChunks);
export type BibleRunSummary=z.infer<typeof BibleRunSummarySchema>;
export const BibleRunListSchema=z.strictObject({items:z.array(BibleRunSummarySchema).max(50),nextCursor:z.string().max(512).nullable()});
export type BibleRunList=z.infer<typeof BibleRunListSchema>;
const Evidence=z.array(EvidenceSchema).min(1).max(6);
const Located={id:Id,chunkId:Id,evidence:Evidence};
export const BibleCandidateViewSchema=z.strictObject({digest:Hash,
  entities:z.array(z.strictObject({...Located,kind:EntityKind,name:Text(120),aliases:z.array(Text(120)).max(12),description:Text(1000)})).max(4096),
  relations:z.array(z.strictObject({...Located,from:Id,to:Id,label:Text(300)})).max(8192),
  claims:z.array(z.strictObject({...Located,kind:ClaimKind,text:Text(1000),entityIds:z.array(Id).max(32)})).max(8192),
  mergeSuggestions:z.array(z.strictObject({entityIds:z.array(Id).min(2).max(4096),reason:z.literal('name_or_alias_overlap')})).max(4096),
});
export type BibleCandidateView=z.infer<typeof BibleCandidateViewSchema>;
export const BibleTaskViewSchema=z.strictObject({status:ChunkState,resultState:z.enum(['candidate','blocked']).nullable(),reason:z.string().regex(/^[A-Z_]{1,64}$(?![\s\S])/).nullable()});
export type BibleTaskView=z.infer<typeof BibleTaskViewSchema>;
export const BibleStatusSchema=z.strictObject({...SummaryShape,state:z.enum(['queued','running','waiting','reconciling','blocked','failed','cancelled','ready','confirmed','rejected','stale']),task:BibleTaskViewSchema.nullable()});
export type BibleStatus=z.infer<typeof BibleStatusSchema>;
const Review=z.strictObject({status:ReviewState,digest:Hash,actorId:Id,at:Time,decision:ReviewDecisionSchema.nullable(),reason:Text(1000).nullable()});
export const BibleRunViewSchema=z.strictObject({...BibleStatusSchema.shape,current:z.boolean(),candidate:BibleCandidateViewSchema.nullable(),review:Review.nullable(),budget:Budget});
export type BibleRunView=z.infer<typeof BibleRunViewSchema>;
export const BibleRejectSchema=z.strictObject({reason:Text(1000)});
export {ReviewDecisionSchema as BibleConfirmSchema};
export type {ReviewDecision as BibleConfirm} from './contracts.js';
export type {Evidence as BibleEvidence} from './contracts.js';
/** Bound the complete logical JSON before Zod copies arrays; convert arbitrary failures to schema issues. */
export function boundedBibleSchema<T>(schema:z.ZodType<T>):z.ZodType<T> {
  return z.unknown().transform((value,ctx)=>{try{return snapshotJson(value);}catch{ctx.addIssue({code:'custom',message:'Bible transport data limit'});return z.NEVER;}}).pipe(schema);
}

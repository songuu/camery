import {z} from 'zod';
import {StableId,LEGACY_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION,OUTLINE_SCHEMA_VERSION,CONTINUITY_SCHEMA_VERSION} from './schema';
import {WorkbenchActionReceiptSchema,WorkbenchExpectationSchema,WorkbenchRejectSchema,WorkbenchCandidateDetailSchema} from './workbench';
import {CandidateReceiptSchema,CandidateReceiptQuerySchema,CandidateReceiptPageSchema} from './candidate-receipts';

const ordinaryId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const stableId=StableId.refine(value=>value.length===26);
const hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision=integer.min(1);
const operationCount=integer.max(4096);
const cursor=z.string().min(1).max(4096);
// HTTP query strings are decimal selectors; coercion must not turn booleans or null into authorized positions.
const limit=z.union([z.number(),z.string().regex(/^[1-9][0-9]?$(?![\s\S])/).transform(Number)]).pipe(z.number().int().min(1).max(50));
const candidateStatus=z.enum(['prepared',...WorkbenchActionReceiptSchema.shape.status.options]);

/** Only source addresses and bases cross this boundary; the authenticated host creates the complete mapping. */
export const OutlinePrepareCommandSchema=WorkbenchExpectationSchema.extend({applicationId:ordinaryId,runDigest:hash,briefDigest:hash,candidateDigest:hash,reviewDigest:hash,sourceDigest:hash});
export type OutlinePrepareCommand=z.infer<typeof OutlinePrepareCommandSchema>;
export const OutlineAdoptCommandSchema=WorkbenchExpectationSchema;
export type OutlineAdoptCommand=z.infer<typeof OutlineAdoptCommandSchema>;
export const OutlineRejectCommandSchema=WorkbenchExpectationSchema.extend({reason:WorkbenchRejectSchema.shape.reason});
export type OutlineRejectCommand=z.infer<typeof OutlineRejectCommandSchema>;

/** Keep the original Outline DTO names as aliases of the shared source receipt contract. */
export const OutlineReceiptSchema=CandidateReceiptSchema;
export type OutlineReceipt=z.infer<typeof OutlineReceiptSchema>;
export const OutlineReceiptQuerySchema=CandidateReceiptQuerySchema;
export type OutlineReceiptQuery=z.infer<typeof OutlineReceiptQuerySchema>;
export const OutlineReceiptPageSchema=CandidateReceiptPageSchema;
export type OutlineReceiptPage=z.infer<typeof OutlineReceiptPageSchema>;

export const OutlineCandidateSchema=z.strictObject({
  contractVersion:z.literal(1),projectKey:ordinaryId,candidateId:stableId,applicationId:ordinaryId,runId:ordinaryId,status:candidateStatus,
  snapshotRevision:revision,writeVersion:revision,baseRevision:revision,operationCount,sourceState:z.enum(['current','stale','unavailable']),canReview:z.boolean(),preparation:OutlineReceiptSchema.nullable(),
}).superRefine((value,context)=>{
  const receipt=value.preparation;
  if(receipt&&(receipt.projectKey!==value.projectKey||receipt.candidateId!==value.candidateId||receipt.requestId!==value.applicationId||receipt.kind!=='preparation'))context.addIssue({code:'custom',message:'Outline preparation acknowledgement must match its candidate and application'});
});
export type OutlineCandidate=z.infer<typeof OutlineCandidateSchema>;
export const OutlineCandidateListQuerySchema=z.strictObject({runId:ordinaryId.optional(),cursor:cursor.optional(),limit:limit.optional()});
export type OutlineCandidateListQuery=z.infer<typeof OutlineCandidateListQuerySchema>;
export const OutlineCandidateHeaderSchema=z.strictObject({candidateId:stableId,applicationId:ordinaryId,runId:ordinaryId,status:candidateStatus,authorId:stableId,createdAt:z.iso.datetime({precision:3}),baseRevision:revision,operationCount});
export type OutlineCandidateHeader=z.infer<typeof OutlineCandidateHeaderSchema>;
export const OutlineCandidatePageSchema=z.strictObject({contractVersion:z.literal(1),items:z.array(OutlineCandidateHeaderSchema).max(50),nextCursor:cursor.nullable()});
export type OutlineCandidatePage=z.infer<typeof OutlineCandidatePageSchema>;

/** An ordinary manual candidate is not proof of a schema upgrade; the host verifies its immutable operation. */
export const OutlineUpgradeCandidateSchema=z.strictObject({contractVersion:z.literal(1),from:z.enum([LEGACY_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION,OUTLINE_SCHEMA_VERSION]),to:z.enum([DEVELOPMENT_SCHEMA_VERSION,OUTLINE_SCHEMA_VERSION,CONTINUITY_SCHEMA_VERSION]),candidate:WorkbenchCandidateDetailSchema}).superRefine((value,context)=>{
  if(value.to!==(value.from===LEGACY_SCHEMA_VERSION?DEVELOPMENT_SCHEMA_VERSION:value.from===DEVELOPMENT_SCHEMA_VERSION?OUTLINE_SCHEMA_VERSION:CONTINUITY_SCHEMA_VERSION)||!value.candidate.managed||value.candidate.source.kind!=='manual'||value.candidate.scope.kind!=='project')context.addIssue({code:'custom',message:'Expected a managed project schema upgrade'});
});
export type OutlineUpgradeCandidate=z.infer<typeof OutlineUpgradeCandidateSchema>;

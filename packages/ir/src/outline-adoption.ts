import {z} from 'zod';
import {StableId} from './schema';
import {WorkbenchActionReceiptSchema,WorkbenchExpectationSchema,WorkbenchIssueSchema,WorkbenchRejectSchema} from './workbench';

const ordinaryId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const stableId=StableId.refine(value=>value.length===26);
const hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision=integer.min(1);
const messageCount=integer.max(131072);
const operationCount=integer.max(4096);
const cursor=z.string().min(1).max(4096);
// HTTP query strings are decimal selectors; coercion must not turn booleans or null into authorized positions.
const limit=z.union([z.number(),z.string().regex(/^[1-9][0-9]?$(?![\s\S])/).transform(Number)]).pipe(z.number().int().min(1).max(50));
const kind=z.enum(['preparation','decision']);
const section=z.enum(['issues','warnings']);
const candidateStatus=z.enum(['prepared',...WorkbenchActionReceiptSchema.shape.status.options]);

/** Only source addresses and bases cross this boundary; the authenticated host creates the complete mapping. */
export const OutlinePrepareCommandSchema=WorkbenchExpectationSchema.extend({applicationId:ordinaryId,runDigest:hash,briefDigest:hash,candidateDigest:hash,reviewDigest:hash,sourceDigest:hash});
export type OutlinePrepareCommand=z.infer<typeof OutlinePrepareCommandSchema>;
export const OutlineAdoptCommandSchema=WorkbenchExpectationSchema;
export type OutlineAdoptCommand=z.infer<typeof OutlineAdoptCommandSchema>;
export const OutlineRejectCommandSchema=WorkbenchExpectationSchema.extend({reason:WorkbenchRejectSchema.shape.reason});
export type OutlineRejectCommand=z.infer<typeof OutlineRejectCommandSchema>;

/** Complete receipt evidence remains private; clients follow bounded message pages from these exact counts. */
export const OutlineReceiptSchema=z.strictObject({
  contractVersion:z.literal(1),projectKey:ordinaryId,candidateId:stableId,kind,requestId:ordinaryId,status:WorkbenchActionReceiptSchema.shape.status,
  snapshotRevision:revision,writeVersion:revision,issueCount:messageCount,warningCount:messageCount,
  adoption:WorkbenchActionReceiptSchema.shape.adoption,rejection:WorkbenchActionReceiptSchema.shape.rejection,
}).superRefine((value,context)=>{
  if(value.adoption&&value.adoption.change_set_id!==value.candidateId)context.addIssue({code:'custom',message:'Outline adoption acknowledgement must match its candidate'});
});
export type OutlineReceipt=z.infer<typeof OutlineReceiptSchema>;
export const OutlineReceiptQuerySchema=z.strictObject({kind,requestId:ordinaryId,section,cursor:cursor.optional(),limit:limit.optional()});
export type OutlineReceiptQuery=z.infer<typeof OutlineReceiptQuerySchema>;
export const OutlineReceiptPageSchema=z.strictObject({contractVersion:z.literal(1),projectKey:ordinaryId,candidateId:stableId,kind,requestId:ordinaryId,section,total:messageCount,items:z.array(WorkbenchIssueSchema).max(50),nextCursor:cursor.nullable()});
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

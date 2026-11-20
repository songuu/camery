import {z} from 'zod';
import {StableId} from './schema';
import {WorkbenchActionReceiptSchema,WorkbenchIssueSchema} from './workbench';

const ordinaryId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const stableId=StableId.refine(value=>value.length===26);
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision=integer.min(1);
const messageCount=integer.max(131072);
const cursor=z.string().min(1).max(4096);
// HTTP query strings are decimal selectors; coercion must not authorize null or boolean positions.
const limit=z.union([z.number(),z.string().regex(/^[1-9][0-9]?$(?![\s\S])/).transform(Number)]).pipe(z.number().int().min(1).max(50));
const kind=z.enum(['preparation','decision']);
const section=z.enum(['issues','warnings']);

/** Complete source evidence stays private; exact counts lead consumers through bounded message pages. */
export const CandidateReceiptSchema=z.strictObject({
  contractVersion:z.literal(1),projectKey:ordinaryId,candidateId:stableId,kind,requestId:ordinaryId,status:WorkbenchActionReceiptSchema.shape.status,
  snapshotRevision:revision,writeVersion:revision,issueCount:messageCount,warningCount:messageCount,
  adoption:WorkbenchActionReceiptSchema.shape.adoption,rejection:WorkbenchActionReceiptSchema.shape.rejection,
}).superRefine((value,context)=>{
  if(value.adoption&&value.adoption.change_set_id!==value.candidateId)context.addIssue({code:'custom',message:'Adoption acknowledgement must match its candidate'});
});
export type CandidateReceipt=z.infer<typeof CandidateReceiptSchema>;
export const CandidateReceiptQuerySchema=z.strictObject({kind,requestId:ordinaryId,section,cursor:cursor.optional(),limit:limit.optional()});
export type CandidateReceiptQuery=z.infer<typeof CandidateReceiptQuerySchema>;
export const CandidateReceiptPageSchema=z.strictObject({contractVersion:z.literal(1),projectKey:ordinaryId,candidateId:stableId,kind,requestId:ordinaryId,section,total:messageCount,items:z.array(WorkbenchIssueSchema).max(50),nextCursor:cursor.nullable()});
export type CandidateReceiptPage=z.infer<typeof CandidateReceiptPageSchema>;

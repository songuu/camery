import {z} from 'zod';
import {StableId} from './schema';
import {WorkbenchActionReceiptSchema,WorkbenchExpectationSchema,WorkbenchRejectSchema} from './workbench';
import {CandidateReceiptSchema} from './candidate-receipts';

const ordinaryId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const stableId=StableId.refine(value=>value.length===26);
const hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision=integer.min(1);

/** The authenticated source host resolves the complete episode mapping from these immutable pins. */
export const ScreenplayPrepareCommandSchema=WorkbenchExpectationSchema.extend({applicationId:ordinaryId,sourceCandidateId:ordinaryId,preparationDigest:hash,reviewDigest:hash});
export type ScreenplayPrepareCommand=z.infer<typeof ScreenplayPrepareCommandSchema>;
export const ScreenplayAdoptCommandSchema=WorkbenchExpectationSchema;
export type ScreenplayAdoptCommand=z.infer<typeof ScreenplayAdoptCommandSchema>;
export const ScreenplayRejectCommandSchema=WorkbenchExpectationSchema.extend({reason:WorkbenchRejectSchema.shape.reason});
export type ScreenplayRejectCommand=z.infer<typeof ScreenplayRejectCommandSchema>;

export const ScreenplayCandidateSchema=z.strictObject({
  contractVersion:z.literal(1),projectKey:ordinaryId,candidateId:stableId,applicationId:ordinaryId.nullable(),sourceCandidateId:ordinaryId,episodeId:stableId,authorId:stableId,
  status:z.enum(['prepared',...WorkbenchActionReceiptSchema.shape.status.options]),snapshotRevision:revision,writeVersion:revision,baseRevision:revision,
  operationCount:integer.max(18560),sourceState:z.enum(['current','stale','unavailable']),canReview:z.boolean(),canAdopt:z.boolean(),canReject:z.boolean(),
  scope:z.strictObject({kind:z.literal('episode'),id:stableId}),blockingReasons:z.array(z.string().max(128)).max(32),preparation:CandidateReceiptSchema.nullable(),
}).superRefine((value,context)=>{
  if(value.scope.id!==value.episodeId)context.addIssue({code:'custom',message:'Screenplay scope must match its complete episode'});
  if((value.canAdopt||value.canReject)&&!value.canReview)context.addIssue({code:'custom',message:'Screenplay decisions require review permission'});
  if(value.canAdopt&&(value.status!=='candidate'||value.sourceState!=='current'))context.addIssue({code:'custom',message:'Screenplay adoption requires a current source candidate'});
  if(value.canReject&&value.status!=='candidate')context.addIssue({code:'custom',message:'Screenplay rejection requires candidate status'});
  const receipt=value.preparation;
  if(receipt&&(receipt.projectKey!==value.projectKey||receipt.candidateId!==value.candidateId||receipt.requestId!==value.applicationId||receipt.kind!=='preparation'))context.addIssue({code:'custom',message:'Screenplay preparation acknowledgement must match its candidate and application'});
});
export type ScreenplayCandidate=z.infer<typeof ScreenplayCandidateSchema>;

/** A compact projection of verified native proofs; readiness does not acknowledge a human handoff. */
export const ScreenplayHandoffSchema=z.strictObject({
  contractVersion:z.literal(1),projectKey:ordinaryId,candidateId:stableId,episodeId:stableId,state:z.enum(['ledger_pending','handoff_ready']),
  script:z.strictObject({changeId:stableId,digest:hash,fromRevision:revision,toRevision:revision}),
  ledger:z.strictObject({changeId:stableId,proofDigest:hash,snapshot:z.strictObject({id:stableId,version:revision}),adoptedRevision:revision}).nullable(),
  lineCount:integer.max(8192),warningCount:integer.max(65536),
}).superRefine((value,context)=>{
  if(value.script.changeId!==value.candidateId)context.addIssue({code:'custom',message:'Screenplay handoff script must match its candidate'});
  if(value.script.toRevision!==value.script.fromRevision+1)context.addIssue({code:'custom',message:'Screenplay handoff script revisions must be consecutive'});
  if((value.state==='handoff_ready')!==(value.ledger!==null))context.addIssue({code:'custom',message:'Screenplay handoff readiness requires exactly one ledger proof'});
  if(value.ledger&&value.ledger.adoptedRevision<value.script.toRevision)context.addIssue({code:'custom',message:'Screenplay handoff ledger adoption must not precede script adoption'});
});
export type ScreenplayHandoff=z.infer<typeof ScreenplayHandoffSchema>;

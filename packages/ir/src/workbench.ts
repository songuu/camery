import {z} from 'zod';
import {ChangeSet,StableId,SCHEMA_VERSION,LEGACY_SCHEMA_VERSION} from './schema';

const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision=integer.min(1);
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const text=(max:number)=>z.string().min(1).max(max).refine(value=>value.trim().length>0&&value.isWellFormed()&&!value.includes('\0'));
export const WorkbenchScopeSchema=z.strictObject({kind:z.enum(['project','episode','scene']),id:StableId});
export const WorkbenchExpectationSchema=z.strictObject({expectedSnapshotRevision:revision,expectedWriteVersion:revision});
export const WorkbenchIssueSchema=z.strictObject({code:text(128),where:z.string().max(2048),message:z.string().max(4096)});
export const WorkbenchActionReceiptSchema=z.strictObject({version:z.literal(1),changeId:StableId,status:z.enum(['candidate','adopted','rejected','conflicted','unchanged']),snapshotRevision:revision,writeVersion:revision,
  issues:z.array(WorkbenchIssueSchema).max(500),warnings:z.array(WorkbenchIssueSchema).max(500),
  adoption:z.strictObject({change_set_id:StableId,actor_id:StableId,scope:WorkbenchScopeSchema,from_revision:revision,to_revision:revision,at:z.iso.datetime({precision:3})}).nullable(),
  rejection:z.strictObject({actor_id:StableId,reason:text(500),at:z.iso.datetime({precision:3})}).nullable(),
});
export type WorkbenchActionReceipt=z.infer<typeof WorkbenchActionReceiptSchema>;
export const WorkbenchStateSchema=z.strictObject({contractVersion:z.literal(1),projectKey:id,projectId:StableId,schemaVersion:z.enum([LEGACY_SCHEMA_VERSION,SCHEMA_VERSION]),snapshotRevision:revision,writeVersion:revision,
  actorId:StableId.nullable(),canWrite:z.boolean(),canReview:z.boolean(),nativePending:integer,counts:z.array(z.strictObject({collection:text(64),count:integer})).max(64),
});
export type WorkbenchState=z.infer<typeof WorkbenchStateSchema>;
const source=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('manual')}),z.strictObject({kind:z.literal('unmanaged')}),
  z.strictObject({kind:z.literal('development'),runId:id,state:z.enum(['current','stale','unavailable','unchecked'])}),
]);
export const WorkbenchCandidateSummarySchema=z.strictObject({contractVersion:z.literal(1),projectKey:id,candidateId:StableId,applicationId:id.nullable(),managed:z.boolean(),status:z.enum(['prepared','candidate','adopted','rejected','conflicted','unchanged']),
  authorId:StableId,authorKey:id.nullable(),createdAt:z.iso.datetime({precision:3}).nullable(),baseRevision:revision,source,
});
export type WorkbenchCandidateSummary=z.infer<typeof WorkbenchCandidateSummarySchema>;
export const WorkbenchDifferenceSchema=z.strictObject({collection:text(64),id:StableId,kind:z.enum(['add','replace','remove']),before:z.record(z.string(),z.unknown()).nullable(),after:z.record(z.string(),z.unknown()).nullable()});
export const WorkbenchCandidateDetailSchema=WorkbenchCandidateSummarySchema.extend({snapshotRevision:revision,writeVersion:revision,baseWriteVersion:revision.nullable(),scope:WorkbenchScopeSchema,
  differences:z.array(WorkbenchDifferenceSchema).max(500),issues:z.array(WorkbenchIssueSchema).max(500),warnings:z.array(WorkbenchIssueSchema).max(500),canAdopt:z.boolean(),canReject:z.boolean(),
  blockingReasons:z.array(text(128)).max(32),preparation:WorkbenchActionReceiptSchema.nullable(),
});
export type WorkbenchCandidateDetail=z.infer<typeof WorkbenchCandidateDetailSchema>;
export const WorkbenchCandidateListQuerySchema=z.strictObject({runId:id.optional(),cursor:z.string().min(1).max(4096).optional(),limit:z.coerce.number().int().min(1).max(50).optional()});
export const WorkbenchCandidatePageSchema=z.strictObject({contractVersion:z.literal(1),items:z.array(WorkbenchCandidateSummarySchema).max(50),nextCursor:z.string().max(4096).nullable()});
export type WorkbenchCandidatePage=z.infer<typeof WorkbenchCandidatePageSchema>;
export const DevelopmentCandidatePrepareSchema=WorkbenchExpectationSchema.extend({applicationId:id,runDigest:hash,briefDigest:hash,foundationReviewDigest:hash,episodesReviewDigest:hash});
export type DevelopmentCandidatePrepare=z.infer<typeof DevelopmentCandidatePrepareSchema>;
// Keep the domain reader compatible; browser commands have a smaller execution budget.
const commandChange=ChangeSet.refine(value=>value.status==='candidate'&&value.ops.length<=500,{message:'Expected at most 500 candidate operations'})
  .refine(value=>new TextEncoder().encode(JSON.stringify(value)).length<=524288,{message:'Candidate request exceeds 512 KiB'});
export const WorkbenchPreviewSchema=z.strictObject({change:commandChange,expectedSnapshotRevision:revision});
export const WorkbenchSubmitSchema=WorkbenchExpectationSchema.extend({applicationId:id,change:commandChange});
export const WorkbenchAdoptSchema=WorkbenchExpectationSchema.extend({scope:WorkbenchScopeSchema});
export const WorkbenchRejectSchema=WorkbenchExpectationSchema.extend({scope:WorkbenchScopeSchema,reason:text(500)});
export const WorkbenchUpgradeSchema=WorkbenchExpectationSchema.extend({applicationId:id});
export const WorkbenchPreviewResultSchema=z.strictObject({contractVersion:z.literal(1),status:z.enum(['candidate','rejected','conflicted']),snapshotRevision:revision,writeVersion:revision,differences:z.array(WorkbenchDifferenceSchema).max(500),issues:z.array(WorkbenchIssueSchema).max(500),warnings:z.array(WorkbenchIssueSchema).max(500)});
export type WorkbenchPreviewResult=z.infer<typeof WorkbenchPreviewResultSchema>;
export const workbenchEnvelope=<S extends z.ZodType>(data:S)=>z.strictObject({data,requestId:id});
export type WorkbenchAdoptInput=z.infer<typeof WorkbenchAdoptSchema>;
export type WorkbenchRejectInput=z.infer<typeof WorkbenchRejectSchema>;
export type WorkbenchUpgradeInput=z.infer<typeof WorkbenchUpgradeSchema>;
export type WorkbenchSubmitInput=z.infer<typeof WorkbenchSubmitSchema>;
export type WorkbenchPreviewInput=z.infer<typeof WorkbenchPreviewSchema>;

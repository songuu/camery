import {z} from 'zod';
import {ChangeSet,StableId,EditableCollection,SCHEMA_VERSION,OUTLINE_SCHEMA_VERSION,LEGACY_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION} from './schema';

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
export const WorkbenchStateSchema=z.strictObject({contractVersion:z.literal(1),projectKey:id,projectId:StableId,schemaVersion:z.enum([LEGACY_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION,OUTLINE_SCHEMA_VERSION,SCHEMA_VERSION]),snapshotRevision:revision,writeVersion:revision,
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

export const WorkbenchCollectionSchema=z.enum([...EditableCollection.options,'locks']);
export const WorkbenchObjectRefSchema=z.strictObject({collection:WorkbenchCollectionSchema,id:StableId,version:revision});
export type WorkbenchObjectRef=z.infer<typeof WorkbenchObjectRefSchema>;
export const WorkbenchReadQuerySchema=z.strictObject({episodeId:StableId.optional(),sceneId:StableId.optional(),renditionId:StableId.optional(),collection:WorkbenchCollectionSchema.optional(),
  expectedRevision:z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),cursor:z.string().min(1).max(4096).optional(),limit:z.coerce.number().int().min(1).max(200).optional()});
export type WorkbenchReadQuery=z.infer<typeof WorkbenchReadQuerySchema>;
export const WorkbenchObjectRowSchema=z.strictObject({ref:WorkbenchObjectRefSchema,role:z.enum(['owned','context']),value:z.record(z.string(),z.unknown())})
  .refine(row=>row.value['id']===row.ref.id&&row.value['version']===row.ref.version,{message:'Object value must match its revision reference'});
export const WorkbenchRelationSchema=z.strictObject({kind:z.enum(['ownership','reference','provenance','shot_take','continuity']),from:WorkbenchObjectRefSchema,to:WorkbenchObjectRefSchema,field:text(512),pin:z.enum(['explicit','snapshot']),currentVersion:revision,stale:z.boolean()});
export const WorkbenchSnapshotSchema=z.strictObject({contractVersion:z.literal(1),projectKey:id,projectId:StableId,schemaVersion:z.enum([LEGACY_SCHEMA_VERSION,DEVELOPMENT_SCHEMA_VERSION,OUTLINE_SCHEMA_VERSION,SCHEMA_VERSION]),snapshotRevision:revision,writeVersion:revision,
  scope:WorkbenchScopeSchema,renditionId:StableId.nullable(),nextCursor:z.string().max(4096).nullable(),counts:z.array(z.strictObject({collection:WorkbenchCollectionSchema,count:integer})).max(64),
  capabilities:z.strictObject({canWrite:z.boolean(),canReview:z.boolean(),canReadMedia:z.literal(false)}),
  rows:z.array(WorkbenchObjectRowSchema).max(200),relations:z.array(WorkbenchRelationSchema).max(10000),
  lineage:z.array(z.strictObject({from_ids:z.array(StableId).min(1),to_ids:z.array(StableId).min(1),revision})).max(65536),
  // Existing IR lock text is unbounded; the complete response byte budget limits transport size.
  locks:z.array(z.strictObject({ref:WorkbenchObjectRefSchema,target:StableId,fields:z.array(z.string().min(1)).max(65536),ownerId:StableId,reason:z.string().min(1)})).max(65536),
});
export type WorkbenchSnapshot=z.infer<typeof WorkbenchSnapshotSchema>;
export const WorkbenchHistoryQuerySchema=z.strictObject({expectedRevision:z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),cursor:z.string().min(1).max(4096).optional(),limit:z.coerce.number().int().min(1).max(50).optional()});
export type WorkbenchHistoryQuery=z.infer<typeof WorkbenchHistoryQuerySchema>;
export const WorkbenchObjectHistorySchema=z.strictObject({contractVersion:z.literal(1),projectKey:id,projectId:StableId,collection:WorkbenchCollectionSchema,objectId:StableId,snapshotRevision:revision,writeVersion:revision,nextCursor:z.string().max(4096).nullable(),
  items:z.array(z.strictObject({ref:WorkbenchObjectRefSchema,parentVersion:revision.nullable(),snapshotRevision:revision,changeId:StableId.nullable(),deleted:z.boolean(),value:z.record(z.string(),z.unknown()).nullable()})
    .refine(row=>row.deleted===(row.value===null)&&(!row.value||row.value['id']===row.ref.id&&row.value['version']===row.ref.version),{message:'Historical value binding'})).max(50),
});
export type WorkbenchObjectHistory=z.infer<typeof WorkbenchObjectHistorySchema>;
export const WorkbenchReadyAssetQuerySchema=z.strictObject({expectedRevision:z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional()});

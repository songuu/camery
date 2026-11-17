import { z } from 'zod';
import { snapshotJson } from '@camery/methods/json';
import { Hash,Id,Integer,Text } from '../contracts.js';
import { OUTLINE_BYTES,OutlineOutputSchema,RuleThresholdsSchema } from './contracts.js';
import { AblationAssessmentSchema,OutlineBriefInputSchema,OutlineBriefSchema,OutlineSourceDescriptorSchema,OutlineSourceReferenceSchema,OutlineWaiverSchema,OUTLINE_ENVELOPE_BYTES,OUTLINE_SOURCE_BYTES } from './generation-contracts.js';

export const OUTLINE_HTTP_SMALL_BYTES=65536;
export const OUTLINE_HTTP_CONFIRM_BYTES=OUTLINE_ENVELOPE_BYTES;
export const OUTLINE_HTTP_DETAIL_BYTES=3*OUTLINE_ENVELOPE_BYTES;

/** Snapshot before schema parsing: public transport parsing must never execute accessors or traverse an unbounded body. */
export function boundedOutlineSchema<T>(schema:z.ZodType<T>,maxBytes=OUTLINE_HTTP_SMALL_BYTES):z.ZodType<T>{
  return z.unknown().transform((value,ctx)=>{
    try{return snapshotJson(value,maxBytes);}
    catch{ctx.addIssue({code:'custom',message:'Outline transport data limit'});return z.NEVER;}
  }).pipe(schema);
}

const Time=z.iso.datetime({precision:3}),Cursor=z.string().min(1).max(512),ReviewState=z.enum(['reviewed','rejected']);
const Budget=z.strictObject({currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),tokens:Integer,costMicros:Integer});
const BriefPublic=OutlineBriefSchema.omit({tenantId:true,projectId:true});
const Selection=z.discriminatedUnion('kind',[
  OutlineSourceDescriptorSchema.options[0].omit({tenantId:true,projectId:true}),
  OutlineSourceDescriptorSchema.options[1].omit({tenantId:true,projectId:true}),
]);
const Output=boundedOutlineSchema(OutlineOutputSchema,OUTLINE_BYTES);
const Ablations=z.array(AblationAssessmentSchema).max(2),Waivers=z.array(OutlineWaiverSchema).max(400);

export const OutlineCapabilitiesSchema=boundedOutlineSchema(z.strictObject({canStart:z.boolean(),modelLabel:Text(200).nullable(),budget:Budget.nullable(),defaultEpisodeCount:z.literal(10),formalAdoption:z.boolean().default(false)}));
export type OutlineCapabilities=z.infer<typeof OutlineCapabilitiesSchema>;
export const OutlineBriefSchemaPublic=boundedOutlineSchema(BriefPublic);
export type OutlineBriefPublic=z.infer<typeof OutlineBriefSchemaPublic>;
export const OutlineBriefWriteSchema=boundedOutlineSchema(OutlineBriefInputSchema.omit({tenantId:true,projectId:true,revision:true}).extend({expectedRevision:Integer.max(Number.MAX_SAFE_INTEGER-1)}));
export type OutlineBriefWrite=z.infer<typeof OutlineBriefWriteSchema>;
export const OutlineBriefViewSchema=boundedOutlineSchema(z.strictObject({brief:BriefPublic,actorId:Id,createdAt:Time}));
export type OutlineBriefView=z.infer<typeof OutlineBriefViewSchema>;
const BriefSummary=z.strictObject({briefId:Id,revision:Integer.min(1),notesPreview:z.string().min(1).max(240).refine(value=>value.isWellFormed()&&!value.includes('\0')),actorId:Id,createdAt:Time});
export const OutlineBriefSummarySchema=boundedOutlineSchema(BriefSummary);
export type OutlineBriefSummary=z.infer<typeof OutlineBriefSummarySchema>;
export const OutlineBriefListSchema=boundedOutlineSchema(z.strictObject({items:z.array(BriefSummary).max(20),nextCursor:Cursor.nullable()}));
export type OutlineBriefList=z.infer<typeof OutlineBriefListSchema>;
export const OutlineBriefListQuerySchema=boundedOutlineSchema(z.strictObject({cursor:Cursor.optional()}));
export type OutlineBriefListQuery=z.infer<typeof OutlineBriefListQuerySchema>;
export const OutlineReadBriefQuerySchema=boundedOutlineSchema(z.strictObject({revision:z.string().regex(/^[1-9]\d*$(?![\s\S])/).transform(Number).pipe(Integer.min(1)).optional()}));
export type OutlineReadBriefQuery=z.infer<typeof OutlineReadBriefQuerySchema>;

export const OutlineSourceSelectionSchema=boundedOutlineSchema(Selection);
export type OutlineSourceSelection=z.infer<typeof OutlineSourceSelectionSchema>;
const SourceSummary=z.strictObject({source:Selection,createdAt:Time});
export const OutlineSourceSummarySchema=boundedOutlineSchema(SourceSummary);
export type OutlineSourceSummary=z.infer<typeof OutlineSourceSummarySchema>;
export const OutlineSourceListSchema=boundedOutlineSchema(z.strictObject({items:z.array(SourceSummary).max(20),nextCursor:Cursor.nullable()}));
export type OutlineSourceList=z.infer<typeof OutlineSourceListSchema>;
export const OutlineSourceListQuerySchema=boundedOutlineSchema(z.strictObject({kind:z.enum(['development','bible']),cursor:Cursor.optional()}));
export type OutlineSourceListQuery=z.infer<typeof OutlineSourceListQuerySchema>;
export const OutlineSourceViewSchema=boundedOutlineSchema(z.strictObject({version:z.literal(1),descriptor:Selection,material:z.json(),references:z.array(OutlineSourceReferenceSchema).min(1).max(2048),digest:Hash}),OUTLINE_SOURCE_BYTES);
export type OutlineSourceView=z.infer<typeof OutlineSourceViewSchema>;
export const OutlineStartSchema=boundedOutlineSchema(z.strictObject({runId:Id,briefId:Id,expectedRevision:Integer.min(1),expectedBriefDigest:Hash,source:Selection}));
export type OutlineStart=z.infer<typeof OutlineStartSchema>;

const Summary=z.strictObject({runId:Id,runDigest:Hash,briefId:Id,briefRevision:Integer.min(1),createdAt:Time,candidateDigest:Hash.nullable(),reviewStatus:ReviewState.nullable()});
export const OutlineRunSummarySchema=boundedOutlineSchema(Summary);
export type OutlineRunSummary=z.infer<typeof OutlineRunSummarySchema>;
export const OutlineRunListSchema=boundedOutlineSchema(z.strictObject({items:z.array(Summary).max(20),nextCursor:Cursor.nullable()}));
export type OutlineRunList=z.infer<typeof OutlineRunListSchema>;
export const OutlineListQuerySchema=boundedOutlineSchema(z.strictObject({cursor:Cursor.optional(),briefId:Id.optional()}));
export type OutlineListQuery=z.infer<typeof OutlineListQuerySchema>;
const Task=z.strictObject({status:z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled']),resultState:z.enum(['candidate','blocked']).nullable(),reason:z.string().regex(/^[A-Z_]{1,64}$(?![\s\S])/).nullable()});
export const OutlineTaskViewSchema=boundedOutlineSchema(Task);
export type OutlineTaskView=z.infer<typeof OutlineTaskViewSchema>;
const Status=Summary.extend({sourceChanged:z.boolean(),state:z.enum(['not_dispatched','queued','running','waiting','reconciling','blocked','failed','cancelled','awaiting_review','reviewed','rejected','stale']),task:Task.nullable()});
export const OutlineStatusSchema=boundedOutlineSchema(Status);
export type OutlineStatus=z.infer<typeof OutlineStatusSchema>;

const Issue=z.strictObject({id:Text(300),code:z.enum(['REPEATED_CLIFFHANGER','LOW_EMOTION','LATE_OPENING_HOOK','LATE_STAKES','ABLATION_REVIEW']),path:Text(300),episodeNumbers:z.array(Integer.min(1).max(100)).max(100),detail:Text(2000)});
const Report=z.strictObject({version:z.literal(1),kind:z.literal('craft_review'),ruleVersion:z.literal('outline-craft-v1'),thresholds:RuleThresholdsSchema,emotionCurve:z.array(z.strictObject({episodeNumber:Integer.min(1).max(100),intensity:z.number().min(0).max(10)})).max(100),issues:z.array(Issue).max(400)});
// Reports are independently bounded rather than forced through the small metadata/request envelope.
export const OutlineCraftReportSchema=boundedOutlineSchema(Report,OUTLINE_ENVELOPE_BYTES);
export type OutlineCraftReportView=z.infer<typeof OutlineCraftReportSchema>;
const ReviewMeta={digest:Hash,candidateDigest:Hash,actorId:Id,at:Time};
const Reviewed=z.strictObject({...ReviewMeta,status:z.literal('reviewed'),output:Output,report:OutlineCraftReportSchema,ablations:Ablations,waivers:Waivers});
const Rejected=z.strictObject({...ReviewMeta,status:z.literal('rejected'),reason:Text(1000)});
export const OutlineRunViewSchema=boundedOutlineSchema(Status.extend({brief:BriefPublic,source:OutlineSourceViewSchema,candidate:z.strictObject({digest:Hash,output:Output,report:OutlineCraftReportSchema}).nullable(),review:z.discriminatedUnion('status',[Reviewed,Rejected]).nullable()}),OUTLINE_HTTP_DETAIL_BYTES);
export type OutlineRunView=z.infer<typeof OutlineRunViewSchema>;
export const OutlineConfirmSchema=boundedOutlineSchema(z.strictObject({candidateDigest:Hash,output:Output,ablations:Ablations,waivers:Waivers}),OUTLINE_HTTP_CONFIRM_BYTES);
export type OutlineConfirm=z.infer<typeof OutlineConfirmSchema>;
export const OutlineRejectSchema=boundedOutlineSchema(z.strictObject({reason:Text(1000)}));
export type OutlineReject=z.infer<typeof OutlineRejectSchema>;

import {z} from 'zod';
import {snapshotJson} from '@camery/methods/json';
import {BriefInputSchema,DevelopmentBriefSchema,FoundationOutputSchema,EpisodeOutputSchema,Hash,Id,Integer,Stage,Text} from './contracts.js';
// Shared browser/server transport: no execution profile, provider receipt, credential or approval predicate.
const Time=z.iso.datetime({precision:3});
const ReviewState=z.enum(['reviewed','rejected']);
const Budget=z.strictObject({currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),tokens:Integer,costMicros:Integer});
export const DevelopmentCapabilitiesSchema=z.strictObject({canStart:z.boolean(),modelLabel:Text(200).nullable(),budget:Budget.nullable(),defaultEpisodeCount:z.literal(10)});
export type DevelopmentCapabilities=z.infer<typeof DevelopmentCapabilitiesSchema>;
export const DevelopmentBriefWriteSchema=BriefInputSchema.omit({tenantId:true,projectId:true,revision:true}).extend({expectedRevision:Integer.max(Number.MAX_SAFE_INTEGER-1)});
export type DevelopmentBriefWrite=z.infer<typeof DevelopmentBriefWriteSchema>;
export const DevelopmentBriefSchemaPublic=DevelopmentBriefSchema.omit({tenantId:true,projectId:true});
export const DevelopmentBriefViewSchema=z.strictObject({brief:DevelopmentBriefSchemaPublic,actorId:Id,createdAt:Time});
export type DevelopmentBriefView=z.infer<typeof DevelopmentBriefViewSchema>;
export const DevelopmentBriefListQuerySchema=z.strictObject({cursor:z.string().min(1).max(512).optional()});
// A prefix can be whitespace even when the complete saved idea contains meaningful text.
export const DevelopmentBriefSummarySchema=z.strictObject({briefId:Id,revision:Integer.min(1),ideaPreview:z.string().min(1).max(240).refine(value=>value.isWellFormed()&&!value.includes('\0')),actorId:Id,createdAt:Time});
export type DevelopmentBriefSummary=z.infer<typeof DevelopmentBriefSummarySchema>;
export const DevelopmentBriefListSchema=z.strictObject({items:z.array(DevelopmentBriefSummarySchema).max(20),nextCursor:z.string().min(1).max(512).nullable()});
export type DevelopmentBriefList=z.infer<typeof DevelopmentBriefListSchema>;
export const DevelopmentStartSchema=z.strictObject({runId:Id,briefId:Id,expectedRevision:Integer.min(1),expectedBriefDigest:Hash});
export type DevelopmentStart=z.infer<typeof DevelopmentStartSchema>;
export const DevelopmentListQuerySchema=z.strictObject({cursor:z.string().min(1).max(512).optional(),briefId:Id.optional()});
export const DevelopmentReadBriefQuerySchema=z.strictObject({revision:z.string().regex(/^[1-9]\d*$(?![\s\S])/).transform(Number).pipe(Integer.min(1)).optional()});
export const DevelopmentRunSummarySchema=z.strictObject({runId:Id,briefId:Id,briefRevision:Integer.min(1),createdAt:Time,sourceChanged:z.boolean(),
  foundationCandidateDigest:Hash.nullable(),foundationReviewStatus:ReviewState.nullable(),episodesCandidateDigest:Hash.nullable(),episodesReviewStatus:ReviewState.nullable()});
export type DevelopmentRunSummary=z.infer<typeof DevelopmentRunSummarySchema>;
export const DevelopmentRunListSchema=z.strictObject({items:z.array(DevelopmentRunSummarySchema).max(20),nextCursor:z.string().min(1).max(512).nullable()});
export type DevelopmentRunList=z.infer<typeof DevelopmentRunListSchema>;
export const DevelopmentTaskViewSchema=z.strictObject({stage:Stage,status:z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled']),
  resultState:z.enum(['candidate','blocked']).nullable(),reason:z.string().regex(/^[A-Z_]{1,64}$(?![\s\S])/).nullable()});
export type DevelopmentTaskView=z.infer<typeof DevelopmentTaskViewSchema>;
export const DevelopmentStatusSchema=DevelopmentRunSummarySchema.extend({stage:Stage,
  state:z.enum(['queued','running','waiting','reconciling','blocked','failed','cancelled','awaiting_review','reviewed','rejected','stale']),task:DevelopmentTaskViewSchema.nullable()});
export type DevelopmentStatus=z.infer<typeof DevelopmentStatusSchema>;
const ReviewMeta={digest:Hash,actorId:Id,at:Time};
const Rejected=z.strictObject({...ReviewMeta,status:z.literal('rejected'),reason:Text(1000)});
const FoundationReview=z.union([z.strictObject({...ReviewMeta,status:z.literal('reviewed'),output:FoundationOutputSchema}),Rejected]);
const EpisodesReview=z.union([z.strictObject({...ReviewMeta,status:z.literal('reviewed'),output:EpisodeOutputSchema}),Rejected]);
export const DevelopmentRunViewSchema=DevelopmentStatusSchema.extend({brief:DevelopmentBriefSchemaPublic,budget:Budget,
  foundation:z.strictObject({candidate:z.strictObject({digest:Hash,output:FoundationOutputSchema}).nullable(),review:FoundationReview.nullable()}),
  episodes:z.strictObject({candidate:z.strictObject({digest:Hash,output:EpisodeOutputSchema}).nullable(),review:EpisodesReview.nullable()})});
export type DevelopmentRunView=z.infer<typeof DevelopmentRunViewSchema>;
export const DevelopmentFoundationConfirmSchema=z.strictObject({candidateDigest:Hash,output:FoundationOutputSchema});
export const DevelopmentEpisodesConfirmSchema=z.strictObject({candidateDigest:Hash,output:EpisodeOutputSchema});
export type DevelopmentFoundationConfirm=z.infer<typeof DevelopmentFoundationConfirmSchema>;
export type DevelopmentEpisodesConfirm=z.infer<typeof DevelopmentEpisodesConfirmSchema>;
export const DevelopmentRejectSchema=z.strictObject({reason:Text(1000)});
/** Bound complete logical JSON before a schema copies arrays or reads properties. */
export function boundedDevelopmentSchema<T>(schema:z.ZodType<T>):z.ZodType<T>{
  return z.unknown().transform((value,ctx)=>{try{return snapshotJson(value,524288);}catch{ctx.addIssue({code:'custom',message:'Development transport data limit'});return z.NEVER;}}).pipe(schema);
}

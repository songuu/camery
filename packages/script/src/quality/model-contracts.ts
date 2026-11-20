import {z} from 'zod';
import {Id,Hash,Integer,Text} from '../contracts.js';
import {QualityPhaseSchema,QualityEvidenceSchema} from './contracts.js';
export const QUALITY_REVIEW_INPUT_BYTES=2097152,QUALITY_REVIEW_OUTPUT_BYTES=524288,QUALITY_REVIEW_PAIRS=128,QUALITY_REVIEW_UNITS_PER_BATCH=8,QUALITY_REVIEW_UNIT_TARGET_BYTES=131072,QUALITY_REVIEW_MAX_BATCHES=8192;
const pointer=z.string().max(1000).refine(value=>(value===''||value.startsWith('/'))&&!/~(?![01])/u.test(value)&&value.isWellFormed()&&!value.includes('\0'));
export const QualityReviewTopicSchema=z.strictObject({id:Id,phase:QualityPhaseSchema,label:Text(120),recognition:Text(1500),remedy:Text(1500),severity:z.enum(['minor','major'])});
export type QualityReviewTopic=z.infer<typeof QualityReviewTopicSchema>;
/** Content is a captured subtree or an explicit original-string range. It is never executed or substituted for current-source authority. */
export const QualityReviewUnitSchema=z.strictObject({id:Id,kind:z.enum(['document','subtree','string_slice']),path:pointer,start:Integer.nullable(),end:Integer.nullable(),content:z.json(),digest:Hash});
export type QualityReviewUnit=z.infer<typeof QualityReviewUnitSchema>;
export const QualityReviewCommonSchema=z.strictObject({path:pointer,content:z.json()});
export const QualityReviewBatchSchema=z.strictObject({version:z.literal(1),phase:QualityPhaseSchema,index:Integer.max(QUALITY_REVIEW_MAX_BATCHES-1),common:z.array(QualityReviewCommonSchema).max(16),units:z.array(QualityReviewUnitSchema).min(1).max(QUALITY_REVIEW_UNITS_PER_BATCH)});
export type QualityReviewBatch=z.infer<typeof QualityReviewBatchSchema>;
/** Wire offsets use 0/0 when quote=null; the semantic validator enforces that sentinel and findings convert it to null offsets. */
export const QualityModelAssessmentSchema=z.strictObject({unitId:Id,topicId:Id,verdict:z.enum(['flag','clear','uncertain']),reason:Text(200),severity:z.enum(['minor','major','critical']).nullable(),problem:Text(1000).nullable(),audienceImpact:Text(1000).nullable(),suggestion:Text(1000).nullable(),ripple:z.array(Text(300)).max(4),evidence:z.array(QualityEvidenceSchema.extend({start:Integer,end:Integer,quote:Text(300).nullable()})).max(4)});
export type QualityModelAssessment=z.infer<typeof QualityModelAssessmentSchema>;
export const QualityModelOutputSchema=z.strictObject({version:z.literal(1),assessments:z.array(QualityModelAssessmentSchema).min(1).max(QUALITY_REVIEW_PAIRS)});
export type QualityModelOutput=z.infer<typeof QualityModelOutputSchema>;

import { z } from 'zod';
import type { MethodPin,ModelReceipt } from '@camery/methods';
import type { Json } from '@camery/model-modes';
import { Hash,Id,Integer,Text } from '../contracts.js';
import { GenreId,OutlineContextSchema,RuleThresholdsSchema } from './contracts.js';
import type { OutlineOutput } from './contracts.js';
import type { OutlineCraftReport } from './outline.js';

const BriefFields={tenantId:Id,projectId:Id,briefId:Id,revision:Integer.min(1),notes:Text(2000),
  ...OutlineContextSchema.omit({sourceRefIds:true}).shape};
export const OutlineBriefInputSchema=z.strictObject({...BriefFields,thresholds:RuleThresholdsSchema.optional()});
export const GenreProfilePinSchema=z.strictObject({id:GenreId,version:z.literal(1),digest:Hash});
export const OutlineBriefSchema=z.strictObject({...BriefFields,version:z.literal(1),thresholds:RuleThresholdsSchema,
  profiles:z.array(GenreProfilePinSchema).min(1).max(3),digest:Hash});
export type OutlineBrief=z.infer<typeof OutlineBriefSchema>;
const SourceKey={tenantId:Id,projectId:Id,runId:Id,runDigest:Hash};
export const OutlineSourceDescriptorSchema=z.discriminatedUnion('kind',[
  z.strictObject({...SourceKey,kind:z.literal('development'),briefDigest:Hash,foundationReviewDigest:Hash,episodesReviewDigest:Hash}),
  z.strictObject({...SourceKey,kind:z.literal('bible'),documentId:Id,revision:Integer.min(1),sourceDigest:Hash,reviewDigest:Hash}),
]);
export type OutlineSourceDescriptor=z.infer<typeof OutlineSourceDescriptorSchema>;
export const OutlineSourceReferenceSchema=z.strictObject({id:Id,path:Text(256)});
export interface OutlineSourceSnapshot {
  readonly version:1;readonly descriptor:OutlineSourceDescriptor;readonly material:Json;
  readonly references:readonly z.infer<typeof OutlineSourceReferenceSchema>[];readonly digest:string;
}
export interface OutlineCandidate {
  readonly version:1;readonly status:'candidate';readonly brief:OutlineBrief;readonly source:OutlineSourceSnapshot;
  readonly method:MethodPin;readonly output:OutlineOutput;readonly model:ModelReceipt;readonly digest:string;
}
export const AblationAssessmentSchema=z.strictObject({genre:GenreId,judgment:z.enum(['participates','label_only']),reason:Text(1000)});
export const OutlineWaiverSchema=z.strictObject({issueId:Text(300),reason:Text(1000)});
export interface OutlineReviewHost {
  readonly tenantId:string;readonly projectId:string;readonly actor:{readonly kind:'human';readonly id:string};readonly at:string;
  readonly authorize:(request:{readonly actorId:string;readonly brief:OutlineBrief;readonly action:'outline:review'|'outline:reject'})=>boolean;
}
export interface ReviewedOutline {
  readonly version:1;readonly status:'reviewed';readonly brief:OutlineBrief;readonly source:OutlineSourceSnapshot;
  readonly candidateDigest:string;readonly output:OutlineOutput;readonly report:OutlineCraftReport;
  readonly ablations:readonly z.infer<typeof AblationAssessmentSchema>[];readonly waivers:readonly z.infer<typeof OutlineWaiverSchema>[];
  readonly actorId:string;readonly at:string;readonly digest:string;
}
export interface RejectedOutline {
  readonly version:1;readonly status:'rejected';readonly brief:OutlineBrief;readonly source:OutlineSourceSnapshot;
  readonly candidateDigest:string;readonly reason:string;readonly actorId:string;readonly at:string;readonly digest:string;
}
export const OUTLINE_SOURCE_BYTES=524288;
export const OUTLINE_ENVELOPE_BYTES=2097152;

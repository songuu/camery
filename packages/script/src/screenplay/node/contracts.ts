import {z} from 'zod';
import {Id,Hash,Text} from '../../contracts.js';
import {ScreenplayDraftSchema,ScreenplayReportSchema,ScreenplayTimingSchema,ScreenplayLineBookSchema,ScreenplayContinuityPreviewSchema} from '../contracts.js';
export const ScreenplayScopeSchema=z.strictObject({tenantId:Id,projectId:Id});
export const ScreenplayKeySchema=ScreenplayScopeSchema.extend({candidateId:Id});
export type ScreenplayKey=z.infer<typeof ScreenplayKeySchema>;
export const ScreenplayCandidateSchema=z.strictObject({version:z.literal(1),status:z.literal('candidate'),scope:ScreenplayScopeSchema,contextDigest:Hash,draft:ScreenplayDraftSchema,
  report:ScreenplayReportSchema,issues:ScreenplayReportSchema.shape.issues,timing:ScreenplayTimingSchema,lineBook:ScreenplayLineBookSchema,continuity:ScreenplayContinuityPreviewSchema,digest:Hash});
export type ScreenplayCandidate=z.infer<typeof ScreenplayCandidateSchema>;
export const ScreenplayWaiverSchema=z.strictObject({issueId:Text(3000),reason:Text(1000)});
export const ScreenplayReviewDecisionSchema=z.strictObject({candidateDigest:Hash,draft:ScreenplayDraftSchema,waivers:z.array(ScreenplayWaiverSchema).max(65536)});
export const ScreenplayReviewSchema=z.strictObject({version:z.literal(1),status:z.literal('reviewed'),candidateDigest:Hash,output:ScreenplayCandidateSchema,waivers:z.array(ScreenplayWaiverSchema).max(65536),actorId:Id,at:z.iso.datetime({precision:3}),digest:Hash});
export type ScreenplayReview=z.infer<typeof ScreenplayReviewSchema>;
export type ScreenplayAction='screenplay:read'|'screenplay:prepare'|'screenplay:review'|'screenplay:finalize';
/** Deployment authority only; no HTTP authentication DTO is added by this domain workflow. */
export interface ScreenplayHost{readonly actor:{readonly kind:'human';readonly id:string};readonly scope:{readonly tenantId:string;readonly projectId:string};readonly at:string;readonly authorize:(request:{readonly action:ScreenplayAction;readonly scope:{readonly tenantId:string;readonly projectId:string}})=>boolean}

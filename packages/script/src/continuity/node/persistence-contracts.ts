import {z} from 'zod';
import type {PoolClient} from 'pg';
import {StableId} from '@camery/ir';
import {Id,Hash,Integer,Text} from '../../contracts.js';
import {ContinuityCandidateSchema,ContinuityDraftSchema,ContinuityIssueSchema,ContinuityLedgerSchema} from '../contracts.js';

export const CONTINUITY_RECORD_BYTES=16_777_216;
export const CONTINUITY_PREVIOUS_BYTES=4_194_304;
export const ContinuityScopeSchema=z.strictObject({tenantId:Id,projectId:Id});
export const ContinuityKeySchema=ContinuityScopeSchema.extend({candidateId:Id});
export type ContinuityKey=z.infer<typeof ContinuityKeySchema>;
export const ContinuityTargetSchema=z.strictObject({tenantId:StableId,projectId:StableId});
export type ContinuityTarget=z.infer<typeof ContinuityTargetSchema>;
export const ContinuityWaiverSchema=z.strictObject({code:ContinuityIssueSchema.shape.code,path:Text(2048),reason:Text(1000)});
export const ContinuityReviewDecisionSchema=z.strictObject({candidateDigest:Hash,draft:ContinuityDraftSchema,waivers:z.array(ContinuityWaiverSchema).max(2048)});
export type ContinuityReviewDecision=z.infer<typeof ContinuityReviewDecisionSchema>;
export const ContinuityRejectDecisionSchema=z.strictObject({candidateDigest:Hash,reason:Text(1000)});
export type ContinuityRejectDecision=z.infer<typeof ContinuityRejectDecisionSchema>;
const audit={version:z.literal(1),candidateDigest:Hash,actorId:Id,at:z.iso.datetime({precision:3}),digest:Hash};
export const ContinuityReviewSchema=z.discriminatedUnion('status',[
  z.strictObject({...audit,status:z.literal('reviewed'),output:ContinuityCandidateSchema,waivers:z.array(ContinuityWaiverSchema).max(2048)}),
  z.strictObject({...audit,status:z.literal('rejected'),reason:Text(1000)}),
]);
export type ContinuityReview=z.infer<typeof ContinuityReviewSchema>;
export type ContinuityAction='continuity:read'|'continuity:prepare'|'continuity:review'|'continuity:reject';
/** This host is deployment authority, never an HTTP request DTO. */
export interface ContinuityReviewHost{readonly actor:{readonly kind:'human';readonly id:string};readonly scope:{readonly tenantId:string;readonly projectId:string};readonly at:string;readonly authorize:(request:{readonly action:ContinuityAction;readonly scope:{readonly tenantId:string;readonly projectId:string}})=>boolean}
export const ContinuityPreviousV1Schema=z.strictObject({version:z.literal(1),id:Id,digest:Hash,scope:ContinuityScopeSchema,target:ContinuityTargetSchema,
  snapshot:z.strictObject({id:StableId,version:Integer.min(1)}),changeId:StableId,adoptedRevision:Integer.min(1),ledger:ContinuityLedgerSchema});
export const ContinuityPreviousV2Schema=ContinuityPreviousV1Schema.extend({version:z.literal(2),origin:z.strictObject({reviewDigest:Hash,bindingDigest:Hash})});
export const ContinuityPreviousSchema=z.discriminatedUnion('version',[ContinuityPreviousV1Schema,ContinuityPreviousV2Schema]);
export type ContinuityPrevious=z.infer<typeof ContinuityPreviousSchema>;
/** Trusted adopted-ledger authority. episodeId names the required previous episode. No implementation means later episodes fail closed; no command may supply a previous ledger. */
export type ContinuityPredecessorResolver=(client:PoolClient,input:Readonly<{scope:z.infer<typeof ContinuityScopeSchema>;target:ContinuityTarget;episodeId:string}>)=>Promise<ContinuityPrevious|null>;
export const ContinuitySourceSchema=z.strictObject({version:z.literal(1),target:ContinuityTargetSchema,packageId:StableId,snapshotRevision:Integer.min(1),episodeId:StableId,packageDigest:Hash,contextDigest:Hash,previousDigest:Hash.nullable()});
export type ContinuitySource=z.infer<typeof ContinuitySourceSchema>;
export const ContinuityPreparationSchema=z.strictObject({version:z.literal(1),key:ContinuityKeySchema,source:ContinuitySourceSchema,previous:ContinuityPreviousSchema.nullable(),authorId:Id,createdAt:z.iso.datetime({precision:3}),commandDigest:Hash,candidate:ContinuityCandidateSchema,digest:Hash});
export type ContinuityPreparation=z.infer<typeof ContinuityPreparationSchema>;
export const ContinuityPrepareSchema=z.strictObject({key:ContinuityKeySchema,target:ContinuityTargetSchema,expectedSnapshotRevision:Integer.min(1),expectedPackageDigest:Hash,draft:ContinuityDraftSchema});
export type ContinuityPrepare=z.infer<typeof ContinuityPrepareSchema>;
export const ContinuitySourceSelectionSchema=z.strictObject({scope:ContinuityScopeSchema,target:ContinuityTargetSchema,episodeId:StableId});
export type ContinuitySourceSelection=z.infer<typeof ContinuitySourceSelectionSchema>;
export interface ContinuityProgress{readonly preparation:ContinuityPreparation;readonly review:ContinuityReview|null;readonly current:boolean}

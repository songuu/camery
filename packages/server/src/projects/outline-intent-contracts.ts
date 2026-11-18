import {z} from 'zod';
import {ChangeSetV07,StableId} from '@camery/ir';
import {WorkbenchActionReceiptSchema,WorkbenchIssueSchema} from '@camery/ir/workbench';
import {Hash,Id,Text} from '@camery/script/contracts';
import {OutlineAdoptionSourceSchema,OutlineFormalIdentitiesSchema,OutlineMappingDraftSchema,OutlineReviewerBindingSchema,OutlineVersionKeySchema,OUTLINE_MAPPING_MAX_OPERATIONS} from '@camery/script/outline/node';
import {ProjectIdentityScopeSchema} from './contracts.js';
import {ApplicationExpectationSchema} from './intent-contracts.js';

export const OUTLINE_INTENT_BYTES=33554432;
export const OUTLINE_INTENT_ENVELOPE_BYTES=67108864;
export const OUTLINE_INTENT_STORAGE_BYTES=67108864;
export const OUTLINE_INTENT_MAX_MESSAGES=131072;

const stable=StableId.refine(value=>value.length===26);
export const OutlineApplicationActorSchema=z.strictObject({kind:z.literal('user'),key:Id,id:stable});
export type OutlineApplicationActor=z.infer<typeof OutlineApplicationActorSchema>;
export const OutlineApplicationScopeSchema=z.strictObject({kind:z.literal('project'),id:stable});
export const OutlineCandidateIntentKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,applicationId:Id});
export const OutlineCandidateChangeKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,changeId:stable});
export const OutlineDecisionIntentKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,actorKind:z.literal('user'),actorKey:Id,requestId:Id});
export const OutlineCandidateSourceSchema=z.strictObject({kind:z.literal('outline'),mapperVersion:z.literal(1),source:OutlineAdoptionSourceSchema,identities:OutlineFormalIdentitiesSchema,reviewer:OutlineReviewerBindingSchema});
const operationIdentity=z.strictObject({slot:Text(160),id:stable});
const sameTarget=(left:z.infer<typeof OutlineVersionKeySchema>,right:z.infer<typeof OutlineVersionKeySchema>)=>left.tenantId===right.tenantId&&left.projectId===right.projectId;

/** A private storage contract. The host captures bounded JSON first; hashes and these bindings never grant adoption authority. */
export const OutlineCandidateIntentBodySchema=OutlineCandidateIntentKeySchema.extend({
  version:z.literal(1),actor:OutlineApplicationActorSchema,target:OutlineVersionKeySchema,commandDigest:Hash,source:OutlineCandidateSourceSchema,
  expectation:ApplicationExpectationSchema,changeId:stable,draft:OutlineMappingDraftSchema,operationIds:z.array(operationIdentity).max(OUTLINE_MAPPING_MAX_OPERATIONS),
}).superRefine((value,context)=>{
  const source=value.source.source,identities=value.source.identities,draft=value.draft;
  if(source.tenantId!==value.scope.tenantId||source.projectId!==value.scope.projectId||identities.tenantId!==value.scope.tenantId||identities.projectId!==value.scope.projectId
    ||!sameTarget(identities.target,value.target)||!sameTarget(draft.target,value.target)||identities.owner.runId!==source.runId||identities.owner.runDigest!==source.runDigest
    ||Object.keys(source).some(key=>source[key as keyof typeof source]!==draft.source[key as keyof typeof source]))context.addIssue({code:'custom',message:'Outline intent source and target binding'});
  if(draft.baseRevision!==value.expectation.expectedSnapshotRevision)context.addIssue({code:'custom',message:'Outline intent base binding'});
  if(value.operationIds.length!==draft.operations.length)context.addIssue({code:'custom',message:'Outline fixed operation count binding'});
});
export type OutlineCandidateIntentBody=z.infer<typeof OutlineCandidateIntentBodySchema>;
export interface OutlineCandidateIntent extends OutlineCandidateIntentBody{readonly digest:string;readonly businessDigest:string;readonly createdAt:string;readonly request:ChangeSetV07|null}
export const OutlineCandidateIntentSchema=OutlineCandidateIntentBodySchema.safeExtend({digest:Hash,businessDigest:Hash,createdAt:z.iso.datetime({precision:3}),request:ChangeSetV07.nullable()}).superRefine((value,context)=>{
  const request=value.request;
  if(request===null?value.draft.operations.length!==0:value.draft.operations.length===0||request.id!==value.changeId||request.author.kind!==value.actor.kind||request.author.id!==value.actor.id
    ||request.base_revision!==value.expectation.expectedSnapshotRevision||request.status!=='candidate'||request.ops.length!==value.draft.operations.length)context.addIssue({code:'custom',message:'Outline derived request binding'});
});
export const OutlineDecisionIntentBodySchema=z.strictObject({
  version:z.literal(1),scope:ProjectIdentityScopeSchema,requestId:Id,actor:OutlineApplicationActorSchema,changeId:stable,action:z.enum(['adopt','reject']),
  adoptionScope:OutlineApplicationScopeSchema,expectation:ApplicationExpectationSchema,reason:Text(500).nullable(),at:z.iso.datetime({precision:3}),
}).refine(value=>value.action==='adopt'?value.reason===null:value.reason!==null,{message:'Outline decision reason binding'});
export type OutlineDecisionIntentBody=z.infer<typeof OutlineDecisionIntentBodySchema>;
export interface OutlineDecisionIntent extends OutlineDecisionIntentBody{readonly digest:string;readonly businessDigest:string;readonly createdAt:string}
export const OutlineDecisionIntentSchema=OutlineDecisionIntentBodySchema.safeExtend({digest:Hash,businessDigest:Hash,createdAt:z.iso.datetime({precision:3})});
// Complete internal evidence gets its own limit. The generic public Workbench contract keeps its original 500-row budget.
export const OutlineActionReceiptSchema=WorkbenchActionReceiptSchema.safeExtend({issues:z.array(WorkbenchIssueSchema).max(OUTLINE_INTENT_MAX_MESSAGES),warnings:z.array(WorkbenchIssueSchema).max(OUTLINE_INTENT_MAX_MESSAGES)});
export type OutlineActionReceipt=z.infer<typeof OutlineActionReceiptSchema>;

import {z} from 'zod';
import {ChangeSet,StableId} from '@camery/ir';
import {Id,Hash,Text,Integer} from '@camery/script/contracts';
import {DevelopmentAdoptionSourceSchema,DevelopmentFormalIdentitiesSchema,DevelopmentReviewerBindingsSchema,DevelopmentVersionKeySchema} from '@camery/script/node';
import {ProjectIdentityScopeSchema} from './contracts.js';

export const APPLICATION_BYTES=1048576;
export const ApplicationActorSchema=z.strictObject({kind:z.enum(['user','agent_run','system']),key:Id,id:StableId.refine(value=>value.length===26)});
export const ApplicationExpectationSchema=z.strictObject({expectedSnapshotRevision:Integer.min(1),expectedWriteVersion:Integer.min(1)});
export const ApplicationScopeSchema=z.strictObject({kind:z.enum(['project','episode','scene']),id:StableId.refine(value=>value.length===26)});
export const CandidateSourceSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('manual')}),
  z.strictObject({kind:z.literal('development'),mapperVersion:z.literal(1),source:DevelopmentAdoptionSourceSchema,identities:DevelopmentFormalIdentitiesSchema,reviewers:DevelopmentReviewerBindingsSchema}),
]);
export const CandidateIntentKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,applicationId:Id});
export const CandidateChangeKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,changeId:StableId});
export const CandidateIntentBodySchema=CandidateIntentKeySchema.extend({version:z.literal(1),actor:ApplicationActorSchema,target:DevelopmentVersionKeySchema,commandDigest:Hash,
  source:CandidateSourceSchema,expectation:ApplicationExpectationSchema,changeId:StableId,request:ChangeSet.nullable(),
}).superRefine((value,context)=>{
  const request=value.request;
  if(request&&(request.id!==value.changeId||request.author.kind!==value.actor.kind||request.author.id!==value.actor.id||request.base_revision!==value.expectation.expectedSnapshotRevision||request.status!=='candidate'||request.ops.length>500))context.addIssue({code:'custom',message:'Candidate request binding'});
  if(value.source.kind==='development'){
    const source=value.source.source;const identities=value.source.identities;
    if(source.tenantId!==value.scope.tenantId||source.projectId!==value.scope.projectId||identities.tenantId!==value.scope.tenantId||identities.projectId!==value.scope.projectId||identities.target.tenantId!==value.target.tenantId||identities.target.projectId!==value.target.projectId||request&&request.schema_version!=='0.6.0-draft')context.addIssue({code:'custom',message:'Development source binding'});
  }else if(!request)context.addIssue({code:'custom',message:'Only a verified development draft can be unchanged'});
});
export type CandidateIntentBody=z.infer<typeof CandidateIntentBodySchema>;
export interface CandidateIntent extends CandidateIntentBody {readonly digest:string;readonly businessDigest:string;readonly createdAt:string}
export const CandidateIntentSchema=CandidateIntentBodySchema.safeExtend({digest:Hash,businessDigest:Hash,createdAt:z.iso.datetime({precision:3})});
export const DecisionIntentKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,actorKind:ApplicationActorSchema.shape.kind,actorKey:Id,requestId:Id});
export const DecisionIntentBodySchema=z.strictObject({version:z.literal(1),scope:ProjectIdentityScopeSchema,requestId:Id,actor:ApplicationActorSchema,changeId:StableId,
  action:z.enum(['adopt','reject']),adoptionScope:ApplicationScopeSchema,expectation:ApplicationExpectationSchema,reason:Text(500).nullable(),at:z.iso.datetime({precision:3}),
}).refine(value=>value.action==='adopt'?value.reason===null:value.reason!==null,{message:'Decision reason binding'});
export type DecisionIntentBody=z.infer<typeof DecisionIntentBodySchema>;
export interface DecisionIntent extends DecisionIntentBody {readonly digest:string;readonly businessDigest:string;readonly createdAt:string}
export const DecisionIntentSchema=DecisionIntentBodySchema.safeExtend({digest:Hash,businessDigest:Hash,createdAt:z.iso.datetime({precision:3})});
const issue=z.strictObject({code:Text(128),where:z.string().max(2048),message:z.string().max(4096)});
export const ProjectActionReceiptSchema=z.strictObject({version:z.literal(1),changeId:StableId,status:z.enum(['candidate','adopted','rejected','conflicted','unchanged']),snapshotRevision:Integer.min(1),writeVersion:Integer.min(1),
  issues:z.array(issue).max(500),warnings:z.array(issue).max(500),
  adoption:z.strictObject({change_set_id:StableId,actor_id:StableId,scope:ApplicationScopeSchema,from_revision:Integer.min(1),to_revision:Integer.min(1),at:z.iso.datetime({precision:3})}).nullable(),
  rejection:z.strictObject({actor_id:StableId,reason:Text(500),at:z.iso.datetime({precision:3})}).nullable(),
});
export type ProjectActionReceipt=z.infer<typeof ProjectActionReceiptSchema>;
export class ProjectApplicationError extends Error{
  override readonly name='ProjectApplicationError';
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT'|'CONFLICT'|'NOT_FOUND'|'STORAGE_FAILED',readonly operation:string){super(`Project application ${operation} failed (${code})`);}
}

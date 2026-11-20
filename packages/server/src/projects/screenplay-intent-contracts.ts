import {z} from 'zod';
import {StableId} from '@camery/ir';
import {WorkbenchActionReceiptSchema,WorkbenchIssueSchema} from '@camery/ir/workbench';
import {Hash,Id,Text} from '@camery/script/contracts';
import {ProjectIdentityScopeSchema} from './contracts.js';
import {ApplicationExpectationSchema} from './intent-contracts.js';

export const SCREENPLAY_JOURNAL_BYTES=2097152;
export const SCREENPLAY_RECEIPT_BYTES=67108864;
export const SCREENPLAY_RECEIPT_MESSAGES=131072;
const stable=StableId.refine(value=>value.length===26);
export const ScreenplayProjectActorSchema=z.strictObject({kind:z.literal('user'),key:Id,id:stable});
export const ScreenplayProjectTargetSchema=z.strictObject({tenantId:stable,projectId:stable});
export const ScreenplayProjectIntentKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,applicationId:Id});
export const ScreenplayProjectChangeKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,changeId:stable});
export const ScreenplayProjectIntentBodySchema=ScreenplayProjectIntentKeySchema.extend({
  version:z.literal(1),actor:ScreenplayProjectActorSchema,target:ScreenplayProjectTargetSchema,
  sourceKey:ProjectIdentityScopeSchema.extend({candidateId:Id}),preparationDigest:Hash,reviewDigest:Hash,packageDigest:Hash,contextDigest:Hash,
  episodeId:stable,expectation:ApplicationExpectationSchema,commandDigest:Hash,changeId:stable,slotsDigest:Hash,ids:z.array(stable).min(1).max(40000),
}).superRefine((value,context)=>{
  if(value.sourceKey.tenantId!==value.scope.tenantId||value.sourceKey.projectId!==value.scope.projectId)context.addIssue({code:'custom',message:'Screenplay journal source scope'});
  if(new Set(value.ids).size!==value.ids.length||value.ids.includes(value.changeId))context.addIssue({code:'custom',message:'Screenplay journal identities must be distinct'});
});
export type ScreenplayProjectIntentBody=z.infer<typeof ScreenplayProjectIntentBodySchema>;
export const ScreenplayProjectIntentSchema=ScreenplayProjectIntentBodySchema.safeExtend({digest:Hash,businessDigest:Hash,createdAt:z.iso.datetime({precision:3})});
export type ScreenplayProjectIntent=z.infer<typeof ScreenplayProjectIntentSchema>;
export const ScreenplayProjectDecisionKeySchema=z.strictObject({scope:ProjectIdentityScopeSchema,actorKind:z.literal('user'),actorKey:Id,requestId:Id});
export const ScreenplayProjectDecisionBodySchema=z.strictObject({version:z.literal(1),scope:ProjectIdentityScopeSchema,requestId:Id,actor:ScreenplayProjectActorSchema,target:ScreenplayProjectTargetSchema,changeId:stable,
  action:z.enum(['adopt','reject']),adoptionScope:z.strictObject({kind:z.literal('episode'),id:stable}),expectation:ApplicationExpectationSchema,reason:Text(500).nullable(),at:z.iso.datetime({precision:3}),
}).refine(value=>value.action==='adopt'?value.reason===null:value.reason!==null,{message:'Screenplay decision reason binding'});
export type ScreenplayProjectDecisionBody=z.infer<typeof ScreenplayProjectDecisionBodySchema>;
export const ScreenplayProjectDecisionSchema=ScreenplayProjectDecisionBodySchema.safeExtend({digest:Hash,businessDigest:Hash,createdAt:z.iso.datetime({precision:3})});
export type ScreenplayProjectDecision=z.infer<typeof ScreenplayProjectDecisionSchema>;
export const ScreenplayProjectReceiptSchema=WorkbenchActionReceiptSchema.safeExtend({issues:z.array(WorkbenchIssueSchema).max(SCREENPLAY_RECEIPT_MESSAGES),warnings:z.array(WorkbenchIssueSchema).max(SCREENPLAY_RECEIPT_MESSAGES)});
export type ScreenplayProjectReceipt=z.infer<typeof ScreenplayProjectReceiptSchema>;

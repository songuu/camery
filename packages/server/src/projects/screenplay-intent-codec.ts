import {freeze} from '@camery/methods';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureProjectCommand,projectCommandDigest} from './project-command-data.js';
import {SCREENPLAY_JOURNAL_BYTES,SCREENPLAY_RECEIPT_BYTES,ScreenplayProjectIntentBodySchema,ScreenplayProjectIntentSchema,ScreenplayProjectDecisionBodySchema,ScreenplayProjectDecisionSchema,ScreenplayProjectReceiptSchema} from './screenplay-intent-contracts.js';
import type {ScreenplayProjectIntentBody,ScreenplayProjectIntent,ScreenplayProjectDecisionBody,ScreenplayProjectDecision,ScreenplayProjectReceipt} from './screenplay-intent-contracts.js';

export type ScreenplayJournalRow={record:unknown;digest:string;business_digest:string;created_at:Date|string;[column:string]:unknown};
export type ScreenplayReceiptRow={record:unknown;digest:string;intent_digest:string};
export const screenplayScopeValues=(scope:{tenantId:string;projectId:string})=>[scope.tenantId,scope.projectId];
export const screenplayJournalDigest=(value:unknown)=>projectCommandDigest(value,SCREENPLAY_JOURNAL_BYTES);
const omit=(value:object,keys:readonly string[])=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
export const screenplayCandidateBusiness=(body:ScreenplayProjectIntentBody)=>screenplayJournalDigest({...omit(body,['changeId','ids']),identityCount:body.ids.length});
export const screenplayDecisionBusiness=(body:ScreenplayProjectDecisionBody)=>screenplayJournalDigest(omit(body,['at']));
export const screenplayDecisionKey=(body:ScreenplayProjectDecisionBody)=>({scope:body.scope,actorKind:body.actor.kind,actorKey:body.actor.key,requestId:body.requestId});
function timestamp(value:Date|string):string{const at=value instanceof Date?value.toISOString():value;if(new Date(at).toISOString()!==at)throw new Error();return at;}
function columns(row:ScreenplayJournalRow,body:{scope:{tenantId:string;projectId:string};actor:{kind:string;key:string;id:string};target:{tenantId:string;projectId:string};changeId:string}):void{
  if(row['tenant_id']!==body.scope.tenantId||row['project_id']!==body.scope.projectId||row['actor_kind']!==body.actor.kind||row['actor_key']!==body.actor.key||row['ir_actor_id']!==body.actor.id||row['ir_tenant_id']!==body.target.tenantId||row['ir_project_id']!==body.target.projectId||row['change_id']!==body.changeId)throw new Error();
}
export function screenplayCandidateRecord(row:ScreenplayJournalRow,key:{scope:{tenantId:string;projectId:string};applicationId?:string;changeId?:string},stored=true):ScreenplayProjectIntent{
  try{
    const body=captureProjectCommand(ScreenplayProjectIntentBodySchema,row.record,'stored screenplay journal',SCREENPLAY_JOURNAL_BYTES);
    if(body.scope.tenantId!==key.scope.tenantId||body.scope.projectId!==key.scope.projectId||key.applicationId!==undefined&&body.applicationId!==key.applicationId||key.changeId!==undefined&&body.changeId!==key.changeId||row.digest!==screenplayJournalDigest(body)||row.business_digest!==screenplayCandidateBusiness(body))throw new Error();
    if(stored){columns(row,body);if(row['application_id']!==body.applicationId||row['source_candidate_id']!==body.sourceKey.candidateId||row['preparation_digest']!==body.preparationDigest||row['review_digest']!==body.reviewDigest||row['context_digest']!==body.contextDigest||String(row['source_revision'])!==String(body.expectation.expectedSnapshotRevision)||row['episode_id']!==body.episodeId)throw new Error();}
    return freeze({...body,digest:row.digest,businessDigest:row.business_digest,createdAt:timestamp(row.created_at)});
  }catch{throw new ProjectApplicationError('STORAGE_FAILED','stored screenplay identity journal');}
}
export function captureScreenplayProjectIntent(input:ScreenplayProjectIntent):ScreenplayProjectIntent{
  const {digest,businessDigest,createdAt,...body}=captureProjectCommand(ScreenplayProjectIntentSchema,input,'screenplay journal envelope',SCREENPLAY_JOURNAL_BYTES);
  return screenplayCandidateRecord({record:body,digest,business_digest:businessDigest,created_at:createdAt},{scope:body.scope,applicationId:body.applicationId},false);
}
export function screenplayDecisionRecord(row:ScreenplayJournalRow,key:ReturnType<typeof screenplayDecisionKey>,stored=true):ScreenplayProjectDecision{
  try{
    const body=captureProjectCommand(ScreenplayProjectDecisionBodySchema,row.record,'stored screenplay decision',SCREENPLAY_JOURNAL_BYTES);
    if(screenplayJournalDigest(screenplayDecisionKey(body))!==screenplayJournalDigest(key)||row.digest!==screenplayJournalDigest(body)||row.business_digest!==screenplayDecisionBusiness(body))throw new Error();
    if(stored){columns(row,body);if(row['request_id']!==body.requestId)throw new Error();}
    return freeze({...body,digest:row.digest,businessDigest:row.business_digest,createdAt:timestamp(row.created_at)});
  }catch{throw new ProjectApplicationError('STORAGE_FAILED','stored screenplay decision journal');}
}
export function captureScreenplayProjectDecision(input:ScreenplayProjectDecision):ScreenplayProjectDecision{
  const {digest,businessDigest,createdAt,...body}=captureProjectCommand(ScreenplayProjectDecisionSchema,input,'screenplay decision envelope',SCREENPLAY_JOURNAL_BYTES);
  return screenplayDecisionRecord({record:body,digest,business_digest:businessDigest,created_at:createdAt},screenplayDecisionKey(body),false);
}
export function screenplayReceiptRecord(row:ScreenplayReceiptRow,intent:ScreenplayProjectIntent|ScreenplayProjectDecision):ScreenplayProjectReceipt{
  try{const receipt=captureProjectCommand(ScreenplayProjectReceiptSchema,row.record,'stored screenplay action receipt',SCREENPLAY_RECEIPT_BYTES);if(row.intent_digest!==intent.digest||receipt.changeId!==intent.changeId||row.digest!==projectCommandDigest({intentDigest:intent.digest,receipt},SCREENPLAY_RECEIPT_BYTES))throw new Error();return receipt;}
  catch{throw new ProjectApplicationError('STORAGE_FAILED','stored screenplay action receipt');}
}

import {freeze} from '@camery/methods';
import {finalizeOutlineChangeSet} from '@camery/script/outline/node';
import type {ChangeSetV07} from '@camery/ir';
import {ProjectApplicationError} from './intent-contracts.js';
import {OutlineCandidateIntentBodySchema,OutlineCandidateIntentSchema,OutlineDecisionIntentBodySchema,OutlineDecisionIntentSchema,OutlineActionReceiptSchema,OUTLINE_INTENT_ENVELOPE_BYTES} from './outline-intent-contracts.js';
import type {OutlineCandidateIntentBody,OutlineCandidateIntent,OutlineDecisionIntentBody,OutlineDecisionIntent,OutlineActionReceipt} from './outline-intent-contracts.js';
import {captureOutlineIntent,outlineIntentDigest,omitOutlineIntent} from './outline-intent-data.js';

export type OutlineIntentRow={record:unknown;digest:string;business_digest:string;created_at:Date|string};
export type OutlineCandidateRow=OutlineIntentRow&{tenant_id:string;project_id:string;application_id:string;actor_kind:string;actor_key:string;ir_actor_id:string;ir_tenant_id:string;ir_project_id:string;change_id:string;run_id:string;run_digest:string;review_digest:string};
export type OutlineDecisionRow=OutlineIntentRow&{tenant_id:string;project_id:string;actor_kind:string;actor_key:string;ir_actor_id:string;request_id:string;change_id:string};
export type OutlineReceiptRow={record:unknown;digest:string;intent_digest:string};
export const outlineScopeValues=(scope:{tenantId:string;projectId:string})=>[scope.tenantId,scope.projectId];
export const outlineDecisionKey=(body:OutlineDecisionIntentBody)=>({scope:body.scope,actorKind:body.actor.kind,actorKey:body.actor.key,requestId:body.requestId});
export const outlineCandidateBusiness=(body:OutlineCandidateIntentBody)=>outlineIntentDigest(omitOutlineIntent(body,['changeId','operationIds']));
export const outlineDecisionBusiness=(body:OutlineDecisionIntentBody)=>outlineIntentDigest(omitOutlineIntent(body,['at']));
function timestamp(input:Date|string):string{const at=input instanceof Date?input.toISOString():input;if(new Date(at).toISOString()!==at)throw new Error();return at;}
/** Fixed mappings and intent IDs determine exactly one immutable native request, never caller-supplied free JSON. */
export function deriveOutlineIntentRequest(body:OutlineCandidateIntentBody):ChangeSetV07|null{
  if(body.draft.reservedIds.includes(body.changeId)||body.actor.id===body.changeId)throw new ProjectApplicationError('CONFLICT','outline change identity alias');
  if(!body.draft.operations.length)return null;
  try{return finalizeOutlineChangeSet({draft:body.draft,changeSetId:body.changeId,author:{kind:'user',id:body.actor.id},operationIds:body.operationIds});}
  catch(error){let code:unknown;try{if(error&&typeof error==='object'){const descriptor=Object.getOwnPropertyDescriptor(error,'code');if(descriptor&&'value' in descriptor)code=descriptor.value;}}catch{/* Only safe public codes cross the mapping boundary. */}
    throw new ProjectApplicationError(code==='INPUT_LIMIT'?'INPUT_LIMIT':code==='CONFLICT'?'CONFLICT':'INVALID_INPUT','outline fixed mapping');}
}
export function outlineCandidateRecord(row:OutlineIntentRow&Partial<OutlineCandidateRow>,key:{scope:{tenantId:string;projectId:string};applicationId?:string;changeId?:string},stored=true):OutlineCandidateIntent{
  try{const body=captureOutlineIntent(OutlineCandidateIntentBodySchema,row.record,'stored outline body'),source=body.source.source;
    if(body.scope.tenantId!==key.scope.tenantId||body.scope.projectId!==key.scope.projectId||key.applicationId!==undefined&&body.applicationId!==key.applicationId||key.changeId!==undefined&&body.changeId!==key.changeId||outlineIntentDigest(body)!==row.digest||outlineCandidateBusiness(body)!==row.business_digest)throw new Error();
    if(stored&&(row.tenant_id!==body.scope.tenantId||row.project_id!==body.scope.projectId||row.application_id!==body.applicationId||row.actor_kind!==body.actor.kind||row.actor_key!==body.actor.key||row.ir_actor_id!==body.actor.id||row.ir_tenant_id!==body.target.tenantId||row.ir_project_id!==body.target.projectId||row.change_id!==body.changeId||row.run_id!==source.runId||row.run_digest!==source.runDigest||row.review_digest!==source.reviewDigest))throw new Error();
    return freeze({...body,digest:row.digest,businessDigest:row.business_digest,createdAt:timestamp(row.created_at),request:deriveOutlineIntentRequest(body)});
  }catch{throw new ProjectApplicationError('STORAGE_FAILED','stored outline candidate intent');}
}
export function captureOutlineCandidateIntent(input:OutlineCandidateIntent):OutlineCandidateIntent{
  const {request,digest,businessDigest,createdAt,...body}=captureOutlineIntent(OutlineCandidateIntentSchema,input,'outline candidate envelope',OUTLINE_INTENT_ENVELOPE_BYTES);
  const actual=outlineCandidateRecord({record:body,digest,business_digest:businessDigest,created_at:createdAt},{scope:body.scope,applicationId:body.applicationId},false);
  if(outlineIntentDigest(actual.request)!==outlineIntentDigest(request))throw new ProjectApplicationError('STORAGE_FAILED','outline derived request binding');return actual;
}
export function outlineDecisionRecord(row:OutlineIntentRow&Partial<OutlineDecisionRow>,key:ReturnType<typeof outlineDecisionKey>,stored=true):OutlineDecisionIntent{
  try{const body=captureOutlineIntent(OutlineDecisionIntentBodySchema,row.record,'stored outline decision');
    if(outlineIntentDigest(outlineDecisionKey(body))!==outlineIntentDigest(key)||outlineIntentDigest(body)!==row.digest||outlineDecisionBusiness(body)!==row.business_digest)throw new Error();
    if(stored&&(row.tenant_id!==body.scope.tenantId||row.project_id!==body.scope.projectId||row.actor_kind!==body.actor.kind||row.actor_key!==body.actor.key||row.ir_actor_id!==body.actor.id||row.request_id!==body.requestId||row.change_id!==body.changeId))throw new Error();
    return freeze({...body,digest:row.digest,businessDigest:row.business_digest,createdAt:timestamp(row.created_at)});
  }catch{throw new ProjectApplicationError('STORAGE_FAILED','stored outline decision intent');}
}
export function captureOutlineDecisionIntent(input:OutlineDecisionIntent):OutlineDecisionIntent{
  const {digest,businessDigest,createdAt,...body}=captureOutlineIntent(OutlineDecisionIntentSchema,input,'outline decision envelope',OUTLINE_INTENT_ENVELOPE_BYTES);
  return outlineDecisionRecord({record:body,digest,business_digest:businessDigest,created_at:createdAt},outlineDecisionKey(body),false);
}
export function outlineReceiptRecord(row:OutlineReceiptRow,intent:OutlineCandidateIntent|OutlineDecisionIntent):OutlineActionReceipt{
  try{const receipt=captureOutlineIntent(OutlineActionReceiptSchema,row.record,'stored outline receipt');if(row.intent_digest!==intent.digest||receipt.changeId!==intent.changeId||row.digest!==outlineIntentDigest({intentDigest:intent.digest,receipt}))throw new Error();return receipt;}
  catch{throw new ProjectApplicationError('STORAGE_FAILED','stored outline application receipt');}
}

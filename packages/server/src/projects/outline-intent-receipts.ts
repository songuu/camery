import type {PersistedChangeResult,VersionTransactionContext} from '@camery/versioning/node';
import {OUTLINE_MAPPING_CHANGE_BYTES} from '@camery/script/outline/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {OutlineActionReceiptSchema} from './outline-intent-contracts.js';
import type {OutlineCandidateIntent,OutlineDecisionIntent,OutlineActionReceipt} from './outline-intent-contracts.js';
import {captureOutlineIntent,outlineIntentDigest} from './outline-intent-data.js';
function refused(operation:string):never{throw new ProjectApplicationError('STORAGE_FAILED',operation);}

/** This selects actual native evidence on the version transaction; it never accepts a caller-authored receipt. */
export function outlineActualReceipt(candidate:OutlineCandidateIntent,result:Readonly<PersistedChangeResult>,allowUnstoredFailure=false):OutlineActionReceipt{
  const change=result.state.changes.find(row=>row.request.id===candidate.changeId),adoption=result.state.adoptions.find(row=>row.change_set_id===candidate.changeId)??null;
  const unstoredFailure=allowUnstoredFailure&&!change&&(result.status==='rejected'||result.status==='conflicted')&&result.issues.length>0&&!adoption;
  if(!candidate.request||!change&&!unstoredFailure||change&&outlineIntentDigest(change.request)!==outlineIntentDigest(candidate.request)||result.state.head.project.id!==candidate.target.projectId)refused('outline native request binding');
  if(result.status==='adopted'&&(!adoption||change?.status!=='adopted'))refused('outline native adoption evidence');
  return captureOutlineIntent(OutlineActionReceiptSchema,{version:1,changeId:candidate.changeId,status:result.status,snapshotRevision:result.state.head.revision.number,writeVersion:result.writeVersion,issues:result.issues,warnings:result.warnings,adoption,rejection:change?.rejection??null},'outline native receipt');
}
export function outlineExecutionTarget(candidate:OutlineCandidateIntent,expected:{expectedSnapshotRevision:number;expectedWriteVersion:number},context:VersionTransactionContext):void{
  if(!context?.project||context.project.tenantId!==candidate.target.tenantId||context.project.projectId!==candidate.target.projectId||!context.expectation||context.expectation.expectedSnapshotRevision!==expected.expectedSnapshotRevision||context.expectation.expectedWriteVersion!==expected.expectedWriteVersion)refused('outline execution target and base');
}
export function outlinePreparationExecution(intent:OutlineCandidateIntent,context:VersionTransactionContext):void{
  if(context?.operation!=='submit')refused('outline preparation operation');outlineExecutionTarget(intent,intent.expectation,context);
  if(typeof context.requestSignature!=='string'||Buffer.byteLength(context.requestSignature,'utf8')>OUTLINE_MAPPING_CHANGE_BYTES)refused('outline preparation signature');
  try{if(outlineIntentDigest(JSON.parse(context.requestSignature))!==outlineIntentDigest(intent.request))refused('outline preparation actual request');}
  catch{return refused('outline preparation actual request');}
}
export function outlineDecisionExecution(intent:OutlineDecisionIntent,receipt:OutlineActionReceipt,context:VersionTransactionContext):void{
  if(context.operation==='submit'||context.operation!==intent.action||context.changeId!==intent.changeId)refused('outline decision operation');
  if(context.actor.kind!==intent.actor.kind||context.actor.id!==intent.actor.id||context.scope.kind!==intent.adoptionScope.kind||context.scope.id!==intent.adoptionScope.id||context.at!==intent.at)refused('outline decision execution authority');
  if(context.operation==='reject'&&context.reason!==intent.reason)refused('outline decision execution reason');
  if(receipt.issues.length)return;
  if(context.operation==='reject'){
    if(receipt.status!=='rejected'||!receipt.rejection||receipt.rejection.actor_id!==intent.actor.id||receipt.rejection.reason!==intent.reason||receipt.rejection.at!==intent.at)refused('outline native rejection evidence');
  }else if(receipt.status!=='adopted'||!receipt.adoption||!context.replayed&&(receipt.adoption.actor_id!==intent.actor.id||receipt.adoption.scope.kind!==intent.adoptionScope.kind||receipt.adoption.scope.id!==intent.adoptionScope.id||receipt.adoption.at!==intent.at))refused('outline native approval evidence');
}

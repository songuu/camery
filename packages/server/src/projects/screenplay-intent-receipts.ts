import {z} from 'zod';
import {ChangeSetV07,ChangeSetV08} from '@camery/ir';
import type {PoolClient} from 'pg';
import {ScreenplayNativeMappingSchema,ScreenplayNativeIdentitySchema,readScreenplayNativeIntentForChange} from '@camery/script/screenplay/node';
import type {ScreenplayHost} from '@camery/script/screenplay/node';
import type {PersistedChangeResult,VersionTransactionContext} from '@camery/versioning/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureProjectCommand,projectCommandDigest} from './project-command-data.js';
import {SCREENPLAY_RECEIPT_BYTES,ScreenplayProjectReceiptSchema,ScreenplayProjectIntentBodySchema} from './screenplay-intent-contracts.js';
import type {ScreenplayProjectIntent,ScreenplayProjectDecision,ScreenplayProjectReceipt} from './screenplay-intent-contracts.js';

const REQUEST_BYTES=8388608;
const Request=z.discriminatedUnion('schema_version',[ChangeSetV07,ChangeSetV08]);
export const captureScreenplayRequest=(input:unknown)=>captureProjectCommand(Request,input,'screenplay actual native request',REQUEST_BYTES);
const NativeInput=z.strictObject({key:ScreenplayProjectIntentBodySchema.shape.sourceKey,mapping:ScreenplayNativeMappingSchema,ids:z.array(ScreenplayNativeIdentitySchema).max(40000),expectation:ScreenplayProjectIntentBodySchema.shape.expectation});
export const captureScreenplayExecution=(input:unknown)=>captureProjectCommand(NativeInput,input,'screenplay actual native mapping',SCREENPLAY_RECEIPT_BYTES);
export type ScreenplayExecution=z.infer<typeof NativeInput>;
const same=(a:unknown,b:unknown)=>projectCommandDigest(a,SCREENPLAY_RECEIPT_BYTES)===projectCommandDigest(b,SCREENPLAY_RECEIPT_BYTES);
function refused(operation:string):never{throw new ProjectApplicationError('STORAGE_FAILED',operation);}
/** Pair the shared acknowledgement with the actual SC binding written by the domain hook on this same client. */
export async function screenplayExecutionProof(client:PoolClient,intent:ScreenplayProjectIntent|ScreenplayProjectDecision,input:ScreenplayExecution,host:ScreenplayHost):Promise<void>{
  const {mapping,ids,key}=input;
  if(host.actor.kind!=='human'||host.actor.id!==intent.actor.key||host.scope.tenantId!==intent.scope.tenantId||host.scope.projectId!==intent.scope.projectId||'at' in intent&&host.at!==intent.at)refused('screenplay domain human authority binding');
  if(key.tenantId!==intent.scope.tenantId||key.projectId!==intent.scope.projectId||!same(mapping.target,intent.target)||mapping.request.id!==intent.changeId||!same(input.expectation,intent.expectation))refused('screenplay native execution pins');
  const scenes=mapping.request.ops.filter(op=>op.op==='add'&&op.collection==='scenes');
  const episodeId='episodeId' in intent?intent.episodeId:intent.adoptionScope.id;
  if(!scenes.length||scenes.some(op=>op.op!=='add'||op.value['episode_id']!==episodeId))refused('screenplay native whole episode');
  if('sourceKey' in intent){
    if(!same(key,intent.sourceKey)||mapping.sourceRevision!==intent.expectation.expectedSnapshotRevision||mapping.packageDigest!==intent.packageDigest||mapping.contextDigest!==intent.contextDigest||mapping.reviewDigest!==intent.reviewDigest||!same(ids.map(row=>row.id),intent.ids)||projectCommandDigest(ids.map(row=>row.slot),REQUEST_BYTES)!==intent.slotsDigest)refused('screenplay frozen identity and source pins');
  }
  const actual=await readScreenplayNativeIntentForChange(client,{scope:intent.scope,target:intent.target,changeId:intent.changeId},host);
  if(!actual||!same(actual.key,key)||!same(actual.mapping,mapping)||!same(actual.ids,ids))refused('screenplay actual domain binding');
  if('preparationDigest' in intent){
    const rows=await client.query<{digest:string}>('SELECT digest FROM camery_screenplay.candidates WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[key.tenantId,key.projectId,key.candidateId]);
    if(rows.rows.length!==1||rows.rows[0]!.digest!==intent.preparationDigest)refused('screenplay actual preparation digest');
  }
}
export function screenplayExecutionTarget(intent:ScreenplayProjectIntent|ScreenplayProjectDecision,context:VersionTransactionContext):void{
  if(!context?.project||!same(context.project,intent.target)||!context.expectation||!same(context.expectation,intent.expectation))refused('screenplay native target and base');
}
/** Complete native facts only; this private receipt never substitutes for the separate SC domain proof. */
export function screenplayActualReceipt(changeId:string,target:{projectId:string},request:ReturnType<typeof captureScreenplayRequest>,result:Readonly<PersistedChangeResult>):ScreenplayProjectReceipt{
  const change=result.state.changes.find(row=>row.request.id===changeId),adoption=result.state.adoptions.find(row=>row.change_set_id===changeId)??null;
  if(!change||!same(change.request,request)||result.state.head.project.id!==target.projectId||result.status==='adopted'&&(change.status!=='adopted'||!adoption))refused('screenplay native receipt facts');
  return captureProjectCommand(ScreenplayProjectReceiptSchema,{version:1,changeId,status:result.status,snapshotRevision:result.state.head.revision.number,writeVersion:result.writeVersion,issues:result.issues,warnings:result.warnings,adoption,rejection:change.rejection??null},'screenplay actual receipt',SCREENPLAY_RECEIPT_BYTES);
}
export function screenplayPreparationExecution(intent:ScreenplayProjectIntent,request:ReturnType<typeof captureScreenplayRequest>,result:Readonly<PersistedChangeResult>,context:VersionTransactionContext):void{
  screenplayExecutionTarget(intent,context);
  if(request.id!==intent.changeId||request.author.kind!=='user'||request.author.id!==intent.actor.id||request.base_revision!==intent.expectation.expectedSnapshotRevision||context.operation!=='submit'||result.status!=='candidate'||result.state.head.revision.number!==intent.expectation.expectedSnapshotRevision)refused('screenplay original preparation facts');
  try{if(typeof context.requestSignature!=='string'||Buffer.byteLength(context.requestSignature)>REQUEST_BYTES||!same(JSON.parse(context.requestSignature),request))refused('screenplay original preparation request');}
  catch{return refused('screenplay original preparation request');}
}
export function screenplayDecisionExecution(intent:ScreenplayProjectDecision,receipt:ScreenplayProjectReceipt,context:VersionTransactionContext):void{
  screenplayExecutionTarget(intent,context);
  if(context.operation==='submit'||context.operation!==intent.action||context.changeId!==intent.changeId||context.actor.kind!==intent.actor.kind||context.actor.id!==intent.actor.id||!same(context.scope,intent.adoptionScope)||context.at!==intent.at)refused('screenplay actual decision authority');
  if(context.operation==='reject'&&context.reason!==intent.reason)refused('screenplay actual rejection reason');
  if(receipt.issues.length)return;
  if(context.operation==='reject'){
    if(receipt.status!=='rejected'||!receipt.rejection||receipt.rejection.actor_id!==intent.actor.id||receipt.rejection.reason!==intent.reason||receipt.rejection.at!==intent.at)refused('screenplay actual rejection receipt');
  }else if(receipt.status!=='adopted'||!receipt.adoption||!context.replayed&&(receipt.adoption.actor_id!==intent.actor.id||!same(receipt.adoption.scope,intent.adoptionScope)||receipt.adoption.at!==intent.at))refused('screenplay actual adoption receipt');
}

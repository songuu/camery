import {z} from 'zod';
import {StableId} from '@camery/ir';
import {OutlinePrepareCommandSchema,OutlineAdoptCommandSchema,OutlineRejectCommandSchema} from '@camery/ir/outline-adoption';
import type {OutlineReceipt} from '@camery/ir/outline-adoption';
import {WorkbenchUpgradeSchema,WorkbenchAdoptSchema,WorkbenchRejectSchema} from '@camery/ir/workbench';
import {boundedOutlineSchema} from '@camery/script/outline/http';
import type {OutlineRunView} from '@camery/script/outline/http';
export {AdoptionLifetime} from './DevelopmentAdoptionState.js';

const LIMIT=16384;
const ordinary=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/),stable=StableId.refine(value=>value.length===26);
const Scope=z.strictObject({tenantId:ordinary,userId:ordinary,projectId:ordinary});
const upgradeScope=WorkbenchAdoptSchema.shape.scope.refine(value=>value.id.length===26);
const Action=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('prepare'),runId:ordinary,command:OutlinePrepareCommandSchema}),
  z.strictObject({kind:z.literal('upgrade'),command:WorkbenchUpgradeSchema}),
  z.strictObject({kind:z.literal('adopt'),candidateId:stable,requestId:ordinary,command:OutlineAdoptCommandSchema}),
  z.strictObject({kind:z.literal('reject'),candidateId:stable,requestId:ordinary,command:OutlineRejectCommandSchema}),
  z.strictObject({kind:z.literal('upgrade-adopt'),candidateId:stable,requestId:ordinary,command:WorkbenchAdoptSchema.extend({scope:upgradeScope})}),
  z.strictObject({kind:z.literal('upgrade-reject'),candidateId:stable,requestId:ordinary,command:WorkbenchRejectSchema.extend({scope:upgradeScope})}),
]);
const Record=z.strictObject({version:z.literal(1),scope:Scope,action:Action});
const Source=OutlinePrepareCommandSchema.pick({runDigest:true,briefDigest:true,candidateDigest:true,reviewDigest:true,sourceDigest:true});
export type OutlineAction=z.infer<typeof Action>;
export type OutlineActionScope=z.infer<typeof Scope>;
export type OutlineActionJournalCode='PENDING_ACTION'|'INVALID_ACTION'|'JOURNAL_UNAVAILABLE'|'JOURNAL_CORRUPT';
export class OutlineActionJournalError extends Error{
  override readonly name='OutlineActionJournalError';
  constructor(readonly code:OutlineActionJournalCode){super(`Formal outline action failed (${code})`);}
}
function freeze<T>(value:T):Readonly<T>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function capture<T>(schema:z.ZodType<T>,input:unknown,code:OutlineActionJournalCode):Readonly<T>{
  const parsed=boundedOutlineSchema(schema,LIMIT).safeParse(input);if(!parsed.success)throw new OutlineActionJournalError(code);return freeze(parsed.data);
}
const same=(left:OutlineAction,right:OutlineAction)=>JSON.stringify(left)===JSON.stringify(right);

/** Only a small unresolved command survives reload; credentials, source material and complete outlines never enter this journal. */
export class OutlineActionJournal{
  private readonly scope:Readonly<OutlineActionScope>;
  private readonly key:string;
  constructor(scope:OutlineActionScope,private readonly storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>){
    this.scope=capture(Scope,scope,'INVALID_ACTION');this.key='camery:outline-action:'+JSON.stringify([this.scope.tenantId,this.scope.userId,this.scope.projectId]);
  }
  read():Readonly<OutlineAction>|null{
    let raw:unknown;try{raw=this.storage.getItem(this.key);}catch{throw new OutlineActionJournalError('JOURNAL_UNAVAILABLE');}
    if(raw===null)return null;
    if(typeof raw!=='string'||raw.length>LIMIT||new TextEncoder().encode(raw).length>LIMIT)throw new OutlineActionJournalError('JOURNAL_CORRUPT');
    let input:unknown;try{input=JSON.parse(raw);}catch{throw new OutlineActionJournalError('JOURNAL_CORRUPT');}
    const record=capture(Record,input,'JOURNAL_CORRUPT');
    if(record.scope.tenantId!==this.scope.tenantId||record.scope.userId!==this.scope.userId||record.scope.projectId!==this.scope.projectId)throw new OutlineActionJournalError('JOURNAL_CORRUPT');
    return record.action;
  }
  begin(action:OutlineAction):Readonly<OutlineAction>{
    const captured=capture(Action,action,'INVALID_ACTION'),old=this.read();
    if(old){if(!same(old,captured))throw new OutlineActionJournalError('PENDING_ACTION');return old;}
    const record=capture(Record,{version:1,scope:this.scope,action:captured},'INVALID_ACTION');
    try{this.storage.setItem(this.key,JSON.stringify(record));}catch{throw new OutlineActionJournalError('JOURNAL_UNAVAILABLE');}
    // Silent or intercepted writes must not allow a new server action without a recoverable identity.
    const retained=this.read();if(!retained)throw new OutlineActionJournalError('JOURNAL_UNAVAILABLE');if(!same(retained,captured))throw new OutlineActionJournalError('PENDING_ACTION');return retained;
  }
  complete(action:OutlineAction):void{
    const captured=capture(Action,action,'INVALID_ACTION'),old=this.read();if(!old)return;
    if(!same(old,captured))throw new OutlineActionJournalError('PENDING_ACTION');
    try{this.storage.removeItem(this.key);}catch{throw new OutlineActionJournalError('JOURNAL_UNAVAILABLE');}
    if(this.read()!==null)throw new OutlineActionJournalError('JOURNAL_UNAVAILABLE');
  }
}

/** The run is already transport-validated; inconsistent status or digest pins still cannot enable preparation. */
export function outlineAdoptionSource(run:OutlineRunView){
  if(run.sourceChanged||run.state!=='reviewed'||run.reviewStatus!=='reviewed'||run.review?.status!=='reviewed'||!run.candidate||run.candidateDigest!==run.candidate.digest||run.review.candidateDigest!==run.candidate.digest)return null;
  const pins=Source.safeParse({runDigest:run.runDigest,briefDigest:run.brief.digest,candidateDigest:run.candidate.digest,reviewDigest:run.review.digest,sourceDigest:run.source.digest});return pins.success?freeze(pins.data):null;
}
/** Engine rejection and human rejection share a status; only the corresponding audit proves that the requested decision completed. */
export function outlineDecisionFeedback(action:'adopt'|'reject',receipt:OutlineReceipt){
  const success=receipt.kind==='decision'&&receipt.issueCount===0&&(action==='adopt'?receipt.status==='adopted'&&receipt.adoption!==null:receipt.status==='rejected'&&receipt.rejection!==null);
  return {success,message:success?(action==='adopt'?'已采用到正式大纲。':'候选已拒绝，正式大纲保持原版本。'):null,
    error:success?null:`本次${action==='adopt'?'采用':'拒绝'}未完成。${receipt.status==='conflicted'?'候选存在冲突，':''}请核对本次操作提示，再刷新候选状态。`,issueCount:receipt.issueCount,warningCount:receipt.warningCount};
}

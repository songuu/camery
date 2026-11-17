import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {canonical,freeze} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import type {PersistedChangeResult,VersionTransactionReceipt,VersionTransactionContext} from '@camery/versioning/node';
import {APPLICATION_BYTES,CandidateIntentKeySchema,CandidateChangeKeySchema,CandidateIntentBodySchema,CandidateIntentSchema,DecisionIntentKeySchema,DecisionIntentBodySchema,DecisionIntentSchema,ProjectActionReceiptSchema,ProjectApplicationError} from './intent-contracts.js';
import type {CandidateIntentBody,CandidateIntent,DecisionIntentBody,DecisionIntent,ProjectActionReceipt} from './intent-contracts.js';

type IntentRow={record:unknown;digest:string;business_digest:string;created_at:Date|string};
type CandidateRow=IntentRow&{tenant_id:string;project_id:string;application_id:string;actor_kind:string;actor_key:string;ir_actor_id:string;ir_tenant_id:string;ir_project_id:string;change_id:string};
type DecisionRow=IntentRow&{tenant_id:string;project_id:string;actor_kind:string;actor_key:string;ir_actor_id:string;request_id:string;change_id:string};
const candidateFields='tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,record,digest,business_digest,created_at';
const decisionFields='tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,change_id,record,digest,business_digest,created_at';
type ReceiptRow={record:unknown;digest:string;intent_digest:string};
type QueryClient=Pick<PoolClient,'query'>;
function capture<S extends z.ZodType>(schema:S,input:unknown):Readonly<z.infer<S>>{
  try{const parsed=schema.safeParse(snapshotJson(input,APPLICATION_BYTES));if(parsed.success)return freeze(parsed.data);}
  catch(error){if(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT')throw new ProjectApplicationError('INPUT_LIMIT','intent boundary');}
  throw new ProjectApplicationError('INVALID_INPUT','intent boundary');
}
export function projectIntentDigest(input:unknown):string{return createHash('sha256').update(canonical(snapshotJson(input,APPLICATION_BYTES))).digest('hex');}
function omit(value:object,keys:readonly string[]):Record<string,unknown>{return Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));}
function candidateBusiness(body:CandidateIntentBody):string{
  return projectIntentDigest({...omit(body,['changeId','request']),request:body.request?{...omit(body.request,['id','ops']),ops:body.request.ops.map(op=>omit(op,['op_id']))}:null});
}
const decisionBusiness=(body:DecisionIntentBody)=>projectIntentDigest(omit(body,['at']));
const scopeValues=(scope:{tenantId:string;projectId:string})=>[scope.tenantId,scope.projectId];
const decisionKey=(body:DecisionIntentBody)=>({scope:body.scope,actorKind:body.actor.kind,actorKey:body.actor.key,requestId:body.requestId});
function timestamp(input:Date|string):string{const at=input instanceof Date?input.toISOString():input;if(new Date(at).toISOString()!==at)throw new Error();return at;}
function one<T>(rows:T[]):T|null{if(rows.length>1)throw new ProjectApplicationError('STORAGE_FAILED','duplicate intent');return rows[0]??null;}
function databaseCode(error:unknown):unknown{try{if(error&&typeof error==='object'){const field=Object.getOwnPropertyDescriptor(error,'code');if(field&&'value' in field)return field.value;}}catch{/* Unknown proxies must not expose their own exceptions. */}return undefined;}
function knownApplicationError(error:unknown):error is ProjectApplicationError{try{return error instanceof ProjectApplicationError;}catch{return false;}}
async function safe<T>(operation:string,action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){if(knownApplicationError(error))throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}}
function candidateRecord(row:IntentRow&Partial<CandidateRow>,key:{scope:{tenantId:string;projectId:string};applicationId?:string;changeId?:string},stored=true):CandidateIntent{
  try{const body=capture(CandidateIntentBodySchema,row.record);
    if(body.scope.tenantId!==key.scope.tenantId||body.scope.projectId!==key.scope.projectId||key.applicationId!==undefined&&body.applicationId!==key.applicationId||key.changeId!==undefined&&body.changeId!==key.changeId||projectIntentDigest(body)!==row.digest||candidateBusiness(body)!==row.business_digest)throw new Error();
    if(stored&&(row.tenant_id!==body.scope.tenantId||row.project_id!==body.scope.projectId||row.application_id!==body.applicationId||row.actor_kind!==body.actor.kind||row.actor_key!==body.actor.key||row.ir_actor_id!==body.actor.id||row.ir_tenant_id!==body.target.tenantId||row.ir_project_id!==body.target.projectId||row.change_id!==body.changeId))throw new Error();
    return freeze({...body,digest:row.digest,businessDigest:row.business_digest,createdAt:timestamp(row.created_at)});
  }catch{throw new ProjectApplicationError('STORAGE_FAILED','stored candidate intent');}
}
function decisionRecord(row:IntentRow&Partial<DecisionRow>,key:z.infer<typeof DecisionIntentKeySchema>,stored=true):DecisionIntent{
  try{const body=capture(DecisionIntentBodySchema,row.record);
    if(projectIntentDigest(decisionKey(body))!==projectIntentDigest(key)||projectIntentDigest(body)!==row.digest||decisionBusiness(body)!==row.business_digest)throw new Error();
    if(stored&&(row.tenant_id!==body.scope.tenantId||row.project_id!==body.scope.projectId||row.actor_kind!==body.actor.kind||row.actor_key!==body.actor.key||row.ir_actor_id!==body.actor.id||row.request_id!==body.requestId||row.change_id!==body.changeId))throw new Error();
    return freeze({...body,digest:row.digest,businessDigest:row.business_digest,createdAt:timestamp(row.created_at)});
  }catch{throw new ProjectApplicationError('STORAGE_FAILED','stored decision intent');}
}
function receiptRecord(row:ReceiptRow,intent:CandidateIntent|DecisionIntent):ProjectActionReceipt{
  try{const receipt=capture(ProjectActionReceiptSchema,row.record);if(row.intent_digest!==intent.digest||receipt.changeId!==intent.changeId||row.digest!==projectIntentDigest({intentDigest:intent.digest,receipt}))throw new Error();return receipt;}
  catch{throw new ProjectApplicationError('STORAGE_FAILED','stored application receipt');}
}
function actualReceipt(candidate:CandidateIntent,result:Readonly<PersistedChangeResult>):ProjectActionReceipt{
  const change=result.state.changes.find(value=>value.request.id===candidate.changeId);
  if(!candidate.request||!change||projectIntentDigest(change.request)!==projectIntentDigest(candidate.request)||result.state.head.project.id!==candidate.target.projectId)throw new ProjectApplicationError('STORAGE_FAILED','version receipt binding');
  const adoption=result.state.adoptions.find(row=>row.change_set_id===candidate.changeId)??null;
  if(result.status==='adopted'&&(!adoption||change.status!=='adopted'))throw new ProjectApplicationError('STORAGE_FAILED','adoption evidence');
  return capture(ProjectActionReceiptSchema,{version:1,changeId:candidate.changeId,status:result.status,snapshotRevision:result.state.head.revision.number,writeVersion:result.writeVersion,
    issues:result.issues,warnings:result.warnings,adoption,rejection:change.rejection??null});
}
function executionTarget(candidate:CandidateIntent,expected:{expectedSnapshotRevision:number;expectedWriteVersion:number},context:VersionTransactionContext):void{
  if(!context?.project||context.project.tenantId!==candidate.target.tenantId||context.project.projectId!==candidate.target.projectId||!context.expectation||context.expectation.expectedSnapshotRevision!==expected.expectedSnapshotRevision||context.expectation.expectedWriteVersion!==expected.expectedWriteVersion)throw new ProjectApplicationError('STORAGE_FAILED','execution project and base binding');
}
function decisionExecution(intent:DecisionIntent,receipt:ProjectActionReceipt,context:Exclude<VersionTransactionContext,{operation:'submit'}>):void{
  const refuse=()=>{throw new ProjectApplicationError('STORAGE_FAILED','decision execution binding');};
  if(context.operation!==intent.action)refuse();
  if(context.actor.kind!==intent.actor.kind||context.actor.id!==intent.actor.id||context.scope.kind!==intent.adoptionScope.kind||context.scope.id!==intent.adoptionScope.id||context.at!==intent.at)refuse();
  if(context.operation==='reject'&&context.reason!==intent.reason)refuse();
  if(receipt.issues.length)return;
  if(context.operation==='reject'){
    if(receipt.status!=='rejected'||!receipt.rejection||receipt.rejection.actor_id!==intent.actor.id||receipt.rejection.reason!==intent.reason||receipt.rejection.at!==intent.at)refuse();
  }else{
    if(receipt.status!=='adopted'||!receipt.adoption)refuse();
    if(!context.replayed&&(receipt.adoption!.actor_id!==intent.actor.id||receipt.adoption!.scope.kind!==intent.adoptionScope.kind||receipt.adoption!.scope.id!==intent.adoptionScope.id||receipt.adoption!.at!==intent.at))refuse();
  }
}

/** Append-only command/receipt authority. Authentication and source verification belong to the trusted application, never these JSON records. */
export class PostgresProjectIntents{
  constructor(private readonly pool:Pool){}
  private async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect().catch(()=>{throw new ProjectApplicationError('STORAGE_FAILED','intent connection');});let failed=false;let destroy=false;
    const onError=()=>{failed=true;destroy=true;};const connected=()=>{if(failed)throw new ProjectApplicationError('STORAGE_FAILED','intent connection');};client.on('error',onError);
    try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');connected();const result=await action(client);connected();await client.query('COMMIT');connected();return result;}
    catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;throw new ProjectApplicationError('STORAGE_FAILED','intent rollback');}connected();if(knownApplicationError(error))throw error;const code=databaseCode(error);throw new ProjectApplicationError(code==='23503'||code==='23505'?'CONFLICT':'STORAGE_FAILED','intent transaction');}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Driver release messages can include credentials; preserve an explicit safe failure.
    finally{try{client.release(destroy);}catch{throw new ProjectApplicationError('STORAGE_FAILED','intent release');}finally{client.off('error',onError);}}
  }
  private async candidate(client:QueryClient,key:z.infer<typeof CandidateIntentKeySchema>):Promise<CandidateIntent|null>{
    const result=await client.query<CandidateRow>(`SELECT ${candidateFields} FROM camery_projects.candidate_intents WHERE tenant_id=$1 AND project_id=$2 AND application_id=$3`,[...scopeValues(key.scope),key.applicationId]);const row=one(result.rows);return row?candidateRecord(row,key):null;
  }
  private async decision(client:QueryClient,key:z.infer<typeof DecisionIntentKeySchema>):Promise<DecisionIntent|null>{
    const result=await client.query<DecisionRow>(`SELECT ${decisionFields} FROM camery_projects.decision_intents WHERE tenant_id=$1 AND project_id=$2 AND actor_kind=$3 AND actor_key=$4 AND request_id=$5`,[...scopeValues(key.scope),key.actorKind,key.actorKey,key.requestId]);const row=one(result.rows);return row?decisionRecord(row,key):null;
  }
  async findCandidate(input:unknown):Promise<CandidateIntent|null>{const key=capture(CandidateIntentKeySchema,input);return safe('read candidate intent',()=>this.candidate(this.pool,key));}
  async candidateForChange(input:unknown):Promise<CandidateIntent|null>{const key=capture(CandidateChangeKeySchema,input);return safe('read change intent',()=>this.changeOn(this.pool,key));}
  async findDecision(input:unknown):Promise<DecisionIntent|null>{const key=capture(DecisionIntentKeySchema,input);return safe('read decision intent',()=>this.decision(this.pool,key));}
  async putCandidate(input:unknown):Promise<CandidateIntent>{
    const body=capture(CandidateIntentBodySchema,input);if(body.request&&Buffer.byteLength(canonical(body.request),'utf8')>524288)throw new ProjectApplicationError('INPUT_LIMIT','candidate request');const digest=projectIntentDigest(body);const business=candidateBusiness(body);const key={scope:body.scope,applicationId:body.applicationId};
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_projects:candidate',...scopeValues(body.scope),body.applicationId])]);
      const existing=await this.candidate(client,key);if(existing){if(existing.businessDigest!==business)throw new ProjectApplicationError('CONFLICT','candidate identity');return existing;}
      const result=await client.query<CandidateRow>(`INSERT INTO camery_projects.candidate_intents(tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,record,digest,business_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING ${candidateFields}`,[...scopeValues(body.scope),body.applicationId,body.actor.kind,body.actor.key,body.actor.id,body.target.tenantId,body.target.projectId,body.changeId,canonical(body),digest,business]);
      const row=one(result.rows);if(!row)throw new ProjectApplicationError('STORAGE_FAILED','insert candidate intent');const saved=candidateRecord(row,key);
      if(!body.request)await this.savePreparation(client,saved,capture(ProjectActionReceiptSchema,{version:1,changeId:body.changeId,status:'unchanged',snapshotRevision:body.expectation.expectedSnapshotRevision,writeVersion:body.expectation.expectedWriteVersion,issues:[],warnings:[],adoption:null,rejection:null}));return saved;
    });
  }
  async putDecision(input:unknown):Promise<DecisionIntent>{
    const body=capture(DecisionIntentBodySchema,input);const key=decisionKey(body);const digest=projectIntentDigest(body);const business=decisionBusiness(body);
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_projects:decision',...scopeValues(body.scope),body.actor.kind,body.actor.key,body.requestId])]);
      const existing=await this.decision(client,key);if(existing){if(existing.businessDigest!==business)throw new ProjectApplicationError('CONFLICT','decision identity');return existing;}
      const candidate=await this.changeOn(client,{scope:body.scope,changeId:body.changeId});if(!candidate)throw new ProjectApplicationError('NOT_FOUND','candidate intent');
      if(body.adoptionScope.kind==='project'&&body.adoptionScope.id!==candidate.target.projectId)throw new ProjectApplicationError('CONFLICT','decision project scope');
      const result=await client.query<DecisionRow>(`INSERT INTO camery_projects.decision_intents(tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,change_id,record,digest,business_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING ${decisionFields}`,[...scopeValues(body.scope),body.actor.kind,body.actor.key,body.actor.id,body.requestId,body.changeId,canonical(body),digest,business]);const row=one(result.rows);if(!row)throw new ProjectApplicationError('STORAGE_FAILED','insert decision intent');return decisionRecord(row,key);
    });
  }
  private async changeOn(client:QueryClient,key:z.infer<typeof CandidateChangeKeySchema>):Promise<CandidateIntent|null>{const result=await client.query<CandidateRow>(`SELECT ${candidateFields} FROM camery_projects.candidate_intents WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3`,[...scopeValues(key.scope),key.changeId]);const row=one(result.rows);return row?candidateRecord(row,key):null;}
  private async preparation(client:QueryClient,intent:CandidateIntent):Promise<ProjectActionReceipt|null>{const result=await client.query<ReceiptRow>('SELECT record,digest,intent_digest FROM camery_projects.candidate_receipts WHERE tenant_id=$1 AND project_id=$2 AND application_id=$3',[...scopeValues(intent.scope),intent.applicationId]);const row=one(result.rows);return row?receiptRecord(row,intent):null;}
  private async decisionReceipt(client:QueryClient,intent:DecisionIntent):Promise<ProjectActionReceipt|null>{const result=await client.query<ReceiptRow>('SELECT record,digest,intent_digest FROM camery_projects.decision_receipts WHERE tenant_id=$1 AND project_id=$2 AND actor_kind=$3 AND actor_key=$4 AND request_id=$5',[...scopeValues(intent.scope),intent.actor.kind,intent.actor.key,intent.requestId]);const row=one(result.rows);return row?receiptRecord(row,intent):null;}
  async readPreparationReceipt(input:unknown):Promise<ProjectActionReceipt|null>{const key=capture(CandidateIntentKeySchema,input);return safe('read preparation receipt',async()=>{const intent=await this.candidate(this.pool,key);return intent?this.preparation(this.pool,intent):null;});}
  async readDecisionReceipt(input:unknown):Promise<ProjectActionReceipt|null>{const key=capture(DecisionIntentKeySchema,input);return safe('read decision receipt',async()=>{const intent=await this.decision(this.pool,key);return intent?this.decisionReceipt(this.pool,intent):null;});}
  private async savePreparation(client:QueryClient,intent:CandidateIntent,receipt:ProjectActionReceipt):Promise<void>{
    const values=[...scopeValues(intent.scope),intent.applicationId,intent.digest,canonical(receipt),projectIntentDigest({intentDigest:intent.digest,receipt})];await client.query('INSERT INTO camery_projects.candidate_receipts(tenant_id,project_id,application_id,intent_digest,record,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING',values);const saved=await this.preparation(client,intent);if(!saved)throw new ProjectApplicationError('STORAGE_FAILED','preparation receipt insertion');
  }
  preparationReceiptWriter(input:CandidateIntent):VersionTransactionReceipt{
    const {digest,businessDigest,createdAt,...body}=capture(CandidateIntentSchema,input);
    const intent=candidateRecord({record:body,digest,business_digest:businessDigest,created_at:createdAt},{scope:body.scope,applicationId:body.applicationId},false);
    return async(client,result,context)=>safe('write preparation receipt',async()=>{
      if(context?.operation!=='submit')throw new ProjectApplicationError('STORAGE_FAILED','preparation execution binding');executionTarget(intent,intent.expectation,context);
      if(typeof context.requestSignature!=='string'||projectIntentDigest(JSON.parse(context.requestSignature))!==projectIntentDigest(intent.request))throw new ProjectApplicationError('STORAGE_FAILED','preparation actual request');
      const receipt=actualReceipt(intent,result);await this.savePreparation(client,intent,receipt);
    });
  }
  decisionReceiptWriter(input:DecisionIntent,candidateInput:CandidateIntent):VersionTransactionReceipt{
    const {digest,businessDigest,createdAt,...body}=capture(DecisionIntentSchema,input);const intent=decisionRecord({record:body,digest,business_digest:businessDigest,created_at:createdAt},decisionKey(body),false);
    const {digest:cd,businessDigest:cb,createdAt:ct,...candidateBody}=capture(CandidateIntentSchema,candidateInput);const candidate=candidateRecord({record:candidateBody,digest:cd,business_digest:cb,created_at:ct},{scope:intent.scope,changeId:intent.changeId},false);
    return async(client,result,context)=>safe('write decision receipt',async()=>{
      executionTarget(candidate,intent.expectation,context);if(context.operation==='submit'||context.changeId!==intent.changeId)throw new ProjectApplicationError('STORAGE_FAILED','decision actual change');
      const receipt=actualReceipt(candidate,result);decisionExecution(intent,receipt,context);const values=[...scopeValues(intent.scope),intent.actor.kind,intent.actor.key,intent.requestId,intent.digest,canonical(receipt),projectIntentDigest({intentDigest:intent.digest,receipt})];
      await client.query('INSERT INTO camery_projects.decision_receipts(tenant_id,project_id,actor_kind,actor_key,request_id,intent_digest,record,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING',values);const saved=await this.decisionReceipt(client,intent);if(!saved)throw new ProjectApplicationError('STORAGE_FAILED','decision receipt insertion');
      const historicalAck=context.operation==='adopt'&&context.replayed&&saved.status==='adopted'&&receipt.status==='adopted'&&saved.issues.length===0&&receipt.issues.length===0&&projectIntentDigest(saved.adoption)===projectIntentDigest(receipt.adoption);
      if(projectIntentDigest(saved)!==projectIntentDigest(receipt)&&!historicalAck)throw new ProjectApplicationError('CONFLICT','decision receipt identity');
    });
  }
}

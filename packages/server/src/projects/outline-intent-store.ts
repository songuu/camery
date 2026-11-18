import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import type {VersionTransactionReceipt} from '@camery/versioning/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {OutlineCandidateIntentKeySchema,OutlineCandidateChangeKeySchema,OutlineCandidateIntentBodySchema,OutlineDecisionIntentKeySchema,OutlineDecisionIntentBodySchema,OutlineActionReceiptSchema} from './outline-intent-contracts.js';
import type {OutlineCandidateIntent,OutlineDecisionIntent,OutlineActionReceipt} from './outline-intent-contracts.js';
import {captureOutlineIntent,outlineIntentDigest,outlineIntentJson,knownOutlineIntentError,outlineIntentDatabaseCode,outlineIntentOne,safeOutlineIntent} from './outline-intent-data.js';
import {outlineScopeValues,outlineDecisionKey,outlineCandidateBusiness,outlineDecisionBusiness,outlineCandidateRecord,outlineDecisionRecord,outlineReceiptRecord,deriveOutlineIntentRequest,captureOutlineCandidateIntent,captureOutlineDecisionIntent} from './outline-intent-codec.js';
import type {OutlineCandidateRow,OutlineDecisionRow,OutlineReceiptRow} from './outline-intent-codec.js';
import {outlineActualReceipt,outlineExecutionTarget,outlinePreparationExecution,outlineDecisionExecution} from './outline-intent-receipts.js';

export {outlineIntentDigest} from './outline-intent-data.js';
type QueryClient=Pick<PoolClient,'query'>;
const candidateFields='tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,run_id,run_digest,review_digest,record,digest,business_digest,created_at';
const decisionFields='tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,change_id,record,digest,business_digest,created_at';
type CandidateKey=z.infer<typeof OutlineCandidateIntentKeySchema>;
type ChangeKey=z.infer<typeof OutlineCandidateChangeKeySchema>;
type DecisionKey=z.infer<typeof OutlineDecisionIntentKeySchema>;

/** Private append-only commands. Authentication and source replay remain the trusted application's responsibility. */
export class PostgresOutlineProjectIntents{
  constructor(private readonly pool:Pool){}
  private async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>{
    let client:PoolClient;try{client=await this.pool.connect();}catch{throw new ProjectApplicationError('STORAGE_FAILED','outline intent connection');}
    let failed=false,destroy=false;const onError=()=>{failed=true;destroy=true;};const connected=()=>{if(failed)throw new ProjectApplicationError('STORAGE_FAILED','outline intent connection');};client.on('error',onError);
    try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');connected();const result=await action(client);connected();await client.query('COMMIT');connected();return result;}
    catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;throw new ProjectApplicationError('STORAGE_FAILED','outline intent rollback');}connected();if(knownOutlineIntentError(error))throw error;const code=outlineIntentDatabaseCode(error);throw new ProjectApplicationError(code==='23503'||code==='23505'?'CONFLICT':'STORAGE_FAILED','outline intent transaction');}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Driver messages must never escape the safe application boundary.
    finally{try{client.release(destroy);}catch{throw new ProjectApplicationError('STORAGE_FAILED','outline intent release');}finally{client.off('error',onError);}}
  }
  private async candidate(client:QueryClient,key:CandidateKey):Promise<OutlineCandidateIntent|null>{
    const result=await client.query<OutlineCandidateRow>(`SELECT ${candidateFields} FROM camery_projects.outline_candidate_intents WHERE tenant_id=$1 AND project_id=$2 AND application_id=$3`,[...outlineScopeValues(key.scope),key.applicationId]);const row=outlineIntentOne(result.rows);return row?outlineCandidateRecord(row,key):null;
  }
  private async changeOn(client:QueryClient,key:ChangeKey):Promise<OutlineCandidateIntent|null>{
    const result=await client.query<OutlineCandidateRow>(`SELECT ${candidateFields} FROM camery_projects.outline_candidate_intents WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3`,[...outlineScopeValues(key.scope),key.changeId]);const row=outlineIntentOne(result.rows);return row?outlineCandidateRecord(row,key):null;
  }
  private async decision(client:QueryClient,key:DecisionKey):Promise<OutlineDecisionIntent|null>{
    const result=await client.query<OutlineDecisionRow>(`SELECT ${decisionFields} FROM camery_projects.outline_decision_intents WHERE tenant_id=$1 AND project_id=$2 AND actor_kind=$3 AND actor_key=$4 AND request_id=$5`,[...outlineScopeValues(key.scope),key.actorKind,key.actorKey,key.requestId]);const row=outlineIntentOne(result.rows);return row?outlineDecisionRecord(row,key):null;
  }
  async findCandidate(input:unknown):Promise<OutlineCandidateIntent|null>{const key=captureOutlineIntent(OutlineCandidateIntentKeySchema,input,'outline candidate key');return safeOutlineIntent('read outline candidate',()=>this.candidate(this.pool,key));}
  async candidateForChange(input:unknown):Promise<OutlineCandidateIntent|null>{const key=captureOutlineIntent(OutlineCandidateChangeKeySchema,input,'outline change key');return safeOutlineIntent('read outline change',()=>this.changeOn(this.pool,key));}
  async findDecision(input:unknown):Promise<OutlineDecisionIntent|null>{const key=captureOutlineIntent(OutlineDecisionIntentKeySchema,input,'outline decision key');return safeOutlineIntent('read outline decision',()=>this.decision(this.pool,key));}
  async putCandidate(input:unknown):Promise<OutlineCandidateIntent>{
    const body=captureOutlineIntent(OutlineCandidateIntentBodySchema,input,'outline candidate command');deriveOutlineIntentRequest(body);
    const digest=outlineIntentDigest(body),business=outlineCandidateBusiness(body),key={scope:body.scope,applicationId:body.applicationId};
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_projects:outline-candidate',...outlineScopeValues(body.scope),body.applicationId])]);
      const existing=await this.candidate(client,key);if(existing){if(existing.businessDigest!==business)throw new ProjectApplicationError('CONFLICT','outline candidate identity');if(!existing.request&&!await this.preparation(client,existing))throw new ProjectApplicationError('STORAGE_FAILED','missing original outline unchanged receipt');return existing;}
      const source=body.source.source;
      const result=await client.query<OutlineCandidateRow>(`INSERT INTO camery_projects.outline_candidate_intents(tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,run_id,run_digest,review_digest,record,digest,business_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15) RETURNING ${candidateFields}`,[...outlineScopeValues(body.scope),body.applicationId,body.actor.kind,body.actor.key,body.actor.id,body.target.tenantId,body.target.projectId,body.changeId,source.runId,source.runDigest,source.reviewDigest,outlineIntentJson(body),digest,business]);
      const row=outlineIntentOne(result.rows);if(!row)throw new ProjectApplicationError('STORAGE_FAILED','insert outline candidate');const saved=outlineCandidateRecord(row,key);if(saved.digest!==digest)throw new ProjectApplicationError('STORAGE_FAILED','outline inserted candidate binding');
      if(!saved.request)await this.saveUnchanged(client,saved);return saved;
    });
  }
  private async saveUnchanged(client:QueryClient,intent:OutlineCandidateIntent):Promise<void>{
    // Lock the real head: a zero-operation draft is proof only at its original compare-and-swap base.
    const result=await client.query<{snapshot_revision:number;write_version:number;schema_version:string}>(`SELECT p.head_revision::double precision AS snapshot_revision,p.write_version::double precision AS write_version,s.package->>'schema_version' AS schema_version FROM camery_versioning.projects p LEFT JOIN camery_versioning.snapshots s ON s.tenant_id=p.tenant_id AND s.project_id=p.project_id AND s.revision=p.head_revision WHERE p.tenant_id=$1 AND p.project_id=$2 FOR UPDATE OF p`,[intent.target.tenantId,intent.target.projectId]);
    const head=outlineIntentOne(result.rows);if(!head)throw new ProjectApplicationError('NOT_FOUND','outline unchanged formal head');if(head.schema_version!=='0.7.0-draft')throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','outline unchanged formal schema');
    if(!Number.isSafeInteger(head.snapshot_revision)||head.snapshot_revision<1||!Number.isSafeInteger(head.write_version)||head.write_version<1)throw new ProjectApplicationError('STORAGE_FAILED','outline unchanged formal counters');
    const code=head.snapshot_revision!==intent.expectation.expectedSnapshotRevision?'SNAPSHOT_STALE':head.write_version!==intent.expectation.expectedWriteVersion?'WRITE_VERSION_CONFLICT':null;
    await this.savePreparation(client,intent,captureOutlineIntent(OutlineActionReceiptSchema,{version:1,changeId:intent.changeId,status:code?'conflicted':'unchanged',snapshotRevision:head.snapshot_revision,writeVersion:head.write_version,issues:code?[{code,where:'/expectation',message:'The formal project no longer matches the outline mapping base.'}]:[],warnings:[],adoption:null,rejection:null},'outline unchanged receipt'));
  }
  async putDecision(input:unknown):Promise<OutlineDecisionIntent>{
    const body=captureOutlineIntent(OutlineDecisionIntentBodySchema,input,'outline decision command'),key=outlineDecisionKey(body),digest=outlineIntentDigest(body),business=outlineDecisionBusiness(body);
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_projects:outline-decision',...outlineScopeValues(body.scope),body.actor.kind,body.actor.key,body.requestId])]);
      const existing=await this.decision(client,key);if(existing){if(existing.businessDigest!==business)throw new ProjectApplicationError('CONFLICT','outline decision identity');return existing;}
      const candidate=await this.changeOn(client,{scope:body.scope,changeId:body.changeId});if(!candidate)throw new ProjectApplicationError('NOT_FOUND','outline decision candidate');if(!candidate.request||body.adoptionScope.id!==candidate.target.projectId)throw new ProjectApplicationError('CONFLICT','outline decision target');
      const result=await client.query<OutlineDecisionRow>(`INSERT INTO camery_projects.outline_decision_intents(tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,change_id,record,digest,business_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING ${decisionFields}`,[...outlineScopeValues(body.scope),body.actor.kind,body.actor.key,body.actor.id,body.requestId,body.changeId,outlineIntentJson(body),digest,business]);
      const row=outlineIntentOne(result.rows);if(!row)throw new ProjectApplicationError('STORAGE_FAILED','insert outline decision');const saved=outlineDecisionRecord(row,key);if(saved.digest!==digest)throw new ProjectApplicationError('STORAGE_FAILED','outline inserted decision binding');return saved;
    });
  }
  private async preparation(client:QueryClient,intent:OutlineCandidateIntent):Promise<OutlineActionReceipt|null>{const result=await client.query<OutlineReceiptRow>('SELECT record,digest,intent_digest FROM camery_projects.outline_candidate_receipts WHERE tenant_id=$1 AND project_id=$2 AND application_id=$3',[...outlineScopeValues(intent.scope),intent.applicationId]);const row=outlineIntentOne(result.rows);return row?outlineReceiptRecord(row,intent):null;}
  private async decisionReceipt(client:QueryClient,intent:OutlineDecisionIntent):Promise<OutlineActionReceipt|null>{const result=await client.query<OutlineReceiptRow>('SELECT record,digest,intent_digest FROM camery_projects.outline_decision_receipts WHERE tenant_id=$1 AND project_id=$2 AND actor_kind=$3 AND actor_key=$4 AND request_id=$5',[...outlineScopeValues(intent.scope),intent.actor.kind,intent.actor.key,intent.requestId]);const row=outlineIntentOne(result.rows);return row?outlineReceiptRecord(row,intent):null;}
  async readPreparationReceipt(input:unknown):Promise<OutlineActionReceipt|null>{const key=captureOutlineIntent(OutlineCandidateIntentKeySchema,input,'outline preparation key');return safeOutlineIntent('read outline preparation receipt',async()=>{const intent=await this.candidate(this.pool,key);return intent?this.preparation(this.pool,intent):null;});}
  async readDecisionReceipt(input:unknown):Promise<OutlineActionReceipt|null>{const key=captureOutlineIntent(OutlineDecisionIntentKeySchema,input,'outline receipt key');return safeOutlineIntent('read outline decision receipt',async()=>{const intent=await this.decision(this.pool,key);return intent?this.decisionReceipt(this.pool,intent):null;});}
  private async savePreparation(client:QueryClient,intent:OutlineCandidateIntent,receipt:OutlineActionReceipt):Promise<void>{
    await client.query('INSERT INTO camery_projects.outline_candidate_receipts(tenant_id,project_id,application_id,intent_digest,record,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING',[...outlineScopeValues(intent.scope),intent.applicationId,intent.digest,outlineIntentJson(receipt),outlineIntentDigest({intentDigest:intent.digest,receipt})]);
    if(!await this.preparation(client,intent))throw new ProjectApplicationError('STORAGE_FAILED','outline preparation insertion');
  }
  preparationReceiptWriter(input:OutlineCandidateIntent):VersionTransactionReceipt{
    const intent=captureOutlineCandidateIntent(input);
    return async(client,result,context)=>safeOutlineIntent('write outline preparation',async()=>{outlinePreparationExecution(intent,context);await this.savePreparation(client,intent,outlineActualReceipt(intent,result,true));});
  }
  decisionReceiptWriter(input:OutlineDecisionIntent,candidateInput:OutlineCandidateIntent):VersionTransactionReceipt{
    const intent=captureOutlineDecisionIntent(input),candidate=captureOutlineCandidateIntent(candidateInput);
    if(intent.scope.tenantId!==candidate.scope.tenantId||intent.scope.projectId!==candidate.scope.projectId||intent.changeId!==candidate.changeId||intent.adoptionScope.id!==candidate.target.projectId)throw new ProjectApplicationError('STORAGE_FAILED','outline decision candidate binding');
    return async(client,result,context)=>safeOutlineIntent('write outline decision',async()=>{
      outlineExecutionTarget(candidate,intent.expectation,context);const receipt=outlineActualReceipt(candidate,result);outlineDecisionExecution(intent,receipt,context);
      await client.query('INSERT INTO camery_projects.outline_decision_receipts(tenant_id,project_id,actor_kind,actor_key,request_id,intent_digest,record,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING',[...outlineScopeValues(intent.scope),intent.actor.kind,intent.actor.key,intent.requestId,intent.digest,outlineIntentJson(receipt),outlineIntentDigest({intentDigest:intent.digest,receipt})]);
      const saved=await this.decisionReceipt(client,intent);if(!saved)throw new ProjectApplicationError('STORAGE_FAILED','outline decision receipt insertion');
      const historicalAck=context.operation==='adopt'&&context.replayed&&saved.status==='adopted'&&receipt.status==='adopted'&&saved.issues.length===0&&receipt.issues.length===0&&outlineIntentDigest(saved.adoption)===outlineIntentDigest(receipt.adoption);
      if(outlineIntentDigest(saved)!==outlineIntentDigest(receipt)&&!historicalAck)throw new ProjectApplicationError('CONFLICT','outline decision receipt identity');
    });
  }
}

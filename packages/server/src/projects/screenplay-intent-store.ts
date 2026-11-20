import type {Pool,PoolClient} from 'pg';
import type {z} from 'zod';
import type {VersionTransactionReceipt} from '@camery/versioning/node';
import type {ScreenplayHost} from '@camery/script/screenplay/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {projectCommandTransaction} from './project-command-transaction.js';
import {captureProjectCommand,projectCommandDigest,projectCommandJson} from './project-command-data.js';
import {SCREENPLAY_JOURNAL_BYTES,SCREENPLAY_RECEIPT_BYTES,ScreenplayProjectIntentKeySchema,ScreenplayProjectChangeKeySchema,ScreenplayProjectIntentBodySchema,ScreenplayProjectDecisionKeySchema,ScreenplayProjectDecisionBodySchema} from './screenplay-intent-contracts.js';
import type {ScreenplayProjectIntent,ScreenplayProjectDecision,ScreenplayProjectReceipt} from './screenplay-intent-contracts.js';
import {screenplayScopeValues,screenplayJournalDigest,screenplayCandidateBusiness,screenplayDecisionBusiness,screenplayDecisionKey,screenplayCandidateRecord,screenplayDecisionRecord,screenplayReceiptRecord,captureScreenplayProjectIntent,captureScreenplayProjectDecision} from './screenplay-intent-codec.js';
import type {ScreenplayJournalRow,ScreenplayReceiptRow} from './screenplay-intent-codec.js';
import {captureScreenplayExecution,screenplayExecutionProof,screenplayActualReceipt,screenplayPreparationExecution,screenplayDecisionExecution} from './screenplay-intent-receipts.js';

type QueryClient=Pick<PoolClient,'query'>;
type CandidateKey=z.infer<typeof ScreenplayProjectIntentKeySchema>;
type ChangeKey=z.infer<typeof ScreenplayProjectChangeKeySchema>;
type DecisionKey=z.infer<typeof ScreenplayProjectDecisionKeySchema>;
const candidateFields='tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,source_candidate_id,preparation_digest,review_digest,context_digest,source_revision,episode_id,record,digest,business_digest,created_at';
const decisionFields='tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,ir_tenant_id,ir_project_id,change_id,record,digest,business_digest,created_at';
const capture=<S extends z.ZodType>(schema:S,value:unknown,operation:string)=>captureProjectCommand(schema,value,operation,SCREENPLAY_JOURNAL_BYTES);
function known(error:unknown):error is ProjectApplicationError{try{return error instanceof ProjectApplicationError;}catch{return false;}}
async function safe<T>(operation:string,action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){if(known(error))throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}}
function one<T>(rows:T[]):T|null{if(rows.length>1)throw new ProjectApplicationError('STORAGE_FAILED','screenplay journal cardinality');return rows[0]??null;}

/** Source/identity commands only. The SC domain and native version transaction still own formal adoption. */
export class PostgresScreenplayProjectIntents{
  constructor(private readonly pool:Pool){}
  private async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>{
    return projectCommandTransaction(this.pool,'screenplay journal',action);
  }
  private async candidate(client:QueryClient,key:CandidateKey):Promise<ScreenplayProjectIntent|null>{
    const rows=await client.query<ScreenplayJournalRow>(`SELECT ${candidateFields} FROM camery_projects.screenplay_candidate_intents WHERE tenant_id=$1 AND project_id=$2 AND application_id=$3`,[...screenplayScopeValues(key.scope),key.applicationId]),row=one(rows.rows);return row?screenplayCandidateRecord(row,key):null;
  }
  private async change(client:QueryClient,key:ChangeKey):Promise<ScreenplayProjectIntent|null>{
    const rows=await client.query<ScreenplayJournalRow>(`SELECT ${candidateFields} FROM camery_projects.screenplay_candidate_intents WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3`,[...screenplayScopeValues(key.scope),key.changeId]),row=one(rows.rows);return row?screenplayCandidateRecord(row,key):null;
  }
  private async decision(client:QueryClient,key:DecisionKey):Promise<ScreenplayProjectDecision|null>{
    const rows=await client.query<ScreenplayJournalRow>(`SELECT ${decisionFields} FROM camery_projects.screenplay_decision_intents WHERE tenant_id=$1 AND project_id=$2 AND actor_kind=$3 AND actor_key=$4 AND request_id=$5`,[...screenplayScopeValues(key.scope),key.actorKind,key.actorKey,key.requestId]),row=one(rows.rows);return row?screenplayDecisionRecord(row,key):null;
  }
  async findCandidate(input:unknown){const key=capture(ScreenplayProjectIntentKeySchema,input,'screenplay journal key');return safe('read screenplay journal',()=>this.candidate(this.pool,key));}
  async candidateForChange(input:unknown){const key=capture(ScreenplayProjectChangeKeySchema,input,'screenplay change key');return safe('read screenplay change journal',()=>this.change(this.pool,key));}
  async findDecision(input:unknown){const key=capture(ScreenplayProjectDecisionKeySchema,input,'screenplay decision key');return safe('read screenplay decision journal',()=>this.decision(this.pool,key));}
  async putCandidate(input:unknown):Promise<ScreenplayProjectIntent>{
    const body=capture(ScreenplayProjectIntentBodySchema,input,'screenplay frozen identities'),key={scope:body.scope,applicationId:body.applicationId},digest=screenplayJournalDigest(body),business=screenplayCandidateBusiness(body);
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_projects:screenplay-candidate',...screenplayScopeValues(body.scope),body.applicationId])]);
      const previous=await this.candidate(client,key);if(previous){if(previous.businessDigest!==business)throw new ProjectApplicationError('CONFLICT','screenplay command identity');return previous;}
      const rows=await client.query<ScreenplayJournalRow>(`INSERT INTO camery_projects.screenplay_candidate_intents(tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,source_candidate_id,preparation_digest,review_digest,context_digest,source_revision,episode_id,record,digest,business_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) RETURNING ${candidateFields}`,[...screenplayScopeValues(body.scope),body.applicationId,body.actor.kind,body.actor.key,body.actor.id,body.target.tenantId,body.target.projectId,body.changeId,body.sourceKey.candidateId,body.preparationDigest,body.reviewDigest,body.contextDigest,body.expectation.expectedSnapshotRevision,body.episodeId,projectCommandJson(body,SCREENPLAY_JOURNAL_BYTES),digest,business]);
      const row=one(rows.rows);if(!row)throw new ProjectApplicationError('STORAGE_FAILED','insert screenplay journal');const saved=screenplayCandidateRecord(row,key);if(saved.digest!==digest)throw new ProjectApplicationError('STORAGE_FAILED','inserted screenplay journal binding');return saved;
    });
  }
  async putDecision(input:unknown):Promise<ScreenplayProjectDecision>{
    const body=capture(ScreenplayProjectDecisionBodySchema,input,'screenplay frozen decision'),key=screenplayDecisionKey(body),digest=screenplayJournalDigest(body),business=screenplayDecisionBusiness(body);
    return this.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_projects:screenplay-decision',...screenplayScopeValues(body.scope),body.actor.key,body.requestId])]);
      const previous=await this.decision(client,key);if(previous){if(previous.businessDigest!==business)throw new ProjectApplicationError('CONFLICT','screenplay decision identity');return previous;}
      const source=await client.query<{tenant_id:string;project_id:string;formal_tenant_id:string;formal_project_id:string;change_id:string}>('SELECT tenant_id,project_id,formal_tenant_id,formal_project_id,change_id FROM camery_screenplay.native_bindings WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND change_id=$3',[body.target.tenantId,body.target.projectId,body.changeId]);
      const owner=one(source.rows);if(!owner)throw new ProjectApplicationError('NOT_FOUND','screenplay native decision owner');
      if(owner.tenant_id!==body.scope.tenantId||owner.project_id!==body.scope.projectId||owner.formal_tenant_id!==body.target.tenantId||owner.formal_project_id!==body.target.projectId||owner.change_id!==body.changeId)throw new ProjectApplicationError('STORAGE_FAILED','screenplay decision source binding');
      const rows=await client.query<ScreenplayJournalRow>(`INSERT INTO camery_projects.screenplay_decision_intents(tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,ir_tenant_id,ir_project_id,change_id,record,digest,business_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING ${decisionFields}`,[...screenplayScopeValues(body.scope),body.actor.kind,body.actor.key,body.actor.id,body.requestId,body.target.tenantId,body.target.projectId,body.changeId,projectCommandJson(body,SCREENPLAY_JOURNAL_BYTES),digest,business]);
      const row=one(rows.rows);if(!row)throw new ProjectApplicationError('STORAGE_FAILED','insert screenplay decision');const saved=screenplayDecisionRecord(row,key);if(saved.digest!==digest)throw new ProjectApplicationError('STORAGE_FAILED','inserted screenplay decision binding');return saved;
    });
  }
  private async preparation(client:QueryClient,intent:ScreenplayProjectIntent):Promise<ScreenplayProjectReceipt|null>{
    const rows=await client.query<ScreenplayReceiptRow>('SELECT record,digest,intent_digest FROM camery_projects.screenplay_candidate_receipts WHERE tenant_id=$1 AND project_id=$2 AND application_id=$3',[...screenplayScopeValues(intent.scope),intent.applicationId]),row=one(rows.rows);return row?screenplayReceiptRecord(row,intent):null;
  }
  private async decisionReceipt(client:QueryClient,intent:ScreenplayProjectDecision):Promise<ScreenplayProjectReceipt|null>{
    const rows=await client.query<ScreenplayReceiptRow>('SELECT record,digest,intent_digest FROM camery_projects.screenplay_decision_receipts WHERE tenant_id=$1 AND project_id=$2 AND actor_kind=$3 AND actor_key=$4 AND request_id=$5',[...screenplayScopeValues(intent.scope),intent.actor.kind,intent.actor.key,intent.requestId]),row=one(rows.rows);return row?screenplayReceiptRecord(row,intent):null;
  }
  async readPreparationReceipt(input:unknown){const key=capture(ScreenplayProjectIntentKeySchema,input,'screenplay preparation key');return safe('read screenplay preparation receipt',async()=>{const intent=await this.candidate(this.pool,key);return intent?this.preparation(this.pool,intent):null;});}
  async readDecisionReceipt(input:unknown){const key=capture(ScreenplayProjectDecisionKeySchema,input,'screenplay decision receipt key');return safe('read screenplay decision receipt',async()=>{const intent=await this.decision(this.pool,key);return intent?this.decisionReceipt(this.pool,intent):null;});}
  preparationReceiptWriter(input:ScreenplayProjectIntent,executionInput:unknown,host:ScreenplayHost):VersionTransactionReceipt{
    const intent=captureScreenplayProjectIntent(input),execution=captureScreenplayExecution(executionInput),request=execution.mapping.request;
    return async(client,result,context)=>safe('write screenplay preparation receipt',async()=>{
      screenplayPreparationExecution(intent,request,result,context);await screenplayExecutionProof(client,intent,execution,host);const receipt=screenplayActualReceipt(intent.changeId,intent.target,request,result),digest=projectCommandDigest({intentDigest:intent.digest,receipt},SCREENPLAY_RECEIPT_BYTES);
      await client.query('INSERT INTO camery_projects.screenplay_candidate_receipts(tenant_id,project_id,application_id,intent_digest,record,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING',[...screenplayScopeValues(intent.scope),intent.applicationId,intent.digest,projectCommandJson(receipt,SCREENPLAY_RECEIPT_BYTES),digest]);
      const saved=await this.preparation(client,intent);if(!saved||projectCommandDigest(saved,SCREENPLAY_RECEIPT_BYTES)!==projectCommandDigest(receipt,SCREENPLAY_RECEIPT_BYTES))throw new ProjectApplicationError('CONFLICT','screenplay immutable preparation receipt');
    });
  }
  decisionReceiptWriter(input:ScreenplayProjectDecision,executionInput:unknown,host:ScreenplayHost):VersionTransactionReceipt{
    const intent=captureScreenplayProjectDecision(input),execution=captureScreenplayExecution(executionInput),request=execution.mapping.request;if(request.id!==intent.changeId)throw new ProjectApplicationError('STORAGE_FAILED','screenplay decision request identity');
    return async(client,result,context)=>safe('write screenplay decision receipt',async()=>{
      const receipt=screenplayActualReceipt(intent.changeId,intent.target,request,result);screenplayDecisionExecution(intent,receipt,context);await screenplayExecutionProof(client,intent,execution,host);
      await client.query('INSERT INTO camery_projects.screenplay_decision_receipts(tenant_id,project_id,actor_kind,actor_key,request_id,intent_digest,record,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING',[...screenplayScopeValues(intent.scope),intent.actor.kind,intent.actor.key,intent.requestId,intent.digest,projectCommandJson(receipt,SCREENPLAY_RECEIPT_BYTES),projectCommandDigest({intentDigest:intent.digest,receipt},SCREENPLAY_RECEIPT_BYTES)]);
      const saved=await this.decisionReceipt(client,intent);if(!saved)throw new ProjectApplicationError('STORAGE_FAILED','screenplay decision receipt insertion');
      const historical=context.operation==='adopt'&&context.replayed&&saved.status==='adopted'&&receipt.status==='adopted'&&saved.issues.length===0&&receipt.issues.length===0&&projectCommandDigest(saved.adoption,SCREENPLAY_RECEIPT_BYTES)===projectCommandDigest(receipt.adoption,SCREENPLAY_RECEIPT_BYTES);
      if(projectCommandDigest(saved,SCREENPLAY_RECEIPT_BYTES)!==projectCommandDigest(receipt,SCREENPLAY_RECEIPT_BYTES)&&!historical)throw new ProjectApplicationError('CONFLICT','screenplay immutable decision receipt');
    });
  }
}

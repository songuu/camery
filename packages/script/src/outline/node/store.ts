import type { Pool,PoolClient } from 'pg';
import { z } from 'zod';
import { canonical,MethodRegistry } from '@camery/methods';
import { Id } from '../../contracts.js';
import { canonicalTime } from '../../reviewed.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OUTLINE_ENVELOPE_BYTES } from '../generation-contracts.js';
import type { OutlineCandidate,OutlineReviewHost,ReviewedOutline,RejectedOutline } from '../generation-contracts.js';
import { captureOutlineBrief,validateOutlineBrief } from './brief.js';
import { copy,hash } from './data.js';
import { createOutlineMethodPack } from './method-assets.js';
import { captureOutlineReviewHost,reviewOutline,rejectOutline,validateReviewedOutline,validateRejectedOutline } from './review.js';
import { GetOutlineBriefSchema,OutlineBriefKeySchema,OutlineKeySchema,OutlineRunEnvelope,PutOutlineBriefSchema,StartOutlineSchema,outlineExecution,outlineRunDigest,validateOutlineRun,validateOutlineRunCandidate as boundCandidate } from './persistence-contracts.js';
import type { OutlineBriefKey,OutlineRun,OutlineRunKey,OutlineStore,OutlineProgress,StoredOutlineBrief } from './persistence-contracts.js';
import { createOutlineSourceTransaction } from './source-transaction.js';
import type { OutlineSourceTransaction } from './source-transaction.js';

type BriefRow={tenant_id:string;project_id:string;brief_id:string;revision:string|number;actor_id:string;digest:string;request_digest:string;record:unknown;created_at:Date|string};
type RunRow={tenant_id:string;project_id:string;run_id:string;brief_id:string;brief_revision:string|number;brief_digest:string;source_digest:string;digest:string;request_digest:string;record:unknown;created_at:Date|string};
type CandidateRow={tenant_id:string;project_id:string;run_id:string;digest:string;record:unknown};
type ReviewRow=CandidateRow&{status:string;request_digest:string};
type Review=ReviewedOutline|RejectedOutline;
const briefKeys=(key:OutlineBriefKey)=>[key.tenantId,key.projectId,key.briefId];
const runKeys=(key:OutlineRunKey)=>[key.tenantId,key.projectId,key.runId];
const briefFields='tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record,created_at';
const runFields='tenant_id,project_id,run_id,brief_id,brief_revision,brief_digest,source_digest,digest,request_digest,record,created_at';
const failed=(operation:string):never=>{throw new OutlineError('STORAGE_FAILED',operation,'storage');};
function timestamp(value:Date|string):string{const at=value instanceof Date?value.toISOString():value;if(!canonicalTime(at))failed('timestamp');return at;}
function requestDigest(run:OutlineRun):string{return hash({briefId:run.brief.briefId,expectedRevision:run.brief.revision,expectedBriefDigest:run.brief.digest,source:run.source.descriptor,execution:run.execution,method:run.method});}
function reviewRequest(review:Review):string{return review.status==='reviewed'?hash({status:review.status,candidateDigest:review.candidateDigest,output:review.output,ablations:review.ablations,waivers:review.waivers,actorId:review.actorId}):hash({status:review.status,candidateDigest:review.candidateDigest,reason:review.reason,actorId:review.actorId});}
function checkScope(row:{tenant_id:string;project_id:string;run_id:string},key:OutlineRunKey):void{if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.run_id!==key.runId)failed('row scope');}
function decodeBrief(row:BriefRow,key:OutlineBriefKey,revision?:number):StoredOutlineBrief{
  try{
    const brief=validateOutlineBrief(row.record);const actorId=capture(Id,row.actor_id,'stored author');
    if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.brief_id!==key.briefId||brief.tenantId!==key.tenantId||brief.projectId!==key.projectId||brief.briefId!==key.briefId||brief.revision!==Number(row.revision)
      ||revision!==undefined&&brief.revision!==revision||row.digest!==brief.digest||row.request_digest!==hash({brief,actorId}))failed('brief columns');
    return deepFreeze({brief,actorId,createdAt:timestamp(row.created_at)});
  }catch{return failed('stored brief');}
}
function decodeRun(row:RunRow,key:OutlineRunKey):OutlineRun{
  try{
    checkScope(row,key);const record=capture(OutlineRunEnvelope.omit({createdAt:true}),row.record,'stored run',OUTLINE_ENVELOPE_BYTES);
    const run=validateOutlineRun(key,{...record,createdAt:timestamp(row.created_at)});
    if(row.brief_id!==run.brief.briefId||Number(row.brief_revision)!==run.brief.revision||row.brief_digest!==run.brief.digest||row.source_digest!==run.source.digest||row.digest!==run.digest||row.request_digest!==requestDigest(run))failed('run columns');return run;
  }catch{return failed('stored run');}
}

/** Append-only internal repository. The host owns authentication; source JSON can only come from the trusted transaction reader. */
export class PostgresOutlineStore implements OutlineStore {
  private readonly source:OutlineSourceTransaction;
  constructor(private readonly pool:Pool,source?:OutlineSourceTransaction){this.source=source??createOutlineSourceTransaction(pool);}
  private async transaction<T>(key:OutlineRunKey|null,brief:OutlineBriefKey|null,action:(client:PoolClient)=>Promise<T>):Promise<T>{
    let client:PoolClient;try{client=await this.pool.connect();}catch{return failed('connection');}let destroy=false;
    try{
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Outline locks are outer locks: source domains never request them in reverse order.
      if(brief)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_outline:brief',...briefKeys(brief)])]);
      if(key)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_outline:run',...runKeys(key)])]);
      const result=await action(client);await client.query('COMMIT');return result;
    }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;failed('rollback');}if(error instanceof OutlineError)throw error;return failed('transaction');}
    finally{try{client.release(destroy);}catch{failed('release');}}
  }
  private async brief(client:PoolClient,key:OutlineBriefKey,revision?:number):Promise<StoredOutlineBrief|null>{
    const values:unknown[]=briefKeys(key);if(revision!==undefined)values.push(revision);
    const result=await client.query<BriefRow>(`SELECT ${briefFields} FROM camery_outline.briefs WHERE tenant_id=$1 AND project_id=$2 AND brief_id=$3${revision===undefined?' ORDER BY revision DESC LIMIT 1':' AND revision=$4'}`,values);
    if(result.rows.length>1)failed('brief cardinality');return result.rows[0]?decodeBrief(result.rows[0],key,revision):null;
  }
  private async run(client:PoolClient,key:OutlineRunKey):Promise<OutlineRun|null>{
    const result=await client.query<RunRow>(`SELECT ${runFields} FROM camery_outline.runs WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3`,runKeys(key));
    if(result.rows.length>1)failed('run cardinality');if(!result.rows[0])return null;
    const run=decodeRun(result.rows[0],key);
    // The FK proves only key existence; the actual immutable parent must match the embedded writing snapshot.
    const parent=await this.brief(client,{tenantId:key.tenantId,projectId:key.projectId,briefId:run.brief.briefId},run.brief.revision);
    if(parent?.brief.digest!==run.brief.digest)failed('stored run parent');return run;
  }
  private async requiredRun(client:PoolClient,key:OutlineRunKey):Promise<OutlineRun>{const run=await this.run(client,key);if(!run)throw new OutlineError('NOT_FOUND','outline run','run');return run;}
  private async progress(client:PoolClient,key:OutlineRunKey):Promise<OutlineProgress>{
    const run=await this.requiredRun(client,key);let candidate:OutlineCandidate|null=null,review:Review|null=null;
    try{
      const candidates=await client.query<CandidateRow>('SELECT tenant_id,project_id,run_id,digest,record FROM camery_outline.candidates WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',runKeys(key));
      if(candidates.rows.length>1)failed('candidate cardinality');const row=candidates.rows[0];if(row){checkScope(row,key);candidate=boundCandidate(run,row.record);if(row.digest!==candidate.digest)failed('candidate digest');}
      const reviews=await client.query<ReviewRow>('SELECT tenant_id,project_id,run_id,status,request_digest,digest,record FROM camery_outline.reviews WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',runKeys(key));
      if(reviews.rows.length>1)failed('review cardinality');const audit=reviews.rows[0];if(audit){
        checkScope(audit,key);if(!candidate)failed('review candidate');
        if(audit.status==='reviewed')review=validateReviewedOutline(run.brief,run.source,candidate,audit.record);
        else if(audit.status==='rejected')review=validateRejectedOutline(run.brief,run.source,candidate,audit.record);
        else failed('review status');
        if(!review||review.digest!==audit.digest||reviewRequest(review)!==audit.request_digest)failed('review digest');
      }
    }catch{return failed('stored progress');}
    return deepFreeze({run,candidate,review});
  }
  async putBrief(input:unknown):Promise<StoredOutlineBrief>{
    const command=capture(PutOutlineBriefSchema,input,'brief write',16384);const {expectedRevision,actorId,...fields}=command;const brief=captureOutlineBrief({...fields,revision:expectedRevision+1});
    const key={tenantId:brief.tenantId,projectId:brief.projectId,briefId:brief.briefId};
    return this.transaction(null,key,async client=>{
      const prior=await this.brief(client,key,brief.revision);if(prior){if(prior.brief.digest!==brief.digest||prior.actorId!==actorId)throw new OutlineError('CONFLICT','brief revision identity','brief');return prior;}
      const latest=await this.brief(client,key);if((latest?.brief.revision??0)!==expectedRevision)throw new OutlineError('CONFLICT','latest brief','brief');
      const result=await client.query<BriefRow>(`INSERT INTO camery_outline.briefs(tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING ${briefFields}`,[...briefKeys(key),brief.revision,actorId,brief.digest,hash({brief,actorId}),canonical(brief)]);
      if(result.rows.length!==1)failed('insert brief');return decodeBrief(result.rows[0]!,key,brief.revision);
    });
  }
  async getBrief(input:z.infer<typeof GetOutlineBriefSchema>):Promise<StoredOutlineBrief>{
    const command=capture(GetOutlineBriefSchema,input,'brief read',2048);const {revision,...key}=command;
    return this.transaction(null,key,async client=>{const found=await this.brief(client,key,revision);if(!found)throw new OutlineError('NOT_FOUND','outline brief','brief');return found;});
  }
  async start(input:unknown):Promise<OutlineRun>{
    const command=capture(StartOutlineSchema,input,'start outline',16384);const execution=outlineExecution(command.execution);
    const key={tenantId:command.tenantId,projectId:command.projectId,runId:command.runId};const briefKey={tenantId:key.tenantId,projectId:key.projectId,briefId:command.briefId};
    if(command.source.tenantId!==key.tenantId||command.source.projectId!==key.projectId)throw new OutlineError('FORBIDDEN','source scope','source');
    const method=new MethodRegistry().register(createOutlineMethodPack());const request=hash({briefId:command.briefId,expectedRevision:command.expectedRevision,expectedBriefDigest:command.expectedBriefDigest,source:command.source,execution,method});
    return this.transaction(key,briefKey,async client=>{
      const prior=await this.run(client,key);if(prior){if(requestDigest(prior)!==request)throw new OutlineError('CONFLICT','run identity','run');return prior;}
      const saved=await this.brief(client,briefKey);if(!saved||saved.brief.revision!==command.expectedRevision||saved.brief.digest!==command.expectedBriefDigest)throw new OutlineError('CONFLICT','current outline brief','brief');
      const source=await this.source(client,command.source);if(hash(source.descriptor)!==hash(command.source))throw new OutlineError('CONFLICT','transaction source binding','source');
      const body={version:1 as const,...key,brief:saved.brief,source,method,execution};const record={...body,digest:outlineRunDigest(body)};
      const result=await client.query<RunRow>(`INSERT INTO camery_outline.runs(tenant_id,project_id,run_id,brief_id,brief_revision,brief_digest,source_digest,digest,request_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING ${runFields}`,[...runKeys(key),saved.brief.briefId,saved.brief.revision,saved.brief.digest,source.digest,record.digest,request,canonical(record)]);
      if(result.rows.length!==1)failed('insert run');return decodeRun(result.rows[0]!,key);
    });
  }
  async read(input:OutlineRunKey):Promise<OutlineProgress>{const key=capture(OutlineKeySchema,input,'run key',2048);return this.transaction(key,null,client=>this.progress(client,key));}
  private async briefKey(key:OutlineRunKey):Promise<OutlineBriefKey>{
    try{const rows=await this.pool.query<{brief_id:string}>('SELECT brief_id FROM camery_outline.runs WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',runKeys(key));if(rows.rows.length===0)throw new OutlineError('NOT_FOUND','outline run','run');if(rows.rows.length!==1)failed('brief key cardinality');return capture(OutlineBriefKeySchema,{tenantId:key.tenantId,projectId:key.projectId,briefId:rows.rows[0]!.brief_id},'run brief key',2048);}
    catch(error){if(error instanceof OutlineError&&error.code==='NOT_FOUND')throw error;return failed('brief key');}
  }
  private async current(client:PoolClient,run:OutlineRun):Promise<boolean>{
    const saved=await this.brief(client,{tenantId:run.tenantId,projectId:run.projectId,briefId:run.brief.briefId});if(saved?.brief.digest!==run.brief.digest)return false;
    try{const source=await this.source(client,run.source.descriptor);return source.digest===run.source.digest;}
    catch(error){if(error instanceof OutlineError&&['CONFLICT','INCOMPLETE','NOT_FOUND'].includes(error.code))return false;throw error;}
  }
  async isCurrent(input:OutlineRunKey):Promise<boolean>{const key=capture(OutlineKeySchema,input,'run key',2048);const brief=await this.briefKey(key);return this.transaction(key,brief,async client=>this.current(client,await this.requiredRun(client,key)));}
  async saveCandidate(input:OutlineRunKey,supplied:OutlineCandidate):Promise<OutlineCandidate>{
    const key=capture(OutlineKeySchema,input,'run key',2048),snapshot=copy(supplied);
    return this.transaction(key,null,async client=>{
      const progress=await this.progress(client,key),candidate=boundCandidate(progress.run,snapshot);
      if(progress.candidate){if(hash(progress.candidate)!==hash(candidate))throw new OutlineError('CONFLICT','candidate identity','candidate');return progress.candidate;}
      await client.query('INSERT INTO camery_outline.candidates(tenant_id,project_id,run_id,digest,record) VALUES($1,$2,$3,$4,$5::jsonb)',[...runKeys(key),candidate.digest,canonical(candidate)]);return candidate;
    });
  }
  async review(input:OutlineRunKey,decision:unknown,suppliedHost:OutlineReviewHost):Promise<ReviewedOutline>{
    const key=capture(OutlineKeySchema,input,'run key',2048),snapshot=copy(decision),host=captureOutlineReviewHost(suppliedHost);const brief=await this.briefKey(key);
    return this.transaction(key,brief,async client=>{
      const progress=await this.progress(client,key);if(!progress.candidate)throw new OutlineError('INCOMPLETE','review candidate','candidate');
      const proposed=reviewOutline(progress.run.brief,progress.run.source,progress.candidate,snapshot,host);
      if(progress.review){if(progress.review.status!=='reviewed'||reviewRequest(progress.review)!==reviewRequest(proposed))throw new OutlineError('CONFLICT','review identity','review');return progress.review;}
      if(!await this.current(client,progress.run))throw new OutlineError('CONFLICT','current review source','source');
      await this.insertReview(client,key,proposed);return proposed;
    });
  }
  async reject(input:OutlineRunKey,reason:unknown,suppliedHost:OutlineReviewHost):Promise<RejectedOutline>{
    const key=capture(OutlineKeySchema,input,'run key',2048),snapshot=copy(reason),host=captureOutlineReviewHost(suppliedHost);
    return this.transaction(key,null,async client=>{
      const progress=await this.progress(client,key);if(!progress.candidate)throw new OutlineError('INCOMPLETE','rejection candidate','candidate');
      const proposed=rejectOutline(progress.run.brief,progress.run.source,progress.candidate,snapshot,host);
      if(progress.review){if(progress.review.status!=='rejected'||reviewRequest(progress.review)!==reviewRequest(proposed))throw new OutlineError('CONFLICT','rejection identity','review');return progress.review;}
      await this.insertReview(client,key,proposed);return proposed;
    });
  }
  private async insertReview(client:PoolClient,key:OutlineRunKey,review:Review):Promise<void>{await client.query('INSERT INTO camery_outline.reviews(tenant_id,project_id,run_id,status,request_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[...runKeys(key),review.status,reviewRequest(review),review.digest,canonical(review)]);}
}

import type { Pool,PoolClient } from 'pg';
import { DevelopmentError,Stage } from '../contracts.js';
import type { DevelopmentCandidate,DevelopmentReviewHost,DevelopmentStage,ReviewedDevelopment,RejectedDevelopment } from '../contracts.js';
import { captureBrief,validateBrief } from '../brief.js';
import { validateFoundationCandidate,validateEpisodeCandidate } from '../development.js';
import { captureDevelopmentReviewHost,reviewFoundation,reviewEpisodes,rejectDevelopment } from '../review.js';
import { canonicalTime } from '../reviewed.js';
import { canonical,copy,freeze,hash,parse } from '../data.js';
import { BriefKeySchema,PutBriefSchema,ReadBriefSchema,RunKeySchema,StartRunSchema,developmentMethodPins,developmentRunDigest,developmentStageCallId,executionForDevelopment,validateDevelopmentRun } from './contracts.js';
import type { DevelopmentBriefKey,DevelopmentRunKey,DevelopmentRun,DevelopmentStore,DevelopmentProgress,StoredDevelopmentBrief,StartDevelopmentRun } from './contracts.js';

type BriefRow={tenant_id:string;project_id:string;brief_id:string;revision:string|number;actor_id:string;digest:string;request_digest:string;record:unknown;created_at:Date|string};
type RunRow={tenant_id:string;project_id:string;run_id:string;brief_id:string;brief_revision:string|number;brief_digest:string;methods:unknown;execution:unknown;digest:string;request_digest:string;created_at:Date|string};
type CandidateRow={stage:DevelopmentStage;upstream_digest:string|null;digest:string;record:unknown};
type ReviewRow={stage:DevelopmentStage;status:string;request_digest:string;digest:string;record:unknown};
type ReviewRecord=ReviewedDevelopment|RejectedDevelopment;
const runKeys=(key:DevelopmentRunKey)=>[key.tenantId,key.projectId,key.runId];
const briefKeys=(key:DevelopmentBriefKey)=>[key.tenantId,key.projectId,key.briefId];
const scope=(input:DevelopmentRunKey)=>freeze(parse(RunKeySchema,copy(input),'run scope'));
const startDigest=(command:Pick<StartDevelopmentRun,'briefId'|'expectedRevision'|'expectedBriefDigest'|'methods'|'execution'>)=>hash(command);
function reviewDigest(record:ReviewRecord):string{
  return record.status==='reviewed'?hash({action:'review',stage:record.stage,actorId:record.actorId,candidateDigest:record.candidateDigest,upstreamDigest:record.upstreamDigest,output:record.output}):hash({action:'reject',stage:record.stage,actorId:record.actorId,candidateDigest:record.candidateDigest,reason:record.reason});
}
function timestamp(input:Date|string):string{const value=input instanceof Date?input.toISOString():input;if(!canonicalTime(value))throw new Error();return value;}
function storedBrief(row:BriefRow,key:DevelopmentBriefKey,revision?:number):StoredDevelopmentBrief{
  try{
    const brief=validateBrief(row.record);const actorId=parse(BriefKeySchema.shape.briefId,row.actor_id,'stored author');const number=Number(row.revision);
    if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.brief_id!==key.briefId||brief.tenantId!==key.tenantId||brief.projectId!==key.projectId||brief.briefId!==key.briefId
      ||brief.revision!==number||revision!==undefined&&number!==revision||row.digest!==brief.digest||row.request_digest!==hash({brief,actorId}))throw new Error();
    return freeze({brief,actorId,createdAt:timestamp(row.created_at)});
  }catch{throw new DevelopmentError('STORAGE_FAILED','stored brief');}
}
function fixedPins(input:unknown):void{if(hash(input)!==hash(developmentMethodPins()))throw new DevelopmentError('CONFLICT','fixed development methods');}
function recordFor(run:DevelopmentRun,stage:DevelopmentStage,input:unknown,upstream:ReviewedDevelopment<'foundation'>|null):DevelopmentCandidate{
  if(stage==='episodes'&&!upstream)throw new DevelopmentError('INCOMPLETE','foundation review required');
  const candidate=stage==='foundation'?validateFoundationCandidate(run.brief,input):validateEpisodeCandidate(run.brief,upstream!,input);const profile=run.execution;const model=candidate.model;
  if(model.connectionId!==profile.connectionId||model.modeDigest!==profile.modeDigest||model.modelIdentity!==profile.modelIdentity||model.evidence!==profile.evidence||model.callId!==developmentStageCallId({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},stage))throw new DevelopmentError('INVALID_EVIDENCE','run model binding');
  return candidate;
}

/** Append-only service repository. Authentication, task leases and installation are separate authorities. */
export class PostgresDevelopmentStore implements DevelopmentStore{
  constructor(private readonly pool:Pool){}
  private async transaction<T>(run:DevelopmentRunKey|null,brief:DevelopmentBriefKey|null,action:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect().catch(()=>{throw new DevelopmentError('STORAGE_FAILED','database connection');});let destroy=false;
    try{
      await client.query('BEGIN');
      // Every transaction that needs both locks takes the brief first; run-only saves never acquire it later.
      if(brief)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_script:brief',...briefKeys(brief)])]);
      if(run)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_script:run',...runKeys(run)])]);
      const result=await action(client);await client.query('COMMIT');return result;
    }catch(error){
      try{await client.query('ROLLBACK');}catch{destroy=true;throw new DevelopmentError('STORAGE_FAILED','database rollback');}
      if(error instanceof DevelopmentError)throw error;throw new DevelopmentError('STORAGE_FAILED','database transaction');
    // oxlint-disable-next-line eslint/no-unsafe-finally -- A release failure is an unavailable storage result, never a raw driver exception.
    }finally{try{client.release(destroy);}catch{throw new DevelopmentError('STORAGE_FAILED','database release');}}
  }
  private async brief(client:PoolClient,key:DevelopmentBriefKey,revision?:number):Promise<StoredDevelopmentBrief|null>{
    const values:unknown[]=briefKeys(key);if(revision!==undefined)values.push(revision);
    const result=await client.query<BriefRow>(`SELECT tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record,created_at FROM camery_script.briefs WHERE tenant_id=$1 AND project_id=$2 AND brief_id=$3${revision===undefined?' ORDER BY revision DESC LIMIT 1':' AND revision=$4'}`,values);
    return result.rows[0]?storedBrief(result.rows[0],key,revision):null;
  }
  async putBrief(input:unknown):Promise<StoredDevelopmentBrief>{
    const command=freeze(parse(PutBriefSchema,copy(input),'brief write'));const {expectedRevision,actorId,...fields}=command;const brief=captureBrief({...fields,revision:expectedRevision+1});
    const key={tenantId:brief.tenantId,projectId:brief.projectId,briefId:brief.briefId};
    return this.transaction(null,key,async client=>{
      const existing=await this.brief(client,key,brief.revision);
      if(existing){if(existing.brief.digest!==brief.digest||existing.actorId!==actorId)throw new DevelopmentError('CONFLICT','brief revision identity');return existing;}
      const current=await this.brief(client,key);if((current?.brief.revision??0)!==expectedRevision)throw new DevelopmentError('CONFLICT','current brief revision');
      const rows=await client.query<BriefRow>('INSERT INTO camery_script.briefs(tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING tenant_id,project_id,brief_id,revision,actor_id,digest,request_digest,record,created_at',
        [...briefKeys(key),brief.revision,actorId,brief.digest,hash({brief,actorId}),canonical(brief)]);
      if(!rows.rows[0])throw new DevelopmentError('STORAGE_FAILED','brief insertion');return storedBrief(rows.rows[0],key,brief.revision);
    });
  }
  async getBrief(input:Parameters<DevelopmentStore['getBrief']>[0]):Promise<StoredDevelopmentBrief>{
    const command=freeze(parse(ReadBriefSchema,copy(input),'brief read'));const key={tenantId:command.tenantId,projectId:command.projectId,briefId:command.briefId};
    return this.transaction(null,key,async client=>{const result=await this.brief(client,key,command.revision);if(!result)throw new DevelopmentError('NOT_FOUND','brief');return result;});
  }
  private async run(client:PoolClient,key:DevelopmentRunKey):Promise<DevelopmentRun|null>{
    const rows=await client.query<RunRow>('SELECT tenant_id,project_id,run_id,brief_id,brief_revision,brief_digest,methods,execution,digest,request_digest,created_at FROM camery_script.runs WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',runKeys(key));const row=rows.rows[0];if(!row)return null;
    try{
      const stored=await this.brief(client,{tenantId:key.tenantId,projectId:key.projectId,briefId:row.brief_id},Number(row.brief_revision));if(!stored)throw new Error();
      const run=validateDevelopmentRun(key,{tenantId:row.tenant_id,projectId:row.project_id,runId:row.run_id,brief:stored.brief,methods:row.methods,execution:row.execution,digest:row.digest,createdAt:timestamp(row.created_at)});
      if(row.brief_digest!==run.brief.digest||row.request_digest!==startDigest({briefId:run.brief.briefId,expectedRevision:run.brief.revision,expectedBriefDigest:run.brief.digest,methods:run.methods,execution:run.execution}))throw new Error();return run;
    }catch{throw new DevelopmentError('STORAGE_FAILED','stored run');}
  }
  private async requiredRun(client:PoolClient,key:DevelopmentRunKey):Promise<DevelopmentRun>{const run=await this.run(client,key);if(!run)throw new DevelopmentError('NOT_FOUND','development run');return run;}
  async start(input:unknown):Promise<DevelopmentRun>{
    const raw=parse(StartRunSchema,copy(input),'run start');const command=freeze({...raw,execution:executionForDevelopment(raw.execution)});fixedPins(command.methods);
    const key=scope({tenantId:command.tenantId,projectId:command.projectId,runId:command.runId});const source={tenantId:key.tenantId,projectId:key.projectId,briefId:command.briefId};
    const requestDigest=startDigest({briefId:command.briefId,expectedRevision:command.expectedRevision,expectedBriefDigest:command.expectedBriefDigest,methods:command.methods,execution:command.execution});
    return this.transaction(key,source,async client=>{
      const existing=await this.run(client,key);
      if(existing){if(requestDigest!==startDigest({briefId:existing.brief.briefId,expectedRevision:existing.brief.revision,expectedBriefDigest:existing.brief.digest,methods:existing.methods,execution:existing.execution}))throw new DevelopmentError('CONFLICT','run request identity');return existing;}
      const current=await this.brief(client,source);if(!current)throw new DevelopmentError('NOT_FOUND','brief');
      if(current.brief.revision!==command.expectedRevision||current.brief.digest!==command.expectedBriefDigest)throw new DevelopmentError('CONFLICT','current brief');
      const fields={...key,brief:current.brief,methods:command.methods,execution:command.execution};const digest=developmentRunDigest(fields);
      await client.query('INSERT INTO camery_script.runs(tenant_id,project_id,run_id,brief_id,brief_revision,brief_digest,methods,execution,digest,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)',
        [...runKeys(key),command.briefId,current.brief.revision,current.brief.digest,canonical(command.methods),canonical(command.execution),digest,requestDigest]);return this.requiredRun(client,key);
    });
  }
  private audit(run:DevelopmentRun,candidate:DevelopmentCandidate,row:ReviewRow,upstream:ReviewedDevelopment<'foundation'>|null):ReviewRecord{
    const raw=copy(row.record) as Record<string,unknown>;const host={tenantId:run.tenantId,projectId:run.projectId,actor:{kind:'human' as const,id:raw['actorId'] as string},at:raw['at'] as string,authorize:()=>true};let record:ReviewRecord;
    // Internal audit reconstruction grants no current caller permission; new mutations always use the real host below.
    if(row.status==='rejected')record=rejectDevelopment(run.brief,candidate,raw['reason'],host,upstream??undefined);
    else if(row.status==='reviewed')record=row.stage==='foundation'?reviewFoundation(run.brief,candidate as DevelopmentCandidate<'foundation'>,{candidateDigest:raw['candidateDigest'],output:raw['output']},host):reviewEpisodes(run.brief,upstream!,candidate as DevelopmentCandidate<'episodes'>,{candidateDigest:raw['candidateDigest'],output:raw['output']},host);
    else throw new Error();
    if(record.stage!==row.stage||record.digest!==row.digest||reviewDigest(record)!==row.request_digest||canonical(record)!==canonical(raw))throw new Error();return record;
  }
  private async progress(client:PoolClient,key:DevelopmentRunKey):Promise<DevelopmentProgress>{
    const run=await this.requiredRun(client,key);
    const candidates=await client.query<CandidateRow>('SELECT stage,upstream_digest,digest,record FROM camery_script.candidates WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',runKeys(key));
    const reviews=await client.query<ReviewRow>('SELECT stage,status,request_digest,digest,record FROM camery_script.reviews WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',runKeys(key));
    try{
      if(candidates.rows.length>2||reviews.rows.length>2)throw new Error();const byStage=new Map<DevelopmentStage,CandidateRow>();const auditByStage=new Map<DevelopmentStage,ReviewRow>();
      for(const row of candidates.rows){const stage=parse(Stage,row.stage,'stored candidate phase');if(byStage.has(stage))throw new Error();byStage.set(stage,row);}
      for(const row of reviews.rows){const stage=parse(Stage,row.stage,'stored review phase');if(auditByStage.has(stage))throw new Error();auditByStage.set(stage,row);}
      const load=(stage:DevelopmentStage,upstream:ReviewedDevelopment<'foundation'>|null)=>{
        const row=byStage.get(stage);const audit=auditByStage.get(stage);let candidate:DevelopmentCandidate|null=null;let review:ReviewRecord|null=null;
        if(row){candidate=recordFor(run,stage,row.record,upstream);if(candidate.digest!==row.digest||candidate.upstreamDigest!==row.upstream_digest)throw new Error();}
        if(audit){if(!candidate)throw new Error();review=this.audit(run,candidate,audit,upstream);}return {candidate,review};
      };
      const foundation=load('foundation',null);const upstream=foundation.review?.status==='reviewed'?foundation.review as ReviewedDevelopment<'foundation'>:null;const episodes=load('episodes',upstream);
      return freeze({run,foundation,episodes}) as DevelopmentProgress;
    }catch{throw new DevelopmentError('STORAGE_FAILED','stored development progress');}
  }
  async read(input:DevelopmentRunKey):Promise<DevelopmentProgress>{const key=scope(input);return this.transaction(key,null,client=>this.progress(client,key));}
  private async sourceKey(key:DevelopmentRunKey):Promise<DevelopmentBriefKey>{
    try{const result=await this.pool.query<{brief_id:string}>('SELECT brief_id FROM camery_script.runs WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',runKeys(key));if(!result.rows[0])throw new DevelopmentError('NOT_FOUND','development run');return freeze(parse(BriefKeySchema,{tenantId:key.tenantId,projectId:key.projectId,briefId:result.rows[0].brief_id},'run brief scope'));}
    catch(error){if(error instanceof DevelopmentError&&error.code==='NOT_FOUND')throw error;throw new DevelopmentError('STORAGE_FAILED','run brief lookup');}
  }
  async isCurrent(input:DevelopmentRunKey):Promise<boolean>{
    const key=scope(input);const source=await this.sourceKey(key);return this.transaction(key,source,async client=>{const run=await this.requiredRun(client,key);const current=await this.brief(client,source);return current?.brief.digest===run.brief.digest;});
  }
  async saveCandidate(input:DevelopmentRunKey,supplied:DevelopmentCandidate):Promise<DevelopmentCandidate>{
    const key=scope(input);const snapshot=copy(supplied);const stage=parse(Stage,(snapshot as {stage?:unknown})?.stage,'candidate phase');
    return this.transaction(key,null,async client=>{
      const progress=await this.progress(client,key);const upstream=progress.foundation.review?.status==='reviewed'?progress.foundation.review as ReviewedDevelopment<'foundation'>:null;const candidate=recordFor(progress.run,stage,snapshot,upstream);const previous=progress[stage].candidate;
      if(previous){if(previous.digest!==candidate.digest)throw new DevelopmentError('CONFLICT','stage candidate identity');return previous;}
      await client.query('INSERT INTO camery_script.candidates(tenant_id,project_id,run_id,stage,upstream_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[...runKeys(key),stage,candidate.upstreamDigest,candidate.digest,canonical(candidate)]);return candidate;
    });
  }
  private async insertReview(client:PoolClient,key:DevelopmentRunKey,record:ReviewRecord):Promise<void>{
    await client.query('INSERT INTO camery_script.reviews(tenant_id,project_id,run_id,stage,status,request_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[...runKeys(key),record.stage,record.status,reviewDigest(record),record.digest,canonical(record)]);
  }
  async review(input:DevelopmentRunKey,suppliedStage:DevelopmentStage,decision:unknown,suppliedHost:DevelopmentReviewHost):Promise<ReviewedDevelopment>{
    const key=scope(input);const stage=parse(Stage,suppliedStage,'review phase');const captured=copy(decision);const host=captureDevelopmentReviewHost(suppliedHost);const source=await this.sourceKey(key);
    return this.transaction(key,source,async client=>{
      const progress=await this.progress(client,key);const candidate=progress[stage].candidate;if(!candidate)throw new DevelopmentError('INCOMPLETE','stage candidate');
      const upstream=progress.foundation.review?.status==='reviewed'?progress.foundation.review as ReviewedDevelopment<'foundation'>:null;if(stage==='episodes'&&!upstream)throw new DevelopmentError('INCOMPLETE','foundation review');
      const proposed=stage==='foundation'?reviewFoundation(progress.run.brief,candidate as DevelopmentCandidate<'foundation'>,captured,host):reviewEpisodes(progress.run.brief,upstream!,candidate as DevelopmentCandidate<'episodes'>,captured,host);
      const previous=progress[stage].review;if(previous){if(previous.status!=='reviewed'||reviewDigest(previous)!==reviewDigest(proposed))throw new DevelopmentError('CONFLICT','review identity');return previous;}
      const current=await this.brief(client,source);if(current?.brief.digest!==progress.run.brief.digest)throw new DevelopmentError('CONFLICT','current brief');await this.insertReview(client,key,proposed);return proposed;
    });
  }
  async reject(input:DevelopmentRunKey,suppliedStage:DevelopmentStage,reason:unknown,suppliedHost:DevelopmentReviewHost):Promise<RejectedDevelopment>{
    const key=scope(input);const stage=parse(Stage,suppliedStage,'rejection phase');const captured=copy(reason);const host=captureDevelopmentReviewHost(suppliedHost);
    return this.transaction(key,null,async client=>{
      const progress=await this.progress(client,key);const candidate=progress[stage].candidate;if(!candidate)throw new DevelopmentError('INCOMPLETE','stage candidate');const upstream=progress.foundation.review?.status==='reviewed'?progress.foundation.review as ReviewedDevelopment<'foundation'>:null;
      const proposed=rejectDevelopment(progress.run.brief,candidate,captured,host,upstream??undefined);const previous=progress[stage].review;
      if(previous){if(previous.status!=='rejected'||reviewDigest(previous)!==reviewDigest(proposed))throw new DevelopmentError('CONFLICT','review identity');return previous;}
      await this.insertReview(client,key,proposed);return proposed;
    });
  }
}

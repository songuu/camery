import type {Pool,PoolClient} from 'pg';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {CONTINUITY_CANDIDATE_BYTES,CONTINUITY_DRAFT_BYTES,ContinuityDraftSchema,ContinuityError} from '../contracts.js';
import {createContinuityCandidate,validateContinuityCandidate} from './candidate.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
import {authorizeContinuityHost,reviewContinuityCandidate,rejectContinuityCandidate,validateContinuityReview} from './review.js';
import {CONTINUITY_RECORD_BYTES,ContinuityKeySchema,ContinuityPrepareSchema,ContinuityPreparationSchema,ContinuityReviewDecisionSchema,ContinuityRejectDecisionSchema,ContinuitySourceSelectionSchema} from './persistence-contracts.js';
import type {ContinuityKey,ContinuityPrepare,ContinuityPreparation,ContinuityProgress,ContinuityReview,ContinuityPredecessorResolver,ContinuityReviewDecision,ContinuityRejectDecision} from './persistence-contracts.js';
import {lockContinuityProject,readContinuitySource,readStoredContinuitySource} from './source.js';
import type {ContinuitySourceView} from './source.js';

const candidateFields='tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,episode_id,author_id,package_digest,context_digest,command_digest,digest,record,created_at';
const reviewFields='tenant_id,project_id,candidate_id,status,actor_id,request_digest,digest,record,created_at';
type Row=Record<string,unknown>;
const values=(key:ContinuityKey)=>[key.tenantId,key.projectId,key.candidateId];
const scopeFor=(key:ContinuityKey)=>({tenantId:key.tenantId,projectId:key.projectId});
function fail(operation:string):never{throw new ContinuityError('STORAGE_FAILED',operation,'storage');}
function rethrow(error:unknown,operation:string):never{let known=false;try{known=error instanceof ContinuityError;}catch{/* Driver prototype traps cannot become diagnostics. */}if(known)throw error;return fail(operation);}
function timestamp(value:unknown):string{const text=value instanceof Date?value.toISOString():value;if(typeof text!=='string'||new Date(text).toISOString()!==text)fail('stored timestamp');return text;}
function bound(row:Row,key:ContinuityKey):void{if(row['tenant_id']!==key.tenantId||row['project_id']!==key.projectId||row['candidate_id']!==key.candidateId)fail('stored scope');}
function preparationDigest(command:ContinuityPrepare,authorId:string):string{return continuityDigest({...command,authorId},CONTINUITY_RECORD_BYTES);}
function reviewDigest(status:'reviewed'|'rejected',decision:ContinuityReviewDecision|ContinuityRejectDecision,actorId:string):string{return continuityDigest({status,...decision,actorId},CONTINUITY_RECORD_BYTES);}
function requestFor(review:ContinuityReview){return review.status==='reviewed'?{candidateDigest:review.candidateDigest,draft:review.output.draft,waivers:review.waivers}:{candidateDigest:review.candidateDigest,reason:review.reason};}

/** Append-only authority boundary; construction never installs schemas or grants database permissions. */
export class PostgresContinuityStore{
  private readonly previousFor:ContinuityPredecessorResolver|undefined;
  constructor(private readonly pool:Pool,options:Readonly<{previousFor?:ContinuityPredecessorResolver}>={}){this.previousFor=options.previousFor;if(this.previousFor!==undefined&&typeof this.previousFor!=='function')throw new ContinuityError('INVALID_INPUT','predecessor authority','previousFor');}
  private async transaction<T>(operation:string,readonly:boolean,run:(client:PoolClient)=>Promise<T>):Promise<T>{
    let client:PoolClient;try{client=await this.pool.connect();}catch{return fail(operation+' connection');}let destroy=false,broken=false,listening=false;const onError=()=>{broken=true;};
    try{client.on('error',onError);listening=true;await client.query(readonly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');await client.query("SET LOCAL statement_timeout = '15s'");await client.query("SET LOCAL lock_timeout = '5s'");const result=await run(client);if(broken)fail(operation+' connection');await client.query('COMMIT');return result;}
    catch(error){if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;return fail(operation+' rollback');}return rethrow(error,operation);}
    finally{let cleanupFailed=false;try{client.removeListener('error',onError);}catch{destroy=true;cleanupFailed=true;}try{client.release(destroy||broken);}catch{cleanupFailed=true;}if(cleanupFailed)fail(operation+' release');}
  }
  private async lock(client:PoolClient,key:ContinuityKey){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_continuity:candidate',...values(key)])]);}
  private async row(client:PoolClient,key:ContinuityKey):Promise<Row|null>{const result=await client.query(`SELECT ${candidateFields} FROM camery_continuity.candidates WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3`,values(key));if(result.rows.length>1)fail('candidate cardinality');const row=result.rows[0] as Row|undefined;if(row)bound(row,key);return row??null;}
  private envelope(row:Row,key:ContinuityKey):ContinuityPreparation{
    try{
      bound(row,key);const record=captureContinuity(ContinuityPreparationSchema,row['record'],'stored preparation',CONTINUITY_RECORD_BYTES),{digest,...body}=record;
      const command={key:record.key,target:record.source.target,expectedSnapshotRevision:record.source.snapshotRevision,expectedPackageDigest:record.source.packageDigest,draft:record.candidate.draft};
      if(canonicalContinuity(record.key,2048)!==canonicalContinuity(key,2048)||record.source.target.tenantId!==row['formal_tenant_id']||record.source.target.projectId!==row['formal_project_id']||record.source.snapshotRevision!==Number(row['source_revision'])||record.source.episodeId!==row['episode_id']||record.authorId!==row['author_id']||record.source.packageDigest!==row['package_digest']||record.source.contextDigest!==row['context_digest']||record.commandDigest!==row['command_digest']||record.digest!==row['digest']||record.createdAt!==timestamp(row['created_at'])||continuityDigest(body,CONTINUITY_RECORD_BYTES)!==digest||preparationDigest(command,record.authorId)!==record.commandDigest||record.candidate.scope.tenantId!==key.tenantId||record.candidate.scope.projectId!==key.projectId||record.candidate.draft.episodeId!==record.source.episodeId||record.candidate.contextDigest!==record.source.contextDigest||record.previous!==null&&(record.previous.scope.tenantId!==key.tenantId||record.previous.scope.projectId!==key.projectId))fail('preparation columns');
      return freezeContinuity(record);
    }catch{return fail('stored preparation');}
  }
  private async load(client:PoolClient,key:ContinuityKey):Promise<{progress:ContinuityProgress;view:ContinuitySourceView}>{
    const row=await this.row(client,key);if(!row)throw new ContinuityError('NOT_FOUND','continuity candidate','candidateId');const preparation=this.envelope(row,key);let view:Awaited<ReturnType<typeof readStoredContinuitySource>>;
    try{view=await readStoredContinuitySource(client,{source:preparation.source,previous:preparation.previous});validateContinuityCandidate(view.context,preparation.candidate,view.previous?.ledger??null);}catch{return fail('stored candidate source');}
    const rows=await client.query(`SELECT ${reviewFields} FROM camery_continuity.reviews WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3`,values(key));if(rows.rows.length>1)fail('review cardinality');let review:ContinuityReview|null=null;
    if(rows.rows[0]){try{const audit=rows.rows[0] as Row;bound(audit,key);review=validateContinuityReview(view.context,preparation.candidate,audit['record'],view.previous?.ledger??null);if(review.status!==audit['status']||review.actorId!==audit['actor_id']||review.digest!==audit['digest']||review.at!==timestamp(audit['created_at'])||reviewDigest(review.status,requestFor(review),review.actorId)!==audit['request_digest'])fail('review columns');}catch{return fail('stored review');}}
    return {progress:freezeContinuity({preparation,review,current:view.current}),view};
  }
  async describeSource(input:unknown,hostInput:unknown):Promise<ContinuitySourceView>{const selection=freezeContinuity(captureContinuity(ContinuitySourceSelectionSchema,input,'source selection',2048));authorizeContinuityHost(hostInput,'continuity:read',selection.scope);return this.transaction('source',true,client=>readContinuitySource(client,selection,{previousFor:this.previousFor}));}
  async read(input:unknown,hostInput:unknown):Promise<ContinuityProgress>{const key=freezeContinuity(captureContinuity(ContinuityKeySchema,input,'candidate key',2048));authorizeContinuityHost(hostInput,'continuity:read',scopeFor(key));return this.transaction('read',true,async client=>(await this.load(client,key)).progress);}
  async prepare(input:unknown,hostInput:unknown):Promise<ContinuityProgress>{
    const command=freezeContinuity(captureContinuity(ContinuityPrepareSchema,input,'prepare command',CONTINUITY_DRAFT_BYTES+8192));captureContinuity(ContinuityDraftSchema,command.draft,'prepare draft',CONTINUITY_DRAFT_BYTES);const host=authorizeContinuityHost(hostInput,'continuity:prepare',scopeFor(command.key)),request=preparationDigest(command,host.actor.id);
    return this.transaction('prepare',false,async client=>{
      const existing=await this.row(client,command.key);if(existing&&this.envelope(existing,command.key).commandDigest!==request)throw new ContinuityError('CONFLICT','candidate identity','candidateId');
      await lockContinuityProject(client,command.target);await this.lock(client,command.key);const prior=await this.row(client,command.key);if(prior){if(this.envelope(prior,command.key).commandDigest!==request)throw new ContinuityError('CONFLICT','candidate identity','candidateId');return (await this.load(client,command.key)).progress;}
      const view=await readContinuitySource(client,{scope:{tenantId:command.key.tenantId,projectId:command.key.projectId},target:command.target,episodeId:command.draft.episodeId},{previousFor:this.previousFor});
      if(view.source.snapshotRevision!==command.expectedSnapshotRevision||view.source.packageDigest!==command.expectedPackageDigest)throw new ContinuityError('CONFLICT','current source','source');
      const candidate=createContinuityCandidate({tenantId:command.key.tenantId,projectId:command.key.projectId},view.context,command.draft,view.previous?.ledger??null),body={version:1 as const,key:command.key,source:view.source,previous:view.previous,authorId:host.actor.id,createdAt:host.at,commandDigest:request,candidate},record=freezeContinuity(captureContinuity(ContinuityPreparationSchema,{...body,digest:continuityDigest(body,CONTINUITY_RECORD_BYTES)},'preparation',CONTINUITY_RECORD_BYTES));
      const result=await client.query(`INSERT INTO camery_continuity.candidates(${candidateFields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) RETURNING ${candidateFields}`,[...values(command.key),command.target.tenantId,command.target.projectId,view.source.snapshotRevision,view.source.episodeId,record.authorId,view.source.packageDigest,view.source.contextDigest,request,record.digest,canonicalContinuity(record,CONTINUITY_RECORD_BYTES),record.createdAt]);
      if(result.rows.length!==1)fail('insert candidate');this.envelope(result.rows[0] as Row,command.key);return (await this.load(client,command.key)).progress;
    });
  }
  private async decide(action:'reviewed'|'rejected',keyInput:unknown,decisionInput:unknown,hostInput:unknown):Promise<ContinuityProgress>{
    const key=freezeContinuity(captureContinuity(ContinuityKeySchema,keyInput,'decision key',2048)),decision=freezeContinuity(action==='reviewed'?captureContinuity(ContinuityReviewDecisionSchema,decisionInput,'review decision',CONTINUITY_CANDIDATE_BYTES):captureContinuity(ContinuityRejectDecisionSchema,decisionInput,'reject decision',16384));if('draft' in decision)captureContinuity(ContinuityDraftSchema,decision.draft,'review draft',CONTINUITY_DRAFT_BYTES);const host=authorizeContinuityHost(hostInput,action==='reviewed'?'continuity:review':'continuity:reject',scopeFor(key)),request=reviewDigest(action,decision,host.actor.id);
    return this.transaction(action,false,async client=>{
      const row=await this.row(client,key);if(!row)throw new ContinuityError('NOT_FOUND','continuity candidate','candidateId');const record=this.envelope(row,key);await lockContinuityProject(client,record.source.target);await this.lock(client,key);const {progress,view}=await this.load(client,key);
      if(progress.review){if(reviewDigest(progress.review.status,requestFor(progress.review),progress.review.actorId)!==request)throw new ContinuityError('CONFLICT','review identity','candidateId');return progress;}
      if(action==='reviewed'){if(!progress.current)throw new ContinuityError('CONFLICT','current source','source');const fresh=await readContinuitySource(client,{scope:{tenantId:key.tenantId,projectId:key.projectId},target:record.source.target,episodeId:record.source.episodeId},{previousFor:this.previousFor});if(canonicalContinuity(fresh.source,16384)!==canonicalContinuity(record.source,16384))throw new ContinuityError('CONFLICT','current predecessor','previous');}
      const review=action==='reviewed'?reviewContinuityCandidate(view.context,record.candidate,decision,host,view.previous?.ledger??null):rejectContinuityCandidate(view.context,record.candidate,decision,host,view.previous?.ledger??null);
      const inserted=await client.query(`INSERT INTO camery_continuity.reviews(${reviewFields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING ${reviewFields}`,[...values(key),review.status,review.actorId,request,review.digest,canonicalContinuity(review,CONTINUITY_RECORD_BYTES),review.at]);if(inserted.rows.length!==1)fail('insert review');return (await this.load(client,key)).progress;
    });
  }
  async confirm(key:unknown,decision:unknown,host:unknown):Promise<ContinuityProgress>{return this.decide('reviewed',key,decision,host);}
  async reject(key:unknown,decision:unknown,host:unknown):Promise<ContinuityProgress>{return this.decide('rejected',key,decision,host);}
  /** Host-only source validation on the adopter's client; never commits, releases or creates another transaction. */
  async readForAdoption(client:PoolClient,input:unknown,hostInput:unknown):Promise<ContinuityProgress>{
    const key=freezeContinuity(captureContinuity(ContinuityKeySchema,input,'adoption key',2048));authorizeContinuityHost(hostInput,'continuity:review',scopeFor(key));
    try{const row=await this.row(client,key);if(!row)throw new ContinuityError('NOT_FOUND','continuity candidate','candidateId');const record=this.envelope(row,key);await lockContinuityProject(client,record.source.target);await this.lock(client,key);const {progress}=await this.load(client,key);if(progress.review?.status!=='reviewed')throw new ContinuityError('INCOMPLETE','reviewed source','review');if(!progress.current)throw new ContinuityError('CONFLICT','adoption current source','source');const fresh=await readContinuitySource(client,{scope:{tenantId:key.tenantId,projectId:key.projectId},target:record.source.target,episodeId:record.source.episodeId},{previousFor:this.previousFor});if(canonicalContinuity(fresh.source,16384)!==canonicalContinuity(record.source,16384))throw new ContinuityError('CONFLICT','adoption predecessor','previous');return progress;}catch(error){return rethrow(error,'adoption source');}
  }
}

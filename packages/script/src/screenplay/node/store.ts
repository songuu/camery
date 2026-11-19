import type {Pool,PoolClient} from 'pg';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,SCREENPLAY_CANDIDATE_BYTES,ScreenplayError} from '../contracts.js';
import {ScreenplayKeySchema,ScreenplayReviewDecisionSchema} from './contracts.js';
import type {ScreenplayKey,ScreenplayReview} from './contracts.js';
import {ScreenplayPrepareSchema,ScreenplayPreparationSchema} from './persistence-contracts.js';
import type {ScreenplayPreparation,ScreenplayProgress} from './persistence-contracts.js';
import {authorizeScreenplayHost} from './host.js';
import {createScreenplayCandidate,validateScreenplayCandidate,reviewScreenplayCandidate,validateScreenplayReview} from './review.js';
import {readScreenplaySource,readStoredScreenplaySource} from './source.js';
import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import type {PostgresOutlineStore} from '../../outline/node/store.js';
type Outline=Pick<PostgresOutlineStore,'readForAdoption'|'readHistoricalForAdoption'>;
const keys=(key:ScreenplayKey)=>[key.tenantId,key.projectId,key.candidateId];
const scopeFor=(key:ScreenplayKey)=>({tenantId:key.tenantId,projectId:key.projectId});
const equal=(a:unknown,b:unknown)=>canonicalContinuity(a,SCREENPLAY_CONTEXT_BYTES)===canonicalContinuity(b,SCREENPLAY_CONTEXT_BYTES);
const digest=(value:unknown)=>continuityDigest(value,SCREENPLAY_CONTEXT_BYTES);
function fail(code:ScreenplayError['code'],path:string):never{throw new ScreenplayError(code,'screenplay persistence',path);}
function safe(error:unknown):never{let known=false;try{known=error instanceof ScreenplayError;}catch{/* Opaque driver errors never provide public diagnostics. */}if(known)throw error;return fail('STORAGE_FAILED','storage');}

/** Append-only internal repository. Hosts supply actual human authority; request JSON never supplies source snapshots. */
export class PostgresScreenplayStore{
  constructor(private readonly pool:Pool,private readonly outline:Outline){}
  async describeSource(input:unknown,hostInput:unknown){
    const selection=captureScreenplay(ScreenplayPrepareSchema.pick({target:true,rules:true}).extend({scope:ScreenplayKeySchema.omit({candidateId:true}),episodeId:ScreenplayPrepareSchema.shape.draft.shape.episodeId}),input,'screenplay source selection',32768);
    authorizeScreenplayHost(hostInput,'screenplay:read',selection.scope);return this.transaction(client=>readScreenplaySource(client,selection,this.outline));
  }
  private async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>{
    let client:PoolClient;try{client=await this.pool.connect();}catch{return fail('STORAGE_FAILED','connection');}
    let broken=false,destroy=false,listening=false;const onError=()=>{broken=true;},healthy=()=>{if(broken)fail('STORAGE_FAILED','connection');};
    try{
      client.on('error',onError);listening=true;
      // Source locks must expose a writer that committed while we waited; inherited repeatable-read snapshots cannot do that.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query('SET LOCAL search_path = pg_catalog');healthy();
      const result=await action(client);healthy();await client.query('COMMIT');healthy();return result;
    }catch(error){if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;return fail('STORAGE_FAILED','rollback');}return safe(error);}
    finally{let failed=false;try{client.removeListener('error',onError);}catch{destroy=true;failed=true;}try{client.release(destroy||broken);}catch{failed=true;}
      // Always attempt release before surfacing a safe cleanup failure.
      if(failed)fail('STORAGE_FAILED','release');}
  }
  private async lock(client:PoolClient,key:ScreenplayKey):Promise<void>{await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0::pg_catalog.int8))',[JSON.stringify(['camery_screenplay:candidate',...keys(key)])]);}
  private async preparation(client:PoolClient,key:ScreenplayKey):Promise<ScreenplayPreparation|null>{
    const rows=await client.query('SELECT tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,context_digest,command_digest,digest,record FROM camery_screenplay.candidates WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',keys(key));
    if(!rows.rows.length)return null;if(rows.rows.length!==1)fail('STORAGE_FAILED','candidate cardinality');const row=rows.rows[0];
    const preparation=captureScreenplay(ScreenplayPreparationSchema,row.record,'stored screenplay preparation',SCREENPLAY_CONTEXT_BYTES),{digest:stored,...body}=preparation;
    if(!equal(preparation.key,key)||row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.candidate_id!==key.candidateId||row.formal_tenant_id!==preparation.source.native.target.tenantId||row.formal_project_id!==preparation.source.native.target.projectId||String(row.source_revision)!==String(preparation.source.native.snapshotRevision)||row.context_digest!==preparation.source.contextDigest||row.command_digest!==preparation.commandDigest||row.digest!==stored||digest(body)!==stored)fail('STORAGE_FAILED','candidate binding');
    const scope={tenantId:key.tenantId,projectId:key.projectId};
    await readStoredScreenplaySource(client,{scope,source:preparation.source,context:preparation.context,previous:preparation.previous},this.outline);
    const candidate=validateScreenplayCandidate(preparation.context,preparation.candidate);
    if(!equal(candidate.scope,scope)||candidate.contextDigest!==preparation.source.contextDigest)fail('STORAGE_FAILED','candidate source');
    const command={key,target:preparation.source.native.target,expectedSnapshotRevision:preparation.source.native.snapshotRevision,expectedPackageDigest:preparation.source.native.packageDigest,rules:preparation.context.rules,draft:candidate.draft,authorId:preparation.authorId};
    if(digest(command)!==preparation.commandDigest)fail('STORAGE_FAILED','candidate command');return freezeScreenplay(preparation);
  }
  private async progress(client:PoolClient,key:ScreenplayKey,checkCurrent=true):Promise<ScreenplayProgress>{
    const preparation=await this.preparation(client,key);if(!preparation)fail('NOT_FOUND','candidate');
    const rows=await client.query('SELECT tenant_id,project_id,candidate_id,request_digest,digest,record FROM camery_screenplay.reviews WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',keys(key));if(rows.rows.length>1)fail('STORAGE_FAILED','review cardinality');let review:ScreenplayReview|null=null;
    if(rows.rows[0]){const row=rows.rows[0];review=validateScreenplayReview(preparation.context,preparation.candidate,row.record);if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.candidate_id!==key.candidateId||row.digest!==review.digest||row.request_digest!==digest({candidateDigest:review.candidateDigest,draft:review.output.draft,waivers:review.waivers,actorId:review.actorId}))fail('STORAGE_FAILED','review binding');}
    const header=await client.query('SELECT head_revision FROM camery_versioning.projects WHERE tenant_id=$1 AND project_id=$2',[preparation.source.native.target.tenantId,preparation.source.native.target.projectId]);
    if(header.rows.length!==1)fail('STORAGE_FAILED','current project');
    let current=checkCurrent&&String(header.rows[0].head_revision)===String(preparation.source.native.snapshotRevision);
    if(current){try{await this.fresh(client,{preparation,review,current:true});}catch(error){if(error instanceof ScreenplayError&&['CONFLICT','INCOMPLETE'].includes(error.code))current=false;else throw error;}}
    return freezeScreenplay({preparation,review,current});
  }
  async prepare(input:unknown,hostInput:unknown):Promise<ScreenplayProgress>{
    const command=freezeScreenplay(captureScreenplay(ScreenplayPrepareSchema,input,'screenplay preparation command',SCREENPLAY_CANDIDATE_BYTES)),host=authorizeScreenplayHost(hostInput,'screenplay:prepare',scopeFor(command.key)),commandDigest=digest({...command,authorId:host.actor.id});
    return this.transaction(client=>this.prepareCaptured(client,command,host,commandDigest));
  }
  /** Atomic generation delivery; caller owns the READ COMMITTED transaction and its commit/rollback. */
  async prepareOnClient(client:PoolClient,input:unknown,hostInput:unknown):Promise<ScreenplayProgress>{
    const command=freezeScreenplay(captureScreenplay(ScreenplayPrepareSchema,input,'screenplay preparation command',SCREENPLAY_CANDIDATE_BYTES)),host=authorizeScreenplayHost(hostInput,'screenplay:prepare',scopeFor(command.key)),commandDigest=digest({...command,authorId:host.actor.id});
    try{const isolation=await client.query('SHOW transaction_isolation');if(isolation.rows.length!==1||isolation.rows[0].transaction_isolation!=='read committed')fail('CONFLICT','transaction_isolation');return await this.prepareCaptured(client,command,host,commandDigest);}catch(error){return safe(error);}
  }
  private async prepareCaptured(client:PoolClient,command:ReturnType<typeof ScreenplayPrepareSchema.parse>,host:ReturnType<typeof authorizeScreenplayHost>,commandDigest:string):Promise<ScreenplayProgress>{
      const prior=await this.preparation(client,command.key);if(prior){if(prior.commandDigest!==commandDigest)fail('CONFLICT','immutable candidate');return this.progress(client,command.key);}
      const {context,source,previous}=await readScreenplaySource(client,{scope:host.scope,target:command.target,episodeId:command.draft.episodeId,rules:command.rules},this.outline);
      if(source.native.snapshotRevision!==command.expectedSnapshotRevision||source.native.packageDigest!==command.expectedPackageDigest)fail('CONFLICT','current source');
      await this.lock(client,command.key);const concurrent=await this.preparation(client,command.key);if(concurrent){if(concurrent.commandDigest!==commandDigest)fail('CONFLICT','immutable candidate');return this.progress(client,command.key);}
      const candidate=createScreenplayCandidate(host.scope,context,command.draft),body={version:1 as const,key:command.key,source,context,previous,candidate,authorId:host.actor.id,createdAt:host.at,commandDigest},preparation=captureScreenplay(ScreenplayPreparationSchema,{...body,digest:digest(body)},'screenplay preparation',SCREENPLAY_CONTEXT_BYTES);
      await client.query('INSERT INTO camery_screenplay.candidates(tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,context_digest,command_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[...keys(command.key),source.native.target.tenantId,source.native.target.projectId,source.native.snapshotRevision,source.contextDigest,commandDigest,preparation.digest,canonicalContinuity(preparation,SCREENPLAY_CONTEXT_BYTES)]);
      return this.progress(client,command.key);
  }
  async read(input:unknown,host:unknown):Promise<ScreenplayProgress>{const key=freezeScreenplay(captureScreenplay(ScreenplayKeySchema,input,'screenplay key',2048));authorizeScreenplayHost(host,'screenplay:read',scopeFor(key));return this.transaction(client=>this.progress(client,key));}
  async review(input:unknown,decisionInput:unknown,hostInput:unknown):Promise<ScreenplayProgress>{
    const key=freezeScreenplay(captureScreenplay(ScreenplayKeySchema,input,'screenplay key',2048)),decision=freezeScreenplay(captureScreenplay(ScreenplayReviewDecisionSchema,decisionInput,'screenplay decision',SCREENPLAY_CANDIDATE_BYTES)),host=authorizeScreenplayHost(hostInput,'screenplay:review',scopeFor(key)),request=digest({...decision,actorId:host.actor.id});
    return this.transaction(async client=>{
      const initial=await this.progress(client,key,false);
      if(initial.review){if(request!==digest({candidateDigest:initial.review.candidateDigest,draft:initial.review.output.draft,waivers:initial.review.waivers,actorId:initial.review.actorId}))fail('CONFLICT','immutable review');return initial;}
      await this.fresh(client,initial);await this.lock(client,key);const progress=await this.progress(client,key,false);
      if(progress.review){if(request!==digest({candidateDigest:progress.review.candidateDigest,draft:progress.review.output.draft,waivers:progress.review.waivers,actorId:progress.review.actorId}))fail('CONFLICT','immutable review');return progress;}
      await this.fresh(client,progress);const review=reviewScreenplayCandidate(progress.preparation.context,progress.preparation.candidate,decision,host);
      await client.query('INSERT INTO camery_screenplay.reviews(tenant_id,project_id,candidate_id,request_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...keys(key),request,review.digest,canonicalContinuity(review,SCREENPLAY_CANDIDATE_BYTES)]);return this.progress(client,key);
    });
  }
  private async fresh(client:PoolClient,progress:ScreenplayProgress):Promise<void>{
    const p=progress.preparation,view=await readScreenplaySource(client,{scope:p.candidate.scope,target:p.source.native.target,episodeId:p.context.episode.id,rules:p.context.rules},this.outline);
    if(!equal(view.source,p.source))fail('CONFLICT','stale screenplay source');
  }
  /** Caller owns the transaction; run this source guard before the native project row lock. */
  async readForAdoption(client:PoolClient,input:unknown,host:unknown):Promise<ScreenplayProgress>{
    const key=freezeScreenplay(captureScreenplay(ScreenplayKeySchema,input,'screenplay adoption key',2048));authorizeScreenplayHost(host,'screenplay:finalize',scopeFor(key));
    try{const initial=await this.progress(client,key,false);await this.fresh(client,initial);await this.lock(client,key);const progress=await this.progress(client,key,false);
      if(!progress.review)fail('INCOMPLETE','human review');return freezeScreenplay({...progress,current:true});
    }catch(error){return safe(error);}
  }
  /** Historical callback only, without opening another transaction or claiming freshness. */
  async readHistorical(client:PoolClient,input:unknown,host:unknown):Promise<ScreenplayProgress>{const key=captureScreenplay(ScreenplayKeySchema,input,'historical screenplay key',2048);authorizeScreenplayHost(host,'screenplay:read',scopeFor(key));try{return await this.progress(client,key,false);}catch(error){return safe(error);}}
  /** Read-only precheck source. Caller owns RC; acquire upstream locks here before any downstream scan lock. */
  async readCurrentForPrecheck(client:PoolClient,input:unknown,host:unknown):Promise<ScreenplayProgress>{
    const key=freezeScreenplay(captureScreenplay(ScreenplayKeySchema,input,'current screenplay precheck key',2048));authorizeScreenplayHost(host,'screenplay:read',scopeFor(key));
    try{const isolation=await client.query('SHOW transaction_isolation');if(isolation.rows.length!==1||isolation.rows[0].transaction_isolation!=='read committed')fail('CONFLICT','transaction_isolation');const initial=await this.progress(client,key,false);await this.fresh(client,initial);await this.lock(client,key);const progress=await this.progress(client,key,false);return freezeScreenplay({...progress,current:true});}catch(error){return safe(error);}
  }
}

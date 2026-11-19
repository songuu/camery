import type {Pool,PoolClient} from 'pg';
import type {PostgresOutlineStore} from '../../outline/node/store.js';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,ScreenplayError} from '../contracts.js';
import {SCREENPLAY_GENERATED_BYTES} from './model-contracts.js';
import {StartScreenplayGenerationSchema,ScreenplayGenerationKeySchema,ScreenplayGeneratedCandidateSchema,ScreenplayGenerationDeliverySchema} from './generation-contracts.js';
import type {ScreenplayGenerationKey,ScreenplayGenerationRun,ScreenplayGenerationProgress} from './generation-contracts.js';
import {generationDigest as hash,generationEqual as equal,screenplayExecution,screenplayGenerationCommand,validateScreenplayGenerationRun,validateScreenplayRunCandidate,captureScreenplayGenerationProgress} from './generation-state.js';
import {prepareScreenplayGeneration} from './generation.js';
import {authorizeScreenplayHost} from './host.js';
import {readScreenplaySource,readStoredScreenplaySource} from './source.js';
import {PostgresScreenplayStore} from './store.js';
import {canonicalContinuity} from '../../continuity/node/digest.js';

type Outline=Pick<PostgresOutlineStore,'readForAdoption'|'readHistoricalForAdoption'>;
const ids=(key:ScreenplayGenerationKey)=>[key.tenantId,key.projectId,key.runId];
const scopeFor=(key:ScreenplayGenerationKey)=>({tenantId:key.tenantId,projectId:key.projectId});
const keyFor=(input:unknown)=>freezeScreenplay(captureScreenplay(ScreenplayGenerationKeySchema,input,'generation key',2048));
function fail(code:ScreenplayError['code'],path:string):never{throw new ScreenplayError(code,'screenplay generation storage',path);}
function safe(error:unknown):never{let known=false;try{known=error instanceof ScreenplayError;}catch{/* Driver details are never public diagnostics. */}if(known)throw error;return fail('STORAGE_FAILED','storage');}
/** Internal host API only. Generation is a proposal, never a human review or native adoption. */
export class PostgresScreenplayGenerationStore{
  private readonly screenplay:PostgresScreenplayStore;
  constructor(private readonly pool:Pool,private readonly outline:Outline){this.screenplay=new PostgresScreenplayStore(pool,outline);}
  private async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T>{
    let client:PoolClient;try{client=await this.pool.connect();}catch{return fail('STORAGE_FAILED','connection');}
    let broken=false,destroy=false,listening=false;const onError=()=>{broken=true;},healthy=()=>{if(broken)fail('STORAGE_FAILED','connection');};
    try{client.on('error',onError);listening=true;await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query('SET LOCAL search_path = pg_catalog');healthy();const result=await action(client);healthy();await client.query('COMMIT');healthy();return result;}
    catch(error){if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;return fail('STORAGE_FAILED','rollback');}return safe(error);}
    finally{let failed=false;try{client.removeListener('error',onError);}catch{destroy=true;failed=true;}try{client.release(destroy||broken);}catch{failed=true;}if(failed)fail('STORAGE_FAILED','release');}
  }
  private async lock(client:PoolClient,key:ScreenplayGenerationKey){await client.query('SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0::pg_catalog.int8))',[JSON.stringify(['camery_screenplay:generation',...ids(key)])]);}
  private async run(client:PoolClient,key:ScreenplayGenerationKey):Promise<ScreenplayGenerationRun|null>{
    const rows=await client.query('SELECT tenant_id,project_id,run_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,request_digest,digest,record FROM camery_screenplay.generation_runs WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',ids(key));
    if(!rows.rows.length)return null;if(rows.rows.length!==1)fail('STORAGE_FAILED','run cardinality');const row=rows.rows[0],run=validateScreenplayGenerationRun(key,row.record),n=run.source.native;
    if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.run_id!==key.runId||row.candidate_id!==run.candidateId||row.formal_tenant_id!==n.target.tenantId||row.formal_project_id!==n.target.projectId||String(row.source_revision)!==String(n.snapshotRevision)||row.request_digest!==run.requestDigest||row.digest!==run.digest)fail('STORAGE_FAILED','run columns');
    await readStoredScreenplaySource(client,{scope:scopeFor(key),source:run.source,context:run.context,previous:run.previous},this.outline);return run;
  }
  private async progress(client:PoolClient,key:ScreenplayGenerationKey,host:unknown):Promise<ScreenplayGenerationProgress>{
    const run=await this.run(client,key);if(!run)fail('NOT_FOUND','run');
    // Read the dependent row first: under RC, an observed delivery's FK parent must exist in the later snapshot.
    const deliveries=await client.query('SELECT tenant_id,project_id,run_id,candidate_id,digest,record FROM camery_screenplay.generation_deliveries WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',ids(key)),candidates=await client.query('SELECT tenant_id,project_id,run_id,digest,record FROM camery_screenplay.generation_candidates WHERE tenant_id=$1 AND project_id=$2 AND run_id=$3',ids(key));
    if(candidates.rows.length>1||deliveries.rows.length>1)fail('STORAGE_FAILED','progress cardinality');const c=candidates.rows[0],d=deliveries.rows[0];
    const progress=captureScreenplayGenerationProgress(key,{run,candidate:c?c.record:null,delivery:d?d.record:null});
    for(const row of [c,d])if(row&&(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.run_id!==key.runId||row.digest!==(row===c?progress.candidate?.digest:progress.delivery?.digest)))fail('STORAGE_FAILED','progress columns');
    if(d&&d.candidate_id!==run.candidateId)fail('STORAGE_FAILED','delivery candidate');
    if(progress.delivery){const actual=await this.screenplay.readHistorical(client,progress.delivery.candidateKey,host);if(actual.preparation.digest!==progress.delivery.preparationDigest||!equal(actual.preparation.source,run.source)||!equal(actual.preparation.candidate,progress.candidate!.candidate))fail('STORAGE_FAILED','delivered preparation');}
    return progress;
  }
  async start(input:unknown,hostInput:unknown):Promise<ScreenplayGenerationRun>{
    const command=freezeScreenplay(captureScreenplay(StartScreenplayGenerationSchema,input,'screenplay generation start',32768)),execution=screenplayExecution(command.execution),scope=scopeFor(command.key),host=authorizeScreenplayHost(hostInput,'screenplay:prepare',scope),requestDigest=hash({...command,execution,authorId:host.actor.id});
    return this.transaction(async client=>{
      const prior=await this.run(client,command.key);if(prior){if(prior.requestDigest!==requestDigest)fail('CONFLICT','immutable generation run');return prior;}
      const view=await readScreenplaySource(client,{scope,target:command.target,episodeId:command.episodeId,rules:command.rules},this.outline);
      if(view.source.native.snapshotRevision!==command.expectedSnapshotRevision||view.source.native.packageDigest!==command.expectedPackageDigest)fail('CONFLICT','current source');
      const prepared=prepareScreenplayGeneration(scope,view.context,command.notes);await this.lock(client,command.key);const concurrent=await this.run(client,command.key);if(concurrent){if(concurrent.requestDigest!==requestDigest)fail('CONFLICT','immutable generation run');return concurrent;}
      const collision=await client.query('SELECT candidate_id FROM camery_screenplay.candidates WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[scope.tenantId,scope.projectId,command.candidateId]);if(collision.rows.length)fail('CONFLICT','existing manual candidate');
      const body={version:1 as const,...command.key,candidateId:command.candidateId,source:view.source,context:view.context,previous:view.previous,notes:command.notes,method:prepared.method,execution,authorId:host.actor.id,createdAt:host.at,requestDigest},run=validateScreenplayGenerationRun(command.key,{...body,digest:hash(body)});
      if(hash(screenplayGenerationCommand(run))!==requestDigest)fail('CONFLICT','start command');
      await client.query('INSERT INTO camery_screenplay.generation_runs(tenant_id,project_id,run_id,candidate_id,formal_tenant_id,formal_project_id,source_revision,request_digest,digest,record) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[...ids(command.key),command.candidateId,command.target.tenantId,command.target.projectId,command.expectedSnapshotRevision,requestDigest,run.digest,canonicalContinuity(run,SCREENPLAY_CONTEXT_BYTES)]);return run;
    });
  }
  async read(input:unknown,hostInput:unknown){const key=keyFor(input),host=authorizeScreenplayHost(hostInput,'screenplay:read',scopeFor(key));return this.transaction(client=>this.progress(client,key,host));}
  private async fresh(client:PoolClient,run:ScreenplayGenerationRun){const view=await readScreenplaySource(client,{scope:{tenantId:run.tenantId,projectId:run.projectId},target:run.source.native.target,episodeId:run.context.episode.id,rules:run.context.rules},this.outline);if(!equal(view.source,run.source))fail('CONFLICT','stale generation source');}
  async isCurrent(input:unknown,hostInput:unknown):Promise<boolean>{const key=keyFor(input);authorizeScreenplayHost(hostInput,'screenplay:read',scopeFor(key));return this.transaction(async client=>{const run=await this.run(client,key);if(!run)fail('NOT_FOUND','run');try{await this.fresh(client,run);return true;}catch(error){if(error instanceof ScreenplayError&&['CONFLICT','INCOMPLETE'].includes(error.code))return false;throw error;}});}
  /** Paid output is historical evidence; source advancement must not discard it or trigger another request. */
  async saveCandidate(input:unknown,candidateInput:unknown,hostInput:unknown){
    const key=keyFor(input),captured=freezeScreenplay(captureScreenplay(ScreenplayGeneratedCandidateSchema,candidateInput,'screenplay generated candidate',SCREENPLAY_GENERATED_BYTES)),host=authorizeScreenplayHost(hostInput,'screenplay:prepare',scopeFor(key));
    return this.transaction(async client=>{await this.lock(client,key);const p=await this.progress(client,key,host);if(p.run.authorId!==host.actor.id)fail('FORBIDDEN','run author');const candidate=validateScreenplayRunCandidate(p.run,captured);if(p.candidate){if(!equal(p.candidate,candidate))fail('CONFLICT','immutable generated candidate');return p.candidate;}
      await client.query('INSERT INTO camery_screenplay.generation_candidates(tenant_id,project_id,run_id,digest,record) VALUES($1,$2,$3,$4,$5::jsonb)',[...ids(key),candidate.digest,canonicalContinuity(candidate,SCREENPLAY_GENERATED_BYTES)]);return candidate;});
  }
  /** Core preparation and provenance receipt commit together; human review remains a separate operation. */
  async deliver(input:unknown,hostInput:unknown){
    const key=keyFor(input),host=authorizeScreenplayHost(hostInput,'screenplay:prepare',scopeFor(key));
    return this.transaction(async client=>{const first=await this.progress(client,key,host);if(first.run.authorId!==host.actor.id)fail('FORBIDDEN','run author');if(first.delivery)return first.delivery;if(!first.candidate)fail('INCOMPLETE','generated candidate');
      // Upstream Outline locks then native project, before generation and candidate locks.
      await this.fresh(client,first.run);await this.lock(client,key);const p=await this.progress(client,key,host);if(p.delivery)return p.delivery;const run=p.run,candidate=p.candidate!;
      const candidateKey={...scopeFor(key),candidateId:run.candidateId},prepared=await this.screenplay.prepareOnClient(client,{key:candidateKey,target:run.source.native.target,expectedSnapshotRevision:run.source.native.snapshotRevision,expectedPackageDigest:run.source.native.packageDigest,rules:run.context.rules,draft:candidate.candidate.draft},host);
      if(!equal(prepared.preparation.candidate,candidate.candidate)||!equal(prepared.preparation.source,run.source))fail('CONFLICT','delivered candidate');
      const body={version:1 as const,key,runDigest:run.digest,generatedDigest:candidate.digest,candidateKey,preparationDigest:prepared.preparation.digest,authorId:host.actor.id,at:host.at},delivery=captureScreenplay(ScreenplayGenerationDeliverySchema,{...body,digest:hash(body)},'generation delivery',8192);
      await client.query('INSERT INTO camery_screenplay.generation_deliveries(tenant_id,project_id,run_id,candidate_id,digest,record) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[...ids(key),run.candidateId,delivery.digest,canonicalContinuity(delivery,8192)]);return freezeScreenplay(delivery);});
  }
}

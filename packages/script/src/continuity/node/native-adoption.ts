import {z} from 'zod';
import type {PoolClient} from 'pg';
import {StableId,StoryboardPackageV08} from '@camery/ir';
import {VersionPersistenceError} from '@camery/versioning/node';
import type {PersistedChangeResult,VersionAdoptionGuard,VersionTransactionContext,VersionTransactionReceipt} from '@camery/versioning/node';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {CONTINUITY_CONTEXT_BYTES,ContinuityError} from '../contracts.js';
import {Integer} from '../../contracts.js';
import {captureContinuityReviewHost,authorizeContinuityHost} from './review.js';
import type {PostgresContinuityStore} from './store.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
import {CONTINUITY_NATIVE_RECORD_BYTES,ContinuityNativeMappingSchema,ContinuityNativeReceiptSchema} from './native-contracts.js';
import type {ContinuityNativeMapping} from './native-contracts.js';
import {readContinuityNativeBinding,readContinuityNativeReceipt,insertContinuityNativeBinding,insertContinuityNativeReceipt} from './native-records.js';
import {prepareContinuityNativeMapping} from './native-mapping.js';
import {readStoredContinuityProgress} from './history.js';
import {readStoredContinuitySource,readContinuityNativeAdoption} from './source.js';

const expectation=z.strictObject({expectedSnapshotRevision:Integer.min(1),expectedWriteVersion:Integer.min(1)});
const Input=z.strictObject({mapping:ContinuityNativeMappingSchema,expectation});
const AdoptionInput=Input.extend({actorId:StableId.refine(value=>value.length===26)});
type Input=z.infer<typeof Input>;
type AdoptionInput=z.infer<typeof AdoptionInput>;
type SourceStore=Pick<PostgresContinuityStore,'readForAdoption'>;
const equal=(a:unknown,b:unknown)=>canonicalContinuity(a,CONTINUITY_NATIVE_RECORD_BYTES)===canonicalContinuity(b,CONTINUITY_NATIVE_RECORD_BYTES);
const scopeFor=(mapping:ContinuityNativeMapping)=>({tenantId:mapping.binding.key.tenantId,projectId:mapping.binding.key.projectId});
function refuse(path:string):never{throw new ContinuityError('CONFLICT','native continuity execution',path);}
function safe(error:unknown):never{let known=false;try{known=error instanceof ContinuityError;}catch{/* Opaque driver prototypes never supply diagnostics. */}if(known)throw error;throw new ContinuityError('STORAGE_FAILED','native continuity execution','storage');}
function execution(input:Input,raw:VersionTransactionContext,operation:'submit'|'adopt'):VersionTransactionContext{
  const context=captureContinuity(z.custom<VersionTransactionContext>(),raw,'native transaction context',CONTINUITY_NATIVE_RECORD_BYTES),binding=input.mapping.binding;
  if(context.operation!==operation||!equal(context.project,binding.target)||!equal(context.expectation,input.expectation))refuse('target and expectation');return context;
}
function actual(input:Input,raw:Readonly<PersistedChangeResult>){
  const result=captureContinuity(z.custom<PersistedChangeResult>(),raw,'native transaction result',CONTINUITY_CONTEXT_BYTES),change=result.state.changes.find(row=>row.request.id===input.mapping.binding.changeId);
  if(result.state.head.project.id!==input.mapping.binding.target.projectId||!change||!equal(change.request,input.mapping.request))refuse('actual native request');
  return {result,change};
}
async function bound(client:PoolClient,mapping:ContinuityNativeMapping):Promise<void>{
  const saved=await readContinuityNativeBinding(client,mapping.binding.target,mapping.binding.changeId);if(!saved||!equal(saved,mapping.binding))refuse('stored native binding');
}
async function rebuilt(client:PoolClient,mapping:ContinuityNativeMapping,store:SourceStore,host:unknown,fresh:boolean):Promise<void>{
  const binding=mapping.binding,progress=fresh?await store.readForAdoption(client,binding.key,host):(await readStoredContinuityProgress(client,binding.key,readStoredContinuitySource)).progress;
  const rows=await client.query('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',[binding.target.tenantId,binding.target.projectId,binding.sourceRevision]);
  if(rows.rows.length!==1)refuse('mapping source');const head=captureContinuity(StoryboardPackageV08,rows.rows[0].package,'native mapping source',CONTINUITY_CONTEXT_BYTES);
  // Historical ACKs recompile the original source, without declaring it current or permitting a new adoption.
  const candidate=prepareContinuityNativeMapping({head,progress:fresh?progress:{...progress,current:true},changeId:binding.changeId,snapshotId:binding.snapshot.id,operationId:binding.operationId,author:binding.author});
  if(!equal(candidate,mapping))refuse('complete reviewed mapping');
}

/** Call only through submitWithReceipt. This callback never owns a transaction or accepts model-authored authority. */
export function createContinuityNativeSubmissionReceipt(input:Input,store:SourceStore,hostInput:unknown):VersionTransactionReceipt{
  const captured=freezeContinuity(captureContinuity(Input,input,'native preparation',CONTINUITY_NATIVE_RECORD_BYTES)),host=captureContinuityReviewHost(hostInput),{mapping}=captured;
  if(captured.expectation.expectedSnapshotRevision!==mapping.binding.sourceRevision)refuse('source expectation');
  return async(client,raw,rawContext)=>{
    try{
      authorizeContinuityHost(host,'continuity:review',scopeFor(mapping));const context=execution(captured,rawContext,'submit'),{result,change}=actual(captured,raw);
      if(context.operation!=='submit'||typeof context.requestSignature!=='string'||Buffer.byteLength(context.requestSignature)>CONTINUITY_NATIVE_RECORD_BYTES||!equal(JSON.parse(context.requestSignature),mapping.request))refuse('submitted execution request');
      const prior=await readContinuityNativeBinding(client,mapping.binding.target,mapping.binding.changeId);
      if(prior){if(!equal(prior,mapping.binding))refuse('immutable submission');await rebuilt(client,mapping,store,host,false);return;}
      if(result.status!=='candidate'||change.status!=='candidate'||result.state.head.revision.number!==mapping.binding.sourceRevision)refuse('prepared candidate');
      await rebuilt(client,mapping,store,host,true);await insertContinuityNativeBinding(client,mapping.binding);
    }catch(error){safe(error);}
  };
}

/** Source guard and proof writer for the existing native adopter. The host still supplies its actual native authorization. */
export function createContinuityNativeAdoptionHooks(input:AdoptionInput,store:SourceStore,hostInput:unknown):{guard:VersionAdoptionGuard;receipt:VersionTransactionReceipt}{
  const captured=freezeContinuity(captureContinuity(AdoptionInput,input,'native adoption',CONTINUITY_NATIVE_RECORD_BYTES)),host=captureContinuityReviewHost(hostInput),{mapping}=captured,binding=mapping.binding;
  if(captured.expectation.expectedSnapshotRevision!==binding.sourceRevision)refuse('source expectation');
  const guard:VersionAdoptionGuard=async client=>{
    try{
      authorizeContinuityHost(host,'continuity:review',scopeFor(mapping));await bound(client,mapping);await rebuilt(client,mapping,store,host,true);
      const rows=await client.query('SELECT status,record FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3',[binding.target.tenantId,binding.target.projectId,binding.changeId]);
      if(rows.rows.length!==1||rows.rows[0].status!=='candidate'||rows.rows[0].record?.status!=='candidate'||!equal(rows.rows[0].record?.request,mapping.request))refuse('guarded native request');
    }catch{throw new VersionPersistenceError('ADOPTION_SOURCE_INVALID','continuity source',binding.target.projectId);}
  };
  const receipt:VersionTransactionReceipt=async(client,raw,rawContext)=>{
    try{
      authorizeContinuityHost(host,'continuity:review',scopeFor(mapping));const context=execution(captured,rawContext,'adopt'),{result,change}=actual(captured,raw);await bound(client,mapping);
      if(context.operation!=='adopt'||context.changeId!==binding.changeId||context.actor.kind!=='user'||context.actor.id!==captured.actorId||context.scope.kind!=='episode'||context.scope.id!==binding.episodeId||context.at!==host.at)refuse('actual human adoption');
      if(result.status!=='adopted')return;
      const audit=result.state.adoptions.find(row=>row.change_set_id===binding.changeId),object=result.state.revisions.find(row=>row.object_id===binding.snapshot.id&&row.version===binding.snapshot.version);
      if(change.status!=='adopted'||!audit||!object||object.collection!=='continuity_snapshots'||object.change_set_id!==binding.changeId||object.snapshot_revision!==audit.to_revision||!equal(object.value,mapping.snapshot)||audit.scope.kind!=='episode'||audit.scope.id!==binding.episodeId||audit.from_revision!==binding.sourceRevision||audit.to_revision!==binding.sourceRevision+1)refuse('actual native adoption history');
      if(!context.replayed&&(audit.actor_id!==context.actor.id||audit.at!==context.at))refuse('first adoption authority');
      const prior=await readContinuityNativeReceipt(client,binding.target,binding.changeId);if(context.replayed&&!prior)refuse('missing original adoption proof');
      const body={version:1 as const,key:binding.key,target:binding.target,bindingDigest:binding.digest,reviewDigest:binding.reviewDigest,changeId:binding.changeId,snapshot:binding.snapshot,ledgerDigest:continuityDigest(mapping.snapshot.ledger,CONTINUITY_NATIVE_RECORD_BYTES),fromRevision:audit.from_revision,toRevision:audit.to_revision,actor:{kind:'user' as const,id:audit.actor_id},scope:{kind:'episode' as const,id:binding.episodeId},at:audit.at};
      const record=captureContinuity(ContinuityNativeReceiptSchema,{...body,digest:continuityDigest(body,CONTINUITY_NATIVE_RECORD_BYTES)},'actual native adoption proof',CONTINUITY_NATIVE_RECORD_BYTES);
      if(prior){if(!equal(prior,record))refuse('immutable adoption proof');}else await insertContinuityNativeReceipt(client,record);
      const verified=await readContinuityNativeAdoption(client,{scope:host.scope,target:binding.target,changeId:binding.changeId});if(!equal(verified.ledger,mapping.snapshot.ledger)||!equal(verified.snapshot,binding.snapshot)||verified.origin.bindingDigest!==binding.digest)refuse('verified adopted ledger');
    }catch(error){safe(error);}
  };
  return Object.freeze({guard,receipt});
}

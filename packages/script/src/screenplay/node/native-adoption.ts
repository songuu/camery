import {z} from 'zod';
import type {PoolClient} from 'pg';
import {StableId,StoryboardPackage} from '@camery/ir';
import {VersionPersistenceError} from '@camery/versioning/node';
import type {PersistedChangeResult,VersionAdoptionGuard,VersionTransactionContext,VersionTransactionReceipt} from '@camery/versioning/node';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,SCREENPLAY_CANDIDATE_BYTES,ScreenplayError} from '../contracts.js';
import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import {ScreenplayKeySchema} from './contracts.js';
import {ScreenplayProgressSchema} from './persistence-contracts.js';
import type {ScreenplayProgress} from './persistence-contracts.js';
import {authorizeScreenplayHost,captureScreenplayHost} from './host.js';
import {ScreenplayNativeMappingSchema,prepareScreenplayNativeMapping} from './native-mapping.js';
import {ScreenplayNativeIdentitySchema,ScreenplayNativeBindingSchema,ScreenplayExpectationSchema,ScreenplayNativeReceiptSchema} from './native-contracts.js';
import type {ScreenplayNativeBinding,ScreenplayNativeReceipt} from './native-contracts.js';
import {readScreenplayNativeBinding,readScreenplayNativeReceipt,insertScreenplayNativeBinding,insertScreenplayNativeReceipt} from './native-records.js';
import type {PostgresScreenplayStore} from './store.js';
const Input=z.strictObject({key:ScreenplayKeySchema,mapping:ScreenplayNativeMappingSchema,ids:z.array(ScreenplayNativeIdentitySchema).max(40000),expectation:ScreenplayExpectationSchema});
const AdoptInput=Input.extend({actorId:StableId.refine(value=>value.length===26)});
type Input=z.infer<typeof Input>;
type Store=Pick<PostgresScreenplayStore,'readForAdoption'|'readHistorical'>;
const same=(a:unknown,b:unknown)=>canonicalContinuity(a,SCREENPLAY_CONTEXT_BYTES)===canonicalContinuity(b,SCREENPLAY_CONTEXT_BYTES);
function refuse(path:string):never{throw new ScreenplayError('CONFLICT','native screenplay execution',path);}
function safe(error:unknown):never{let known=false;try{known=error instanceof ScreenplayError;}catch{/* Driver prototype traps cannot supply public errors. */}if(known)throw error;throw new ScreenplayError('STORAGE_FAILED','native screenplay execution','storage');}
const scopeFor=(input:Input)=>({tenantId:input.key.tenantId,projectId:input.key.projectId});
function bindingFor(input:Input):ScreenplayNativeBinding{
  if(input.expectation.expectedSnapshotRevision!==input.mapping.sourceRevision)refuse('source expectation');
  const body={version:1 as const,key:input.key,mapping:input.mapping,ids:input.ids};
  return freezeScreenplay(captureScreenplay(ScreenplayNativeBindingSchema,{...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)},'native screenplay binding',SCREENPLAY_CANDIDATE_BYTES));
}
function execution(input:Input,raw:VersionTransactionContext,operation:'submit'|'adopt'){
  const context=captureScreenplay(z.custom<VersionTransactionContext>(),raw,'native execution context',SCREENPLAY_CANDIDATE_BYTES);
  if(context.operation!==operation||!same(context.project,input.mapping.target)||!same(context.expectation,input.expectation))refuse('native execution envelope');return context;
}
function actual(binding:ScreenplayNativeBinding,raw:Readonly<PersistedChangeResult>){
  const result=captureScreenplay(z.custom<PersistedChangeResult>(),raw,'native execution result',SCREENPLAY_CONTEXT_BYTES),change=result.state.changes.find(row=>row.request.id===binding.mapping.request.id);
  if(result.state.head.project.id!==binding.mapping.target.projectId||!change||!same(change.request,binding.mapping.request))refuse('actual native request');return {result,change};
}
export async function replayScreenplayNativeBinding(client:PoolClient,binding:ScreenplayNativeBinding,store:Store,host:unknown,fresh:boolean):Promise<ScreenplayProgress>{
  const raw=fresh?await store.readForAdoption(client,binding.key,host):await store.readHistorical(client,binding.key,host),progress=captureScreenplay(ScreenplayProgressSchema,raw,'stored screenplay progress',SCREENPLAY_CONTEXT_BYTES),p=progress.preparation,m=binding.mapping;
  if(!same(p.key,binding.key)||fresh&&!progress.current||p.source.native.packageDigest!==m.packageDigest||p.source.contextDigest!==m.contextDigest||p.source.native.snapshotRevision!==m.sourceRevision||!same(p.source.native.target,m.target))refuse('immutable reviewed source');
  const rows=await client.query('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',[m.target.tenantId,m.target.projectId,m.sourceRevision]);if(rows.rows.length!==1)refuse('original native source');
  const head=captureScreenplay(StoryboardPackage,rows.rows[0].package,'original screenplay source',SCREENPLAY_CONTEXT_BYTES);
  const mapping=prepareScreenplayNativeMapping({head,context:p.context,candidate:p.candidate,review:progress.review!,target:m.target,changeId:m.request.id,author:m.request.author as {kind:'user';id:string},ids:binding.ids});
  if(!same(mapping,m))refuse('complete reviewed native mapping');return progress;
}
async function bound(client:PoolClient,binding:ScreenplayNativeBinding):Promise<void>{if(!same(await readScreenplayNativeBinding(client,binding.mapping.target,binding.mapping.request.id),binding))refuse('stored native binding');}
/** Checks the actual immutable native records, including the post-lock first revision of every line. */
export function screenplayNativeAdoptionFacts(binding:ScreenplayNativeBinding,raw:Readonly<PersistedChangeResult>):Omit<ScreenplayNativeReceipt,'digest'>{
  const {mapping}=binding,{result,change}=actual(binding,raw),audit=result.state.adoptions.find(row=>row.change_set_id===mapping.request.id),scene=mapping.request.ops.find(row=>row.op==='add'&&row.collection==='scenes');
  if(result.status!=='adopted'||change.status!=='adopted'||!audit||audit.from_revision!==mapping.sourceRevision||audit.to_revision!==mapping.sourceRevision+1||audit.scope.kind!=='episode'||scene?.op!=='add'||audit.scope.id!==scene.value['episode_id'])refuse('actual human adoption');
  const expected=new Map<string,{collection:string;value:Record<string,unknown>}>();
  for(const op of mapping.request.ops){
    if(op.op==='add'){const value={...op.value};if(op.collection==='lines')value['locked']=true;expected.set(value['id'] as string,{collection:op.collection,value});}
    else if(op.op==='lock')expected.set(op.lock_id,{collection:'locks',value:{id:op.lock_id,version:1,target:op.target,fields:op.fields,owner_id:audit.actor_id,reason:op.reason}});
    else refuse('unexpected screenplay operation');
  }
  const revisions=new Map<string,typeof result.state.revisions[number]>();for(const row of result.state.revisions)if(row.change_set_id===mapping.request.id){if(revisions.has(row.object_id))refuse('native object cardinality');revisions.set(row.object_id,row);}
  if(revisions.size!==expected.size)refuse('native object cardinality');
  for(const [id,object] of expected){const row=revisions.get(id);if(!row||row.version!==1||row.collection!==object.collection||row.parent_version!==null||row.snapshot_revision!==audit.to_revision||!same(row.value,object.value))refuse('actual locked screenplay object');}
  return {version:1,key:binding.key,target:mapping.target,changeId:mapping.request.id,reviewDigest:mapping.reviewDigest,bindingDigest:binding.digest,fromRevision:audit.from_revision,toRevision:audit.to_revision,actor:{kind:'user',id:audit.actor_id},scope:{kind:'episode',id:audit.scope.id},at:audit.at};
}
/** Only the native store invokes this callback after submission and before its own COMMIT. */
export function createScreenplayNativeSubmissionReceipt(input:Input,store:Store,hostInput:unknown):VersionTransactionReceipt{
  const captured=freezeScreenplay(captureScreenplay(Input,input,'screenplay submission',SCREENPLAY_CONTEXT_BYTES)),host=captureScreenplayHost(hostInput),binding=bindingFor(captured);
  return async(client,raw,rawContext)=>{try{
    authorizeScreenplayHost(host,'screenplay:finalize',scopeFor(captured));const context=execution(captured,rawContext,'submit'),{result,change}=actual(binding,raw);
    if(context.operation!=='submit'||typeof context.requestSignature!=='string'||Buffer.byteLength(context.requestSignature)>SCREENPLAY_CANDIDATE_BYTES||!same(JSON.parse(context.requestSignature),binding.mapping.request))refuse('submitted request signature');
    const prior=await readScreenplayNativeBinding(client,binding.mapping.target,binding.mapping.request.id);
    if(prior){if(!same(prior,binding))refuse('immutable submission');await replayScreenplayNativeBinding(client,binding,store,host,false);return;}
    if(result.status!=='candidate'||change.status!=='candidate'||result.state.head.revision.number!==binding.mapping.sourceRevision)refuse('new native submission');
    // Native submission already owns its project row lock. Current Outline locks belong to the adoption
    // guard before that row lock; immutable reads here avoid reversing the source lock order.
    await replayScreenplayNativeBinding(client,binding,store,host,false);await insertScreenplayNativeBinding(client,binding);
  }catch(error){safe(error);}};
}
/** Same-transaction source guard plus immutable native proof. No model call, new transaction, or client-supplied grant. */
export function createScreenplayNativeAdoptionHooks(input:z.infer<typeof AdoptInput>,store:Store,hostInput:unknown):{guard:VersionAdoptionGuard;receipt:VersionTransactionReceipt}{
  const captured=freezeScreenplay(captureScreenplay(AdoptInput,input,'screenplay adoption',SCREENPLAY_CONTEXT_BYTES)),host=captureScreenplayHost(hostInput),binding=bindingFor(captured);
  const guard:VersionAdoptionGuard=async client=>{try{
    authorizeScreenplayHost(host,'screenplay:finalize',scopeFor(captured));await bound(client,binding);await replayScreenplayNativeBinding(client,binding,store,host,true);
    const rows=await client.query('SELECT status,record FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3',[binding.mapping.target.tenantId,binding.mapping.target.projectId,binding.mapping.request.id]);
    if(rows.rows.length!==1||rows.rows[0].status!=='candidate'||rows.rows[0].record?.status!=='candidate'||!same(rows.rows[0].record?.request,binding.mapping.request))refuse('guarded native candidate');
  }catch{throw new VersionPersistenceError('ADOPTION_SOURCE_INVALID','screenplay source',binding.mapping.target.projectId);}};
  const receipt:VersionTransactionReceipt=async(client,raw,rawContext)=>{try{
    authorizeScreenplayHost(host,'screenplay:finalize',scopeFor(captured));const context=execution(captured,rawContext,'adopt');await bound(client,binding);
    if(context.operation!=='adopt'||context.changeId!==binding.mapping.request.id||context.actor.kind!=='user'||context.actor.id!==captured.actorId||context.at!==host.at)refuse('actual adoption authority');
    const {result}=actual(binding,raw);if(result.status!=='adopted')return;
    const body=screenplayNativeAdoptionFacts(binding,raw);if(context.scope.kind!=='episode'||context.scope.id!==body.scope.id)refuse('actual adoption scope');
    if(!context.replayed&&(body.actor.id!==context.actor.id||body.at!==context.at))refuse('original adoption authority');
    const prior=await readScreenplayNativeReceipt(client,binding.mapping.target,binding.mapping.request.id);if(context.replayed&&!prior)refuse('missing original adoption proof');
    await replayScreenplayNativeBinding(client,binding,store,host,false);const record=captureScreenplay(ScreenplayNativeReceiptSchema,{...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)},'actual screenplay adoption',SCREENPLAY_CANDIDATE_BYTES);
    if(prior){if(!same(prior,record))refuse('immutable native adoption');}else await insertScreenplayNativeReceipt(client,record);
  }catch(error){safe(error);}};
  return Object.freeze({guard,receipt});
}

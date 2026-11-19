import type {PoolClient} from 'pg';
import {z} from 'zod';
import {EpisodeStateSnapshot,ContinuitySnapshotSchema,StableId,StoryboardPackage,continuityDependencyIssues} from '@camery/ir';
import {Integer} from '../../contracts.js';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {CONTINUITY_CONTEXT_BYTES,ContinuityError} from '../contracts.js';
import type {ContinuityContext} from '../contracts.js';
import {captureContinuityContext} from '../context.js';
import {continuityDigest,canonicalContinuity} from './digest.js';
import {CONTINUITY_PREVIOUS_BYTES,CONTINUITY_RECORD_BYTES,ContinuityPreviousSchema,ContinuityPreviousV2Schema,ContinuitySourceSchema,ContinuitySourceSelectionSchema,ContinuityTargetSchema,ContinuityScopeSchema} from './persistence-contracts.js';
import type {ContinuityPredecessorResolver,ContinuityPrevious,ContinuitySource,ContinuitySourceSelection,ContinuityTarget} from './persistence-contracts.js';
import {continuityProofWalk,enqueueContinuityNativeProof,enqueueContinuityLegacyFreshness,drainContinuityNativeProofs,findContinuityNativeReceipt} from './native-proof.js';
import type {ContinuityProofWalk} from './native-proof.js';
import {readContinuityNativeBinding,readContinuityNativeReceipt} from './native-records.js';

export interface ContinuitySourceView{readonly source:ContinuitySource;readonly context:ContinuityContext;readonly previous:ContinuityPrevious|null}
interface Header{packageId:string;revision:number;writeVersion:number}
function fail(code:ConstructorParameters<typeof ContinuityError>[0],path:string):never{throw new ContinuityError(code,'native source',path);}
function safe(error:unknown):never{let known=false;try{known=error instanceof ContinuityError;}catch{/* Opaque dependency exceptions cannot expose their prototype traps. */}if(known)throw error;throw new ContinuityError('STORAGE_FAILED','native source','storage');}
function integer(value:unknown,path:string):number{if(typeof value==='string'&&!/^[1-9][0-9]*$/.test(value)||typeof value!=='string'&&typeof value!=='number')fail('STORAGE_FAILED',path);const n=Number(value);if(!Number.isSafeInteger(n)||n<1)fail('STORAGE_FAILED',path);return n;}
async function header(client:PoolClient,target:ContinuityTarget,lock=false):Promise<Header>{
  const result=await client.query('SELECT tenant_id,project_id,package_id,head_revision,write_version FROM camery_versioning.projects WHERE tenant_id=$1 AND project_id=$2'+(lock?' FOR UPDATE':''),[target.tenantId,target.projectId]);
  if(result.rows.length===0)fail('NOT_FOUND','project');if(result.rows.length!==1)fail('STORAGE_FAILED','project cardinality');const row=result.rows[0];
  if(row.tenant_id!==target.tenantId||row.project_id!==target.projectId||!StableId.safeParse(row.package_id).success)fail('STORAGE_FAILED','project columns');
  return {packageId:row.package_id,revision:integer(row.head_revision,'head_revision'),writeVersion:integer(row.write_version,'write_version')};
}
/** Must precede any continuity advisory lock. Caller owns the surrounding transaction. */
export async function lockContinuityProject(client:PoolClient,input:unknown):Promise<void>{const target=freezeContinuity(captureContinuity(ContinuityTargetSchema,input,'formal target',1024));try{await header(client,target,true);}catch(error){safe(error);}}
async function loadPackage(client:PoolClient,target:ContinuityTarget,head:Header,revision:number){
  const result=await client.query('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',[target.tenantId,target.projectId,revision]);
  if(result.rows.length!==1)fail('STORAGE_FAILED','snapshot cardinality');const pkg=captureContinuity(StoryboardPackage,result.rows[0].package,'source package',CONTINUITY_CONTEXT_BYTES),context=captureContinuityContext(pkg);
  if(pkg.project.id!==target.projectId||pkg.package_id!==head.packageId||pkg.revision.number!==revision)fail('CONFLICT','snapshot binding');return {pkg,context};
}
const objectSchema=z.strictObject({collection:z.literal('episode_state_snapshots'),object_id:StableId,version:Integer.min(1),parent_version:Integer.min(1).nullable(),snapshot_revision:Integer.min(1),change_set_id:StableId.nullable(),value:EpisodeStateSnapshot});
const typedObjectSchema=objectSchema.extend({collection:z.literal('continuity_snapshots'),value:ContinuitySnapshotSchema});
const auditSchema=z.strictObject({change_set_id:StableId,actor_id:StableId,scope:z.strictObject({kind:z.enum(['project','episode','scene']),id:StableId}),from_revision:Integer.min(1),to_revision:Integer.min(1),at:z.iso.datetime({precision:3})});
async function checkPrevious(client:PoolClient,previous:ContinuityPrevious,target:ContinuityTarget,scope:ContinuitySourceSelection['scope'],pkg:z.infer<typeof StoryboardPackage>,context:ContinuityContext,episodeId:string,walk:ContinuityProofWalk){
  if(previous.scope.tenantId!==scope.tenantId||previous.scope.projectId!==scope.projectId||previous.target.tenantId!==target.tenantId||previous.target.projectId!==target.projectId||previous.ledger.projectId!==pkg.project.id||previous.ledger.packageId!==pkg.package_id||previous.ledger.episodeId!==episodeId||previous.adoptedRevision>pkg.revision.number||previous.ledger.snapshotRevision>previous.adoptedRevision)fail('CONFLICT','previous binding');
  const {digest,...body}=previous;if(continuityDigest(body,CONTINUITY_PREVIOUS_BYTES)!==digest)fail('CONFLICT','previous digest');
  const snapshot=previous.version===2?(pkg.schema_version==='0.8.0-draft'?pkg.continuity_snapshots.find(value=>value.id===previous.snapshot.id&&value.version===previous.snapshot.version&&value.episode_id===episodeId):undefined):pkg.episode_state_snapshots.find(value=>value.id===previous.snapshot.id&&value.version===previous.snapshot.version&&value.episode_id===episodeId&&value.status==='adopted');if(!snapshot)fail('UNADOPTED_SNAPSHOT','previous snapshot');
  if(previous.version===2&&(!('ledger'in snapshot)||pkg.schema_version!=='0.8.0-draft'||canonicalContinuity(snapshot.ledger,CONTINUITY_PREVIOUS_BYTES)!==canonicalContinuity(previous.ledger,CONTINUITY_PREVIOUS_BYTES)))fail('UNADOPTED_SNAPSHOT','previous full ledger');
  if(previous.version===2&&pkg.schema_version==='0.8.0-draft'&&continuityDependencyIssues(pkg).some(issue=>issue.objectId===snapshot.id))fail('CONFLICT','previous freshness');
  const versions=await client.query('SELECT object_id,version,snapshot_revision,change_id,record FROM camery_versioning.object_revisions WHERE tenant_id=$1 AND project_id=$2 AND object_id=$3 AND version=$4',[target.tenantId,target.projectId,previous.snapshot.id,previous.snapshot.version]);
  if(versions.rows.length!==1)fail('UNADOPTED_SNAPSHOT','previous history');const row=versions.rows[0],record=captureContinuity(previous.version===2?typedObjectSchema:objectSchema,row.record,'previous native object',CONTINUITY_CONTEXT_BYTES);
  if(row.object_id!==previous.snapshot.id||integer(row.version,'previous version')!==previous.snapshot.version||integer(row.snapshot_revision,'previous revision')!==previous.adoptedRevision||row.change_id!==previous.changeId||record.object_id!==row.object_id||record.version!==Number(row.version)||record.snapshot_revision!==Number(row.snapshot_revision)||record.change_set_id!==row.change_id||canonicalContinuity(record.value,CONTINUITY_CONTEXT_BYTES)!==canonicalContinuity(snapshot,CONTINUITY_CONTEXT_BYTES))fail('UNADOPTED_SNAPSHOT','previous history binding');
  const adoptions=await client.query('SELECT change_id,from_revision,to_revision,record FROM camery_versioning.adoptions WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3 AND to_revision=$4',[target.tenantId,target.projectId,previous.changeId,previous.adoptedRevision]);
  if(adoptions.rows.length!==1)fail('UNADOPTED_SNAPSHOT','previous adoption');const adopted=adoptions.rows[0],audit=captureContinuity(auditSchema,adopted.record,'previous adoption',16384);
  if(adopted.change_id!==previous.changeId||integer(adopted.to_revision,'adoption revision')!==previous.adoptedRevision||integer(adopted.from_revision,'adoption base')+1!==previous.adoptedRevision||audit.change_set_id!==adopted.change_id||audit.from_revision!==Number(adopted.from_revision)||audit.to_revision!==Number(adopted.to_revision)||!(audit.scope.kind==='project'&&audit.scope.id===target.projectId||audit.scope.kind==='episode'&&audit.scope.id===episodeId))fail('UNADOPTED_SNAPSHOT','previous adoption binding');
  const changes=await client.query('SELECT status,record FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3',[target.tenantId,target.projectId,previous.changeId]);
  if(changes.rows.length!==1||changes.rows[0].status!=='adopted'||changes.rows[0].record?.status!=='adopted'||changes.rows[0].record?.request?.id!==previous.changeId)fail('UNADOPTED_SNAPSHOT','previous native change');
  if(!context.episodes.some(value=>value.id===episodeId))fail('INVALID_REFERENCE','previous episode');
  if(previous.version===2){if(!('ledger'in snapshot))fail('UNADOPTED_SNAPSHOT','previous typed snapshot');await enqueueContinuityNativeProof(client,previous,snapshot,audit,changes.rows[0].record.request,walk);}
  else{if(!('status'in snapshot))fail('UNADOPTED_SNAPSHOT','previous legacy snapshot');enqueueContinuityLegacyFreshness(snapshot,walk);}
}
/** Reads source in the caller's transaction; the constructor-supplied resolver is authority, never a request field. */
export async function readContinuitySource(client:PoolClient,input:unknown,options:Readonly<{lock?:boolean;previousFor?:ContinuityPredecessorResolver|undefined}>={}):Promise<ContinuitySourceView>{
  const selection=freezeContinuity(captureContinuity(ContinuitySourceSelectionSchema,input,'source selection',2048)),resolver=options.previousFor,locked=options.lock===true;
  try{
    const head=await header(client,selection.target,locked),{pkg,context}=await loadPackage(client,selection.target,head,head.revision),index=context.episodes.findIndex(value=>value.id===selection.episodeId);if(index<0)fail('NOT_FOUND','episodeId');const walk=continuityProofWalk(pkg.schema_version==='0.8.0-draft'?pkg:undefined);let previous:ContinuityPrevious|null=null;
    if(index>0){if(!resolver)fail('INCOMPLETE','adopted predecessor');const previousId=context.episodes[index-1]!.id,value=await resolver(client,freezeContinuity({scope:selection.scope,target:selection.target,episodeId:previousId}));if(value===null)fail('INCOMPLETE','adopted predecessor');previous=captureContinuity(ContinuityPreviousSchema,value,'adopted predecessor',CONTINUITY_PREVIOUS_BYTES);await checkPrevious(client,previous,selection.target,selection.scope,pkg,context,previousId,walk);}
    await drainContinuityNativeProofs(client,walk,(connection,input)=>storedSource(connection,input,walk));
    const source=ContinuitySourceSchema.parse({version:1,target:selection.target,packageId:pkg.package_id,snapshotRevision:head.revision,episodeId:selection.episodeId,packageDigest:continuityDigest(pkg,CONTINUITY_CONTEXT_BYTES),contextDigest:continuityDigest(context,CONTINUITY_CONTEXT_BYTES),previousDigest:previous?.digest??null});return freezeContinuity({source,context,previous});
  }catch(error){return safe(error);}
}
/** Historical integrity read. It does not request a new predecessor or turn a review into adoption. */
async function storedSource(client:PoolClient,input:unknown,walk:ContinuityProofWalk):Promise<ContinuitySourceView&{readonly current:boolean}>{
  const captured=freezeContinuity(captureContinuity(z.strictObject({source:ContinuitySourceSchema,previous:ContinuityPreviousSchema.nullable()}),input,'stored source',CONTINUITY_RECORD_BYTES));
  try{
    const {source,previous}=captured,head=await header(client,source.target),{pkg,context}=await loadPackage(client,source.target,head,source.snapshotRevision),index=context.episodes.findIndex(value=>value.id===source.episodeId);
    if(index<0||source.packageId!==pkg.package_id||context.packageId!==source.packageId||context.projectId!==source.target.projectId||continuityDigest(pkg,CONTINUITY_CONTEXT_BYTES)!==source.packageDigest||continuityDigest(context,CONTINUITY_CONTEXT_BYTES)!==source.contextDigest||previous?.digest!==undefined&&previous.digest!==source.previousDigest||previous===null&&source.previousDigest!==null)fail('CONFLICT','stored source binding');
    if(index===0){if(previous!==null)fail('CONFLICT','stored predecessor');}else{if(previous===null)fail('INCOMPLETE','stored predecessor');await checkPrevious(client,previous,source.target,previous.scope,pkg,context,context.episodes[index-1]!.id,walk);}
    return freezeContinuity({source,context,previous,current:head.revision===source.snapshotRevision});
  }catch(error){return safe(error);}
}
/** Complete historical integrity on the caller's client, including the bounded native proof chain. */
export async function readStoredContinuitySource(client:PoolClient,input:unknown):Promise<ContinuitySourceView&{readonly current:boolean}>{
  const walk=continuityProofWalk();try{const view=await storedSource(client,input,walk);await drainContinuityNativeProofs(client,walk,(connection,value)=>storedSource(connection,value,walk));return view;}catch(error){return safe(error);}
}
/** Historical native ACK verification uses its adopted snapshot, even after later head changes. It grants no current freshness. */
export async function readContinuityNativeAdoption(client:PoolClient,input:unknown):Promise<Extract<ContinuityPrevious,{version:2}>>{
  const selection=freezeContinuity(captureContinuity(z.strictObject({scope:ContinuityScopeSchema,target:ContinuityTargetSchema,changeId:StableId}),input,'native adoption selection',2048));
  try{
    const receipt=await readContinuityNativeReceipt(client,selection.target,selection.changeId),binding=await readContinuityNativeBinding(client,selection.target,selection.changeId);
    if(!receipt||!binding)fail('UNADOPTED_SNAPSHOT','missing native proof');
    const head=await header(client,selection.target),{pkg,context}=await loadPackage(client,selection.target,head,receipt.toRevision);
    if(pkg.schema_version!=='0.8.0-draft')fail('UNADOPTED_SNAPSHOT','native schema');
    const snapshot=pkg.continuity_snapshots.find(row=>row.id===receipt.snapshot.id&&row.version===receipt.snapshot.version);if(!snapshot)fail('UNADOPTED_SNAPSHOT','native snapshot');
    const body={version:2 as const,id:binding.key.candidateId,scope:selection.scope,target:selection.target,snapshot:receipt.snapshot,changeId:selection.changeId,adoptedRevision:receipt.toRevision,ledger:snapshot.ledger,origin:{reviewDigest:binding.reviewDigest,bindingDigest:binding.digest}};
    const previous=captureContinuity(ContinuityPreviousV2Schema,{...body,digest:continuityDigest(body,CONTINUITY_PREVIOUS_BYTES)},'native adoption proof',CONTINUITY_PREVIOUS_BYTES),walk=continuityProofWalk();
    await checkPrevious(client,previous,selection.target,selection.scope,pkg,context,binding.episodeId,walk);await drainContinuityNativeProofs(client,walk,(connection,value)=>storedSource(connection,value,walk));return freezeContinuity(previous);
  }catch(error){return safe(error);}
}
/** Production discovery and verification; absence never upgrades a legacy or unreviewed snapshot into typed authority. */
export const resolveContinuityNativePredecessor:ContinuityPredecessorResolver=async(client,input)=>{
  const selection=freezeContinuity(captureContinuity(ContinuitySourceSelectionSchema,input,'native predecessor selection',2048));
  try{
    const head=await header(client,selection.target),{pkg,context}=await loadPackage(client,selection.target,head,head.revision);
    if(pkg.schema_version!=='0.8.0-draft')return null;const snapshot=pkg.continuity_snapshots.find(row=>row.episode_id===selection.episodeId);if(!snapshot)return null;
    const receipt=await findContinuityNativeReceipt(client,selection.target,snapshot);if(!receipt)fail('UNADOPTED_SNAPSHOT','missing native proof');
    const binding=await readContinuityNativeBinding(client,selection.target,receipt.changeId);if(!binding)fail('UNADOPTED_SNAPSHOT','missing human binding');
    const body={version:2 as const,id:binding.key.candidateId,scope:selection.scope,target:selection.target,snapshot:{id:snapshot.id,version:snapshot.version},changeId:binding.changeId,adoptedRevision:receipt.toRevision,ledger:snapshot.ledger,origin:{reviewDigest:binding.reviewDigest,bindingDigest:binding.digest}};
    const previous=captureContinuity(ContinuityPreviousSchema,{...body,digest:continuityDigest(body,CONTINUITY_PREVIOUS_BYTES)},'native predecessor',CONTINUITY_PREVIOUS_BYTES),walk=continuityProofWalk(pkg);
    await checkPrevious(client,previous,selection.target,selection.scope,pkg,context,selection.episodeId,walk);await drainContinuityNativeProofs(client,walk,(connection,value)=>storedSource(connection,value,walk));return freezeContinuity(previous);
  }catch(error){return safe(error);}
};

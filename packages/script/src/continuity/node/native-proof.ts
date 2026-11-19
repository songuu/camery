import type {PoolClient} from 'pg';
import {ChangeSetV08,StoryboardPackageV08} from '@camery/ir';
import type {ContinuitySnapshot,StoryboardPackageV08 as NativePackage} from '@camery/ir';
import {captureContinuity} from '../boundary.js';
import {CONTINUITY_CONTEXT_BYTES,ContinuityError} from '../contracts.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
import {CONTINUITY_NATIVE_RECORD_BYTES} from './native-contracts.js';
import type {ContinuityNativeBinding,ContinuityNativeReceipt} from './native-contracts.js';
import {readContinuityNativeBinding,readContinuityNativeReceipt} from './native-records.js';
import {readStoredContinuityProgress} from './history.js';
import {prepareContinuityNativeMapping} from './native-mapping.js';
import type {ContinuityPrevious,ContinuityTarget} from './persistence-contracts.js';

type TypedPrevious=Extract<ContinuityPrevious,{version:2}>;
type LegacySnapshot=NativePackage['episode_state_snapshots'][number];
type Task={kind?:'native';binding:ContinuityNativeBinding;receipt:ContinuityNativeReceipt;snapshot:ContinuitySnapshot}|{kind:'legacy';snapshot:LegacySnapshot};
type HistoryReader=Parameters<typeof readStoredContinuityProgress>[2];
export interface ContinuityProofWalk{pending:Task[];seen:Set<string>;count:number;currentSnapshots?:ReadonlyMap<string,{id:string;version:number;digest:string}>;currentLegacy?:ReadonlyMap<string,{version:number;digest:string}>;currentLegacyOwners?:ReadonlyMap<string,{id:string;count:number}>}
export function continuityProofWalk(current?:NativePackage):ContinuityProofWalk{
  const walk:ContinuityProofWalk={pending:[],seen:new Set(),count:0};
  if(current){
    walk.currentSnapshots=new Map(current.continuity_snapshots.map(snapshot=>[snapshot.episode_id,{id:snapshot.id,version:snapshot.version,digest:continuityDigest(snapshot,CONTINUITY_NATIVE_RECORD_BYTES)}]));
    walk.currentLegacy=new Map(current.episode_state_snapshots.map(snapshot=>[snapshot.id,{version:snapshot.version,digest:continuityDigest(snapshot,CONTINUITY_CONTEXT_BYTES)}]));
    const owners=new Map<string,{id:string;count:number}>();for(const snapshot of current.episode_state_snapshots)if(snapshot.status==='adopted'){const previous=owners.get(snapshot.episode_id);owners.set(snapshot.episode_id,{id:snapshot.id,count:(previous?.count??0)+1});}walk.currentLegacyOwners=owners;
  }return walk;
}
function refuse(code:'CONFLICT'|'UNADOPTED_SNAPSHOT'|'STORAGE_FAILED'|'INPUT_LIMIT',path:string):never{throw new ContinuityError(code,'native continuity proof',path);}
const equal=(a:unknown,b:unknown)=>canonicalContinuity(a,CONTINUITY_NATIVE_RECORD_BYTES)===canonicalContinuity(b,CONTINUITY_NATIVE_RECORD_BYTES);
export function enqueueContinuityLegacyFreshness(snapshot:LegacySnapshot,walk:ContinuityProofWalk):void{if(walk.currentLegacy)walk.pending.push({kind:'legacy',snapshot});}

/** Check immutable native/receipt bindings immediately; defer complete human replay until the bounded walk drains. */
export async function enqueueContinuityNativeProof(client:PoolClient,previous:TypedPrevious,snapshot:ContinuitySnapshot,audit:{actor_id:string;scope:{kind:string;id:string};from_revision:number;to_revision:number;at:string},request:unknown,walk:ContinuityProofWalk):Promise<void>{
  const binding=await readContinuityNativeBinding(client,previous.target,previous.changeId),receipt=await readContinuityNativeReceipt(client,previous.target,previous.changeId);
  if(!binding||!receipt)refuse('UNADOPTED_SNAPSHOT','missing human/native proof');
  const native=captureContinuity(ChangeSetV08,request,'actual continuity request',CONTINUITY_NATIVE_RECORD_BYTES);
  if(binding.key.tenantId!==previous.scope.tenantId||binding.key.projectId!==previous.scope.projectId||binding.key.candidateId!==previous.id||binding.episodeId!==snapshot.episode_id||binding.sourceRevision!==previous.ledger.snapshotRevision||binding.sourceRevision!==receipt.fromRevision||binding.sourceRevision>=previous.adoptedRevision||!equal(binding.snapshot,previous.snapshot)||receipt.toRevision!==previous.adoptedRevision||!equal(receipt.snapshot,previous.snapshot)||!equal(receipt.key,binding.key)||!equal(receipt.target,binding.target)||receipt.bindingDigest!==binding.digest||receipt.reviewDigest!==binding.reviewDigest||previous.origin.bindingDigest!==binding.digest||previous.origin.reviewDigest!==binding.reviewDigest||receipt.ledgerDigest!==continuityDigest(previous.ledger,CONTINUITY_NATIVE_RECORD_BYTES)||binding.requestDigest!==continuityDigest(native,CONTINUITY_NATIVE_RECORD_BYTES)||!equal(native.author,binding.author))refuse('UNADOPTED_SNAPSHOT','human/native binding');
  if(receipt.actor.id!==audit.actor_id||receipt.at!==audit.at||receipt.scope.kind!==audit.scope.kind||receipt.scope.id!==audit.scope.id||receipt.scope.id!==binding.episodeId||receipt.fromRevision!==audit.from_revision||receipt.toRevision!==audit.to_revision)refuse('UNADOPTED_SNAPSHOT','native decision binding');
  walk.pending.push({binding,receipt,snapshot});
}

/** Iterative replay retains only one historical package at a time, rather than 100 nested script contexts. */
export async function drainContinuityNativeProofs(client:PoolClient,walk:ContinuityProofWalk,readSource:HistoryReader):Promise<void>{
  while(walk.pending.length){
    const task=walk.pending.shift()!;
    if(task.kind==='legacy'){
      const snapshot=task.snapshot,current=walk.currentLegacy?.get(snapshot.id),owner=walk.currentLegacyOwners?.get(snapshot.episode_id);
      // Legacy inputs carry no new typed receipt, but their exact native version still constrains later ledgers.
      if(!current||current.version!==snapshot.version||current.digest!==continuityDigest(snapshot,CONTINUITY_CONTEXT_BYTES)||owner?.count!==1||owner.id!==snapshot.id||walk.currentSnapshots?.has(snapshot.episode_id))refuse('CONFLICT','current legacy predecessor ledger');
      if(++walk.count>100)refuse('INPUT_LIMIT','predecessor proof chain');continue;
    }
    const {binding,receipt,snapshot}=task,key=JSON.stringify([binding.target,binding.changeId]);
    // An unchanged script does not make a later ledger fresh after an earlier reviewed ledger was revised.
    const current=walk.currentSnapshots?.get(snapshot.episode_id);
    if(walk.currentSnapshots&&(!current||current.id!==snapshot.id||current.version!==snapshot.version||current.digest!==continuityDigest(snapshot,CONTINUITY_NATIVE_RECORD_BYTES)))refuse('CONFLICT','current predecessor ledger chain');
    if(walk.seen.has(key))refuse('CONFLICT','cyclic predecessor proof');if(++walk.count>100)refuse('INPUT_LIMIT','predecessor proof chain');walk.seen.add(key);
    const {progress}=await readStoredContinuityProgress(client,binding.key,readSource);
    if(progress.review?.status!=='reviewed'||progress.review.digest!==binding.reviewDigest||progress.preparation.candidate.digest!==binding.candidateDigest||progress.preparation.source.snapshotRevision!==binding.sourceRevision||progress.preparation.source.packageDigest!==binding.packageDigest||!equal(progress.preparation.source.target,binding.target)||!equal(progress.review.output.ledger,snapshot.ledger))refuse('UNADOPTED_SNAPSHOT','historical human review');
    const rows=await client.query('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',[binding.target.tenantId,binding.target.projectId,binding.sourceRevision]);
    if(rows.rows.length!==1)refuse('STORAGE_FAILED','historical mapping source');
    const head=captureContinuity(StoryboardPackageV08,rows.rows[0].package,'historical native source',CONTINUITY_CONTEXT_BYTES);
    // Recompile at the immutable original source; this does not claim that source is the current project head.
    const rebuilt=prepareContinuityNativeMapping({head,progress:{...progress,current:true},changeId:binding.changeId,snapshotId:binding.snapshot.id,operationId:binding.operationId,author:binding.author});
    if(!equal(rebuilt.binding,binding)||!equal(rebuilt.snapshot,snapshot)||receipt.ledgerDigest!==continuityDigest(rebuilt.snapshot.ledger,CONTINUITY_NATIVE_RECORD_BYTES))refuse('UNADOPTED_SNAPSHOT','replayed native request');
  }
}

export async function findContinuityNativeReceipt(client:PoolClient,target:ContinuityTarget,snapshot:{id:string;version:number}):Promise<ContinuityNativeReceipt|null>{
  const rows=await client.query('SELECT change_id FROM camery_continuity.native_adoptions WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND snapshot_id=$3 AND snapshot_version=$4',[target.tenantId,target.projectId,snapshot.id,snapshot.version]);
  if(rows.rows.length===0)return null;if(rows.rows.length!==1||typeof rows.rows[0].change_id!=='string')refuse('STORAGE_FAILED','snapshot proof cardinality');
  return readContinuityNativeReceipt(client,target,rows.rows[0].change_id);
}

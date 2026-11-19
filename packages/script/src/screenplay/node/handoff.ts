import {z} from 'zod';
import type {PoolClient} from 'pg';
import {StableId,StoryboardPackage} from '@camery/ir';
import type {AdoptionRecord,ObjectRevision,StoredChange} from '@camery/versioning';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,SCREENPLAY_CANDIDATE_BYTES,ScreenplayError} from '../contracts.js';
import type {ScreenplayContext} from '../contracts.js';
import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import {ContinuityScopeSchema,ContinuityTargetSchema} from '../../continuity/node/persistence-contracts.js';
import {createContinuityCandidate} from '../../continuity/node/candidate.js';
import {captureContinuityContext} from '../../continuity/context.js';
import type {ContinuityContext} from '../../continuity/contracts.js';
import {readScreenplaySource} from './source.js';
import {resolveContinuityNativePredecessor} from '../../continuity/node/source.js';
import {readScreenplayNativeBinding,readScreenplayNativeReceipt} from './native-records.js';
import {replayScreenplayNativeBinding,screenplayNativeAdoptionFacts} from './native-adoption.js';
import {authorizeScreenplayHost} from './host.js';
import type {PostgresScreenplayStore} from './store.js';
import type {PostgresOutlineStore} from '../../outline/node/store.js';
import type {ScreenplayNativeMapping} from './native-mapping.js';
const Selection=z.strictObject({scope:ContinuityScopeSchema,target:ContinuityTargetSchema,changeId:StableId});
const same=(a:unknown,b:unknown)=>canonicalContinuity(a,SCREENPLAY_CONTEXT_BYTES)===canonicalContinuity(b,SCREENPLAY_CONTEXT_BYTES);
function refuse(path:string):never{throw new ScreenplayError('CONFLICT','screenplay handoff',path);}
function safe(error:unknown):never{let known=false;try{known=error instanceof ScreenplayError;}catch{/* Opaque dependency errors are never diagnostics. */}if(known)throw error;throw new ScreenplayError('STORAGE_FAILED','screenplay handoff','storage');}
type Store=Pick<PostgresScreenplayStore,'readHistorical'|'readForAdoption'>;
function screenplayBody(mapping:ScreenplayNativeMapping,head:z.infer<typeof StoryboardPackage>,episodeId:string,actorId:string,native:ContinuityContext):void{
  const collections=new Map<string,Map<string,unknown>>([['scenes',new Map(head.scenes.map(row=>[row.id,row]))],['beats',new Map(head.beats.map(row=>[row.id,row]))],['lines',new Map(head.lines.map(row=>[row.id,row]))],['locks',new Map(head.locks.map(row=>[row.id,row]))]]);
  for(const op of mapping.request.ops){
    if(op.op==='add'){const actual=collections.get(op.collection)?.get(op.value['id'] as string),expected=op.collection==='lines'?{...op.value,locked:true}:op.value;if(!actual||!same(actual,expected))refuse('locked screenplay snapshot body');}
    else if(op.op==='lock'){const lock=collections.get('locks')!.get(op.lock_id);if(!lock||!same(lock,{id:op.lock_id,version:1,target:op.target,fields:op.fields,reason:op.reason,owner_id:actorId}))refuse('screenplay snapshot lock');}
  }
  const scenes=head.scenes.filter(row=>row.episode_id===episodeId).sort((a,b)=>a.order_key<b.order_key?-1:a.order_key>b.order_key?1:0).map(row=>({id:row.id,version:row.version})),events=native.events.filter(row=>row.episodeId===episodeId).map(row=>row.ref);
  if(!same(scenes,mapping.scenes)||!same(events,mapping.events.map(row=>row.ref)))refuse('complete screenplay snapshot flow');
}

/** Historical native proof only: actual changes, object versions, snapshot and human audit must all agree. */
export async function readScreenplayNativeAdoption(client:PoolClient,input:unknown,store:Store,host:unknown){
  const selection=freezeScreenplay(captureScreenplay(Selection,input,'screenplay adoption selection',2048));authorizeScreenplayHost(host,'screenplay:read',selection.scope);
  try{
    const binding=await readScreenplayNativeBinding(client,selection.target,selection.changeId),receipt=await readScreenplayNativeReceipt(client,selection.target,selection.changeId);
    if(!binding||!receipt)throw new ScreenplayError('INCOMPLETE','screenplay native proof','original proof');
    if(!same({tenantId:binding.key.tenantId,projectId:binding.key.projectId},selection.scope)||!same(receipt.key,binding.key)||receipt.bindingDigest!==binding.digest)refuse('original proof binding');
    const progress=await replayScreenplayNativeBinding(client,binding,store,host,false);
    const snapshots=await client.query('SELECT package FROM camery_versioning.snapshots WHERE tenant_id=$1 AND project_id=$2 AND revision=$3',[selection.target.tenantId,selection.target.projectId,receipt.toRevision]);if(snapshots.rows.length!==1)refuse('adopted snapshot cardinality');
    const head=captureScreenplay(StoryboardPackage,snapshots.rows[0].package,'adopted screenplay snapshot',SCREENPLAY_CONTEXT_BYTES);
    if(head.revision.status!=='adopted'||head.revision.number!==receipt.toRevision||head.package_id!==progress.preparation.context.packageId||head.project.id!==selection.target.projectId)refuse('adopted snapshot binding');
    const changes=await client.query('SELECT status,record FROM camery_versioning.changes WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3',[selection.target.tenantId,selection.target.projectId,selection.changeId]);
    const adoptions=await client.query('SELECT from_revision,to_revision,record FROM camery_versioning.adoptions WHERE tenant_id=$1 AND project_id=$2 AND change_id=$3',[selection.target.tenantId,selection.target.projectId,selection.changeId]);
    if(changes.rows.length!==1||changes.rows[0].status!=='adopted'||adoptions.rows.length!==1)refuse('native adoption cardinality');
    const change=captureScreenplay(z.custom<StoredChange>(),changes.rows[0].record,'native screenplay change',SCREENPLAY_CANDIDATE_BYTES),audit=captureScreenplay(z.custom<AdoptionRecord>(),adoptions.rows[0].record,'native screenplay audit',16384);
    if(String(adoptions.rows[0].from_revision)!==String(audit.from_revision)||String(adoptions.rows[0].to_revision)!==String(audit.to_revision))refuse('native adoption columns');
    const ids=binding.mapping.request.ops.flatMap(op=>op.op==='add'?[op.value['id'] as string]:op.op==='lock'?[op.lock_id]:[]);
    const rows=await client.query('SELECT object_id,version,snapshot_revision,change_id,record FROM camery_versioning.object_revisions WHERE tenant_id=$1 AND project_id=$2 AND object_id=ANY($3::text[]) AND version=1',[selection.target.tenantId,selection.target.projectId,ids]);
    const revisions=rows.rows.map(row=>{const record=captureScreenplay(z.custom<ObjectRevision>(),row.record,'native screenplay object',SCREENPLAY_CANDIDATE_BYTES);if(row.object_id!==record.object_id||String(row.version)!==String(record.version)||String(row.snapshot_revision)!==String(record.snapshot_revision)||row.change_id!==record.change_set_id)refuse('native object columns');return record;});
    const body=screenplayNativeAdoptionFacts(binding,{state:{head,changes:[change],adoptions:[audit],revisions},status:'adopted',issues:[],warnings:[],writeVersion:1});
    if(!same({...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)},receipt))refuse('native proof replay');
    screenplayBody(binding.mapping,head,receipt.scope.id,receipt.actor.id,captureContinuityContext(head));
    return freezeScreenplay({binding,receipt,progress,head});
  }catch(error){return safe(error);}
}
function writingData(context:ScreenplayContext){
  // A supported v07→v08 upgrade adds ledger capacity, not new screenplay prose; compare all actual writing data.
  const {snapshotRevision:_revision,nativeContext:_native,schemaVersion:_schema,...writing}=context;return writing;
}
/** Caller owns a READ COMMITTED transaction. Script locks and adopted ledger are separate durable milestones. */
export async function readScreenplayHandoff(client:PoolClient,input:unknown,store:Store,outline:Pick<PostgresOutlineStore,'readForAdoption'>,host:unknown){
  const selection=freezeScreenplay(captureScreenplay(Selection,input,'screenplay handoff selection',2048));authorizeScreenplayHost(host,'screenplay:read',selection.scope);
  try{
    const isolation=await client.query('SHOW transaction_isolation');
    if(isolation.rows.length!==1||isolation.rows[0]?.transaction_isolation!=='read committed')refuse('transaction_isolation');
    const proof=await readScreenplayNativeAdoption(client,selection,store,host),p=proof.progress.preparation,m=proof.binding.mapping,review=proof.progress.review!;
    const current=await readScreenplaySource(client,{scope:selection.scope,target:selection.target,episodeId:p.context.episode.id,rules:p.context.rules},outline);
    if(!same(writingData(p.context),writingData(current.context)))refuse('current writing dependencies');
    screenplayBody(m,current.head,p.context.episode.id,proof.receipt.actor.id,current.context.nativeContext);
    const references=new Map(m.events.map(row=>[row.localId,row.ref])),draft={version:1 as const,episodeId:p.context.episode.id,events:review.output.draft.continuity.map(event=>({...event,evidence:{event:references.get(event.evidence.event.id)!,quote:event.evidence.quote}}))};
    const candidate=createContinuityCandidate(selection.scope,current.context.nativeContext,draft,current.previous?.ledger??null);
    if(candidate.issues.some(row=>row.severity==='error'))throw new ScreenplayError('INCOMPLETE','actual screenplay continuity','issues');
    const adopted=await resolveContinuityNativePredecessor(client,{scope:selection.scope,target:selection.target,episodeId:p.context.episode.id});
    if(adopted&&(adopted.ledger.snapshotRevision<proof.receipt.toRevision||!same({...candidate.ledger,snapshotRevision:adopted.ledger.snapshotRevision},adopted.ledger)))refuse('adopted screenplay ledger');
    return freezeScreenplay({version:1 as const,state:adopted?'handoff_ready' as const:'ledger_pending' as const,script:proof.receipt,events:m.events,timing:review.output.timing,lineBook:review.output.lineBook,draft,candidate,adopted});
  }catch(error){return safe(error);}
}

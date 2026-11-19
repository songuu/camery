import {z} from 'zod';
import {ChangeSetV08,StableId,StoryboardPackageV08,validatePackage} from '@camery/ir';
import type {ContinuityLedger,ContinuitySnapshot,LedgerEvidence,StoryboardPackageV08 as NativePackage} from '@camery/ir';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {CONTINUITY_CONTEXT_BYTES,ContinuityError} from '../contracts.js';
import {captureContinuityContext} from '../context.js';
import {canonicalTime} from '../../reviewed.js';
import {validateContinuityCandidate} from './candidate.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
import {validateContinuityReview} from './review.js';
import {CONTINUITY_PREVIOUS_BYTES,CONTINUITY_RECORD_BYTES,ContinuityPreparationSchema,ContinuityReviewSchema} from './persistence-contracts.js';
import type {ContinuityPrevious,ContinuityProgress} from './persistence-contracts.js';
import {CONTINUITY_NATIVE_RECORD_BYTES,ContinuityNativeMappingSchema} from './native-contracts.js';
import type {ContinuityNativeMapping} from './native-contracts.js';

const stable=StableId.refine(value=>value.length===26);
const Input=z.strictObject({head:z.unknown(),progress:z.unknown(),changeId:stable,snapshotId:stable,operationId:stable,author:z.strictObject({kind:z.literal('user'),id:stable})});
const Progress=z.strictObject({preparation:ContinuityPreparationSchema,review:ContinuityReviewSchema.nullable(),current:z.boolean()});
type Input={head:unknown;progress:ContinuityProgress;changeId:string;snapshotId:string;operationId:string;author:{kind:'user';id:string}};
type ObjectVersion={collection:string;version:number};
function conflict(path:string):never{throw new ContinuityError('CONFLICT','native continuity mapping',path);}
function equal(left:unknown,right:unknown):boolean{return canonicalContinuity(left,CONTINUITY_NATIVE_RECORD_BYTES)===canonicalContinuity(right,CONTINUITY_NATIVE_RECORD_BYTES);}
function nativeObjects(head:NativePackage):Map<string,ObjectVersion>{
  const result=new Map<string,ObjectVersion>();
  for(const [collection,rows] of Object.entries(head))if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object'&&'id'in row&&'version'in row)result.set(row.id,{collection,version:row.version});
  return result;
}
function evidenceRows(ledger:ContinuityLedger):LedgerEvidence[]{return [...ledger.facts.flatMap(row=>[row.introduced,...(row.retired?[row.retired]:[])]),...ledger.knowledge.map(row=>row.learned),...ledger.characters.map(row=>row.changed),...ledger.threads.flatMap(row=>[row.planted,...(row.paidOff?[row.paidOff]:[])])];}
function ledgerPins(head:NativePackage,ledger:ContinuityLedger):{id:string;version:number}[]{
  const objects=nativeObjects(head),pins=new Map<string,number>(),beats=new Map(head.beats.map(row=>[row.id,row])),lines=new Map(head.lines.map(row=>[row.id,row]));
  const add=(id:string,collection:string,version?:number)=>{const row=objects.get(id);if(!row||row.collection!==collection||version!==undefined&&row.version!==version)conflict('ledger reference '+id);pins.set(id,row.version);};
  add(ledger.episodeId,'episodes');
  for(const row of evidenceRows(ledger)){
    const event=row.evidence.event,line=event.kind==='line'?lines.get(event.id):undefined,beat=event.kind==='beat'?beats.get(event.id):line?beats.get(line.beat_id):undefined;
    add(row.episodeId,'episodes');add(event.id,event.kind==='beat'?'beats':'lines',event.version);if(!beat)conflict('evidence parent '+event.id);
    // Text/event versions alone cannot detect a changed scene owner or line parent.
    add(beat.scene_id,'scenes');if(line)add(beat.id,'beats');
  }
  for(const row of ledger.knowledge){add(row.characterId,'characters');if(row.source.kind==='told')add(row.source.fromCharacterId,'characters');}
  for(const {value} of ledger.characters){add(value.characterId,'characters');if(value.appearance)add(value.appearance.id,'appearances',value.appearance.version);if(value.spot)add(value.spot.location.id,'locations',value.spot.location.version);for(const ref of value.holding)add(ref.id,'props',ref.version);}
  for(const row of ledger.threads)if(row.payoffEpisodeId)add(row.payoffEpisodeId,'episodes');
  return [...pins].map(([id,version])=>({id,version})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}
function checkPrevious(head:NativePackage,previous:ContinuityPrevious|null,episodeId:string):void{
  if(!previous)return;
  const {digest,...body}=previous;
  if(continuityDigest(body,CONTINUITY_PREVIOUS_BYTES)!==digest||previous.target.projectId!==head.project.id||previous.ledger.projectId!==head.project.id||previous.ledger.packageId!==head.package_id||previous.adoptedRevision>head.revision.number||previous.ledger.snapshotRevision>previous.adoptedRevision)conflict('predecessor binding');
  const episodes=[...head.episodes].sort((a,b)=>a.order_key<b.order_key?-1:a.order_key>b.order_key?1:0),index=episodes.findIndex(row=>row.id===episodeId);
  if(index<1||previous.ledger.episodeId!==episodes[index-1]!.id)conflict('predecessor episode');
  const snapshot=previous.version===2?head.continuity_snapshots.find(row=>row.id===previous.snapshot.id):head.episode_state_snapshots.find(row=>row.id===previous.snapshot.id);
  if(!snapshot||snapshot.version!==previous.snapshot.version||snapshot.episode_id!==previous.ledger.episodeId)conflict('predecessor snapshot');
  if(previous.version===2? !('ledger'in snapshot)||!equal(snapshot.ledger,previous.ledger):!('status'in snapshot)||snapshot.status!=='adopted')conflict('predecessor ledger');
  const objects=nativeObjects(head);if(snapshot.based_on.some(ref=>objects.get(ref.id)?.version!==ref.version))conflict('predecessor freshness');
}

/** Integrity-only compilation. The native host must still bind this result to trusted storage, current authorization and one native transaction. */
export function prepareContinuityNativeMapping(input:Input):ContinuityNativeMapping{
  const raw=captureContinuity(Input,input,'native mapping input',CONTINUITY_CONTEXT_BYTES),head=captureContinuity(StoryboardPackageV08,raw.head,'native mapping head',CONTINUITY_CONTEXT_BYTES),progress=captureContinuity(Progress,raw.progress,'native mapping progress',CONTINUITY_RECORD_BYTES);
  const p=progress.preparation,s=p.source,context=captureContinuityContext(head),scope=p.key;
  if(!progress.current)conflict('current source');
  if(progress.review?.status!=='reviewed')throw new ContinuityError('INCOMPLETE','native continuity mapping','review');
  if(s.target.projectId!==head.project.id||s.packageId!==head.package_id||s.snapshotRevision!==head.revision.number||s.packageDigest!==continuityDigest(head,CONTINUITY_CONTEXT_BYTES)||s.contextDigest!==continuityDigest(context,CONTINUITY_CONTEXT_BYTES)||s.episodeId!==p.candidate.draft.episodeId||s.previousDigest!==(p.previous?.digest??null))conflict('source');
  const {digest,...body}=p,command={key:p.key,target:s.target,expectedSnapshotRevision:s.snapshotRevision,expectedPackageDigest:s.packageDigest,draft:p.candidate.draft,authorId:p.authorId};
  if(!canonicalTime(p.createdAt)||digest!==continuityDigest(body,CONTINUITY_RECORD_BYTES)||p.commandDigest!==continuityDigest(command,CONTINUITY_RECORD_BYTES)||p.candidate.scope.tenantId!==scope.tenantId||p.candidate.scope.projectId!==scope.projectId||p.candidate.contextDigest!==s.contextDigest)conflict('preparation');
  if(p.previous&&(p.previous.scope.tenantId!==scope.tenantId||p.previous.scope.projectId!==scope.projectId||p.previous.target.tenantId!==s.target.tenantId||p.previous.target.projectId!==s.target.projectId))conflict('predecessor scope');
  checkPrevious(head,p.previous,s.episodeId);
  const candidate=validateContinuityCandidate(context,p.candidate,p.previous?.ledger??null),review=validateContinuityReview(context,candidate,progress.review,p.previous?.ledger??null);
  if(review.status!=='reviewed')throw new ContinuityError('INCOMPLETE','native continuity mapping','review');
  const identities=[raw.changeId,raw.snapshotId,raw.operationId],objects=nativeObjects(head),reserved=new Set([head.package_id,head.project.id,raw.author.id,...head.locations.flatMap(row=>row.spots.map(spot=>spot.id))]);
  if(new Set(identities).size!==identities.length||identities.some(id=>reserved.has(id))||objects.has(raw.changeId)||objects.has(raw.operationId))conflict('reserved identity');
  const owner=head.continuity_snapshots.find(row=>row.episode_id===s.episodeId),old=head.continuity_snapshots.find(row=>row.id===raw.snapshotId);
  if(owner&&owner.id!==raw.snapshotId||old&&old.episode_id!==s.episodeId||objects.has(raw.snapshotId)&&!old)conflict('snapshot identity');
  if(old&&old.version>=Number.MAX_SAFE_INTEGER)throw new ContinuityError('INPUT_LIMIT','native continuity mapping','snapshot.version');
  const snapshot:ContinuitySnapshot={id:raw.snapshotId,version:old?old.version+1:1,episode_id:s.episodeId,based_on:ledgerPins(head,review.output.ledger),ledger:review.output.ledger};
  const projected={...head,continuity_snapshots:old?head.continuity_snapshots.map(row=>row.id===old.id?snapshot:row):[...head.continuity_snapshots,snapshot]};if(!validatePackage(projected).valid)conflict('native projection');
  const request=ChangeSetV08.parse({schema_version:'0.8.0-draft',id:raw.changeId,base_revision:head.revision.number,author:raw.author,status:'candidate',base_revisions:[...snapshot.based_on,...(old?[{id:old.id,version:old.version}]:[])],
    ops:[old?{op_id:raw.operationId,op:'update',collection:'continuity_snapshots',target:old.id,set:{based_on:snapshot.based_on,ledger:snapshot.ledger}}:{op_id:raw.operationId,op:'add',collection:'continuity_snapshots',value:snapshot}]});
  const binding={version:1 as const,key:p.key,target:s.target,candidateDigest:candidate.digest,reviewDigest:review.digest,sourceRevision:s.snapshotRevision,packageDigest:s.packageDigest,episodeId:s.episodeId,changeId:raw.changeId,snapshot:{id:snapshot.id,version:snapshot.version},operationId:raw.operationId,author:raw.author,requestDigest:continuityDigest(request,CONTINUITY_NATIVE_RECORD_BYTES)};
  return freezeContinuity(captureContinuity(ContinuityNativeMappingSchema,{binding:{...binding,digest:continuityDigest(binding,CONTINUITY_NATIVE_RECORD_BYTES)},request,snapshot},'native mapping result',CONTINUITY_NATIVE_RECORD_BYTES));
}

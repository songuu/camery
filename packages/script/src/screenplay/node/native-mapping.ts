import {z} from 'zod';
import {ChangeSetV07,ChangeSetV08,StableId,RevisionRef,EventRefSchema,StoryboardPackage,validatePackage} from '@camery/ir';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,SCREENPLAY_CANDIDATE_BYTES,SCREENPLAY_DRAFT_BYTES,ScreenplayContextSchema,ScreenplayDraftSchema,ScreenplayError} from '../contracts.js';
import {captureContinuityContext} from '../../continuity/context.js';
import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import {ContinuityTargetSchema} from '../../continuity/node/persistence-contracts.js';
import {Hash,Integer,Text} from '../../contracts.js';
import {validateScreenplayCandidate,validateScreenplayReview} from './review.js';
import {ScreenplayCandidateSchema,ScreenplayReviewSchema} from './contracts.js';
const stable=StableId.refine(value=>value.length===26),identity=z.strictObject({slot:Text(160),id:stable});
const Request=z.discriminatedUnion('schema_version',[ChangeSetV07,ChangeSetV08]);
export const ScreenplayNativeMappingSchema=z.strictObject({version:z.literal(1),target:ContinuityTargetSchema,sourceRevision:Integer.min(1),packageDigest:Hash,contextDigest:Hash,candidateDigest:Hash,reviewDigest:Hash,
  request:Request,events:z.array(z.strictObject({localId:Text(64),ref:EventRefSchema})).max(10240),scenes:z.array(RevisionRef).max(128),locks:z.array(z.strictObject({line:RevisionRef,lock:RevisionRef})).max(8192),digest:Hash});
export type ScreenplayNativeMapping=z.infer<typeof ScreenplayNativeMappingSchema>;
const Input=z.strictObject({head:z.unknown(),context:ScreenplayContextSchema,candidate:ScreenplayCandidateSchema,review:ScreenplayReviewSchema,target:ContinuityTargetSchema,
  changeId:stable,author:z.strictObject({kind:z.literal('user'),id:stable}),ids:z.array(identity).max(40000)});
type Input=z.infer<typeof Input>;
function conflict(path:string):never{throw new ScreenplayError('CONFLICT','native screenplay mapping',path);}
/** Application-owned deterministic slots. Allocate once, persist them, and reuse the same IDs on retries. */
export function screenplayNativeSlots(input:unknown):string[]{
  const draft=captureScreenplay(ScreenplayDraftSchema,input,'native identity slots',SCREENPLAY_DRAFT_BYTES),slots:string[]=[];
  for(const scene of draft.scenes){slots.push('scene:'+scene.id,'add-scene:'+scene.id);for(const beat of scene.beats){slots.push('beat:'+beat.id,'add-beat:'+beat.id);for(const line of beat.lines)slots.push('line:'+line.id,'add-line:'+line.id,'lock:'+line.id,'lock-line:'+line.id);}}
  return slots;
}
const same=(a:unknown,b:unknown)=>canonicalContinuity(a,SCREENPLAY_CONTEXT_BYTES)===canonicalContinuity(b,SCREENPLAY_CONTEXT_BYTES);
/** Compile only. Actual immutable stored review/currentness and native human authority remain required at publication. */
export function prepareScreenplayNativeMapping(input:Input):ScreenplayNativeMapping{
  const raw=captureScreenplay(Input,input,'native screenplay preparation',SCREENPLAY_CONTEXT_BYTES),head=captureScreenplay(StoryboardPackage,raw.head,'native screenplay head',SCREENPLAY_CONTEXT_BYTES),context=raw.context;
  if(head.schema_version!=='0.7.0-draft'&&head.schema_version!=='0.8.0-draft')conflict('schemaVersion');
  if(head.revision.status!=='adopted'||!validatePackage(head).valid||context.schemaVersion!==head.schema_version||context.projectId!==head.project.id||context.packageId!==head.package_id||context.snapshotRevision!==head.revision.number||raw.target.projectId!==head.project.id||!same(captureContinuityContext(head),context.nativeContext))conflict('current source');
  const candidate=validateScreenplayCandidate(context,raw.candidate),review=validateScreenplayReview(context,candidate,raw.review),draft=review.output.draft;
  // Replacing an existing episode requires its explicit native unlock/edit flow. Never remove old lines to evade locks.
  if(head.scenes.some(row=>row.episode_id===draft.episodeId))conflict('existing episode script');
  const required=screenplayNativeSlots(draft),ids=new Map(raw.ids.map(row=>[row.slot,row.id]));
  if(ids.size!==raw.ids.length||ids.size!==required.length||required.some(slot=>!ids.has(slot)))conflict('complete identity slots');
  const occupied=new Set([head.project.id,head.package_id,raw.author.id,raw.target.tenantId,...head.locations.flatMap(row=>row.spots.map(spot=>spot.id))]);
  for(const rows of Object.values(head))if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object'&&'id'in row&&typeof row.id==='string')occupied.add(row.id);
  const allocated=[raw.changeId,...ids.values()];if(new Set(allocated).size!==allocated.length||allocated.some(id=>occupied.has(id)))conflict('reserved identity');
  const actual=(slot:string)=>ids.get(slot)!;
  const ops:z.infer<typeof ChangeSetV07>['ops']=[],events:ScreenplayNativeMapping['events']=[],scenes:ScreenplayNativeMapping['scenes']=[],locks:ScreenplayNativeMapping['locks']=[];
  const names=new Map(context.characters.map(row=>[row.id,row.name]));
  const key=(index:number)=>String(index+1).padStart(5,'0');
  for(const [si,scene] of draft.scenes.entries()){
    const sceneId=actual('scene:'+scene.id),scriptText=scene.beats.map(beat=>[beat.summary,...beat.lines.map(line=>`${names.get(line.speakerId)!} [${line.kind}]（${line.delivery}）：${line.text}`)].join('\n')).join('\n\n');
    scenes.push({id:sceneId,version:1});ops.push({op:'add',op_id:actual('add-scene:'+scene.id),collection:'scenes',value:{id:sceneId,version:1,episode_id:draft.episodeId,order_key:key(si),title:scene.title,location_id:scene.locationId,character_ids:scene.characterIds,script_text:scriptText,start_state:scene.startState,end_state:scene.endState}});
    for(const [bi,beat] of scene.beats.entries()){
      const beatId=actual('beat:'+beat.id);events.push({localId:beat.id,ref:{kind:'beat',id:beatId,version:1}});
      ops.push({op:'add',op_id:actual('add-beat:'+beat.id),collection:'beats',value:{id:beatId,version:1,scene_id:sceneId,order_key:key(bi),kind:beat.kind,required:true,summary:beat.summary,source_refs:[],claim_ids:[]}});
      for(const [li,line] of beat.lines.entries()){
        const lineId=actual('line:'+line.id),lockId=actual('lock:'+line.id);events.push({localId:line.id,ref:{kind:'line',id:lineId,version:1}});locks.push({line:{id:lineId,version:1},lock:{id:lockId,version:1}});
        ops.push({op:'add',op_id:actual('add-line:'+line.id),collection:'lines',value:{id:lineId,version:1,beat_id:beatId,order_key:key(li),speaker_id:line.speakerId,kind:line.kind,text:line.text,delivery:line.delivery,only_rendition_ids:null,locked:false}});
        ops.push({op:'lock',op_id:actual('lock-line:'+line.id),lock_id:lockId,target:lineId,fields:['text'],reason:'人工确认完整剧本并锁定台词正文。'});
      }
    }
  }
  const pins=[context.episode,context.outline.plan,context.outline.episodePlan,...context.outline.beats.map(row=>row.ref),...context.characters,...context.locations,...(context.previous?[context.previous.snapshot]:[])],bases=new Map(pins.map(row=>[row.id,row.version]));
  const request=captureScreenplay(Request,{schema_version:head.schema_version,id:raw.changeId,base_revision:head.revision.number,author:raw.author,status:'candidate',base_revisions:[...bases].map(([id,version])=>({id,version})),ops},'native screenplay request',SCREENPLAY_CANDIDATE_BYTES);
  const body={version:1 as const,target:raw.target,sourceRevision:head.revision.number,packageDigest:continuityDigest(head,SCREENPLAY_CONTEXT_BYTES),contextDigest:candidate.contextDigest,candidateDigest:candidate.digest,reviewDigest:review.digest,request,events,scenes,locks};
  return freezeScreenplay(captureScreenplay(ScreenplayNativeMappingSchema,{...body,digest:continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)},'native screenplay mapping',SCREENPLAY_CANDIDATE_BYTES));
}

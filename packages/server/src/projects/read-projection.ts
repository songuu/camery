import {z} from 'zod';
import {StableId} from '@camery/ir';
import type {StoryboardPackage} from '@camery/ir';
import {WorkbenchCollectionSchema,WorkbenchReadQuerySchema,WorkbenchSnapshotSchema} from '@camery/ir/workbench';
import type {WorkbenchObjectRef,WorkbenchReadQuery,WorkbenchSnapshot} from '@camery/ir/workbench';
import type {VersionProjectKey} from '@camery/versioning/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {decodeReadCursor,encodeReadCursor} from './read-cursor.js';

type Collection=WorkbenchObjectRef['collection'];
type ObjectRow={ref:WorkbenchObjectRef;value:Record<string,unknown>};
type Relation=WorkbenchSnapshot['relations'][number];
type Scope=WorkbenchSnapshot['scope'];
interface Input {projectKey:string;target:VersionProjectKey;subjectId:string;head:StoryboardPackage;writeVersion:number;query:WorkbenchReadQuery;capabilities:{canWrite:boolean;canReview:boolean}}
const positionSchema=z.strictObject({snapshotRevision:z.number().int().positive(),last:z.strictObject({collection:WorkbenchCollectionSchema,id:StableId})});
const MAX_BYTES=983040;
const scalarIds=new Set(['source_id','character_id','from_character_id','to_character_id','appearance_id','location_id','episode_id','scene_id','beat_id','speaker_id','rendition_id','shot_id','track_id','asset_id','line_id','default_voice_ref_id','adopted_asset_ref_id','visible_speaker_id','setup_episode_id','payoff_episode_id','world_id','continues_from','camera_placement_id']);
const arrayIds=new Set(['source_ids','scene_ids','character_ids','reference_asset_ref_ids','beat_refs','claim_ids','only_rendition_ids','asset_ref_ids','candidate_asset_ref_ids','affected_beat_ids','replacement_beat_ids','holding','episode_ids']);
const explicitRefs=new Set(['world','characters','relationships','development_plan','based_on','anchor_refs','continuity_from','media_asset_id','segment_revision_id','generated_from_segment','derived_from','adaptation_plan','character','beats','beat','episodes','assets','plot_units','decisions','affected_beats']);
const parents=new Set(['episode_id','scene_id','beat_id','shot_id','track_id','rendition_id']);
// These fields describe membership or a past/future index, rather than content needed to render the selected scope.
const noExpansion=new Set(['scene_ids','episode_ids','only_rendition_ids','setup_episode_id','payoff_episode_id']);
const key=(ref:Pick<WorkbenchObjectRef,'collection'|'id'>)=>ref.collection+':'+ref.id;
const compare=(left:ObjectRow,right:ObjectRow)=>key(left.ref)<key(right.ref)?-1:key(left.ref)>key(right.ref)?1:0;
function fail(code:'INVALID_INPUT'|'INPUT_LIMIT'|'NOT_FOUND'|'STORAGE_FAILED'|'SNAPSHOT_STALE',operation:string):never{throw new ProjectApplicationError(code,operation);}

/** Public metadata is not a media capability. A stored local path never crosses this projection. */
export function redactReadObject(collection:string,value:Record<string,unknown>):Record<string,unknown>{
  const result=structuredClone(value);
  if(collection==='assets'&&result['file']&&typeof result['file']==='object'&&!Array.isArray(result['file']))delete (result['file'] as Record<string,unknown>)['path'];
  return result;
}
function objects(head:StoryboardPackage):Map<string,ObjectRow>{
  const result=new Map<string,ObjectRow>();
  for(const [collection,values] of Object.entries(head))if(Array.isArray(values)&&WorkbenchCollectionSchema.safeParse(collection).success)for(const value of values){
    if(!value||typeof value!=='object'||!('id' in value)||!('version' in value))continue;
    if(typeof value.id!=='string'||!StableId.safeParse(value.id).success||!Number.isSafeInteger(value.version)||value.version<1||result.has(value.id))fail('STORAGE_FAILED','snapshot object identity');
    result.set(value.id,{ref:{collection:collection as Collection,id:value.id,version:value.version},value:value as Record<string,unknown>});
  }
  return result;
}
function relationships(row:ObjectRow,all:Map<string,ObjectRow>):Relation[]{
  const result:Relation[]=[];const unique=new Set<string>();
  const add=(id:unknown,field:string,name:string,version?:number)=>{
    if(typeof id!=='string')return;const target=all.get(id);if(!target)return;
    const kind:Relation['kind']=name==='continuity_from'||name==='continues_from'?'continuity':row.ref.collection==='shot_takes'&&['shot_id','media_asset_id','segment_revision_id'].includes(name)?'shot_take':parents.has(name)?'ownership':['source_id','source_ids','derived_from','generated_from_segment'].includes(name)?'provenance':'reference';
    const relation:Relation={kind,from:{...row.ref},to:{...target.ref,version:version??target.ref.version},field,pin:version===undefined?'snapshot':'explicit',currentVersion:target.ref.version,stale:version!==undefined&&version!==target.ref.version};
    const signature=JSON.stringify(relation);if(!unique.has(signature)){unique.add(signature);result.push(relation);}
  };
  const visit=(value:unknown,field:string,name:string):void=>{
    if(Array.isArray(value)){for(let index=0;index<value.length;index++){if(arrayIds.has(name))add(value[index],`${field}[${index}]`,name);else visit(value[index],`${field}[${index}]`,name);}return;}
    if(!value||typeof value!=='object')return;const record=value as Record<string,unknown>;
    if(explicitRefs.has(name)&&typeof record['id']==='string'&&typeof record['version']==='number'){add(record['id'],field,name,record['version']);return;}
    for(const [child,item] of Object.entries(record)){
      const path=field?field+'.'+child:child;
      if(scalarIds.has(child)||child==='target'&&row.ref.collection==='locks'||child==='ref'&&(field==='anchor'||field.endsWith('.anchor')))add(item,path,child);
      else visit(item,path,child);
    }
  };
  visit(row.value,'','');return result;
}
function scopeFor(head:StoryboardPackage,query:WorkbenchReadQuery):Scope{
  const episode=query.episodeId?head.episodes.find(row=>row.id===query.episodeId):undefined;
  const scene=query.sceneId?head.scenes.find(row=>row.id===query.sceneId):undefined;
  if(query.episodeId&&!episode||query.sceneId&&!scene||query.renditionId&&!head.renditions.some(row=>row.id===query.renditionId))fail('NOT_FOUND','snapshot scope');
  if(scene&&episode&&scene.episode_id!==episode.id)fail('INVALID_INPUT','snapshot scene episode binding');
  return scene?{kind:'scene',id:scene.id}:episode?{kind:'episode',id:episode.id}:{kind:'project',id:head.project.id};
}
function owner(row:ObjectRow,all:Map<string,ObjectRow>):{scene?:string;episode?:string}{
  const value=row.value;let scene:string|undefined;let episode:string|undefined;
  if(row.ref.collection==='episodes')episode=row.ref.id;
  else if(['scenes','episode_plans','outline_episode_plans','episode_state_snapshots','continuity_snapshots','audio_cues'].includes(row.ref.collection)&&typeof value['episode_id']==='string')episode=value['episode_id'];
  if(row.ref.collection==='scenes')scene=row.ref.id;
  else if(typeof value['scene_id']==='string')scene=value['scene_id'];
  else if(typeof value['shot_id']==='string')scene=all.get(value['shot_id'])?.value['scene_id'] as string|undefined;
  else{
    const line=typeof value['line_id']==='string'?all.get(value['line_id']):row.ref.collection==='lines'?row:undefined;
    const beatId=line?.value['beat_id'];if(typeof beatId==='string')scene=all.get(beatId)?.value['scene_id'] as string|undefined;
    if(!scene&&row.ref.collection==='audio_cues'){
      const anchor=value['anchor'] as {ref?:string}|undefined;const target=anchor?.ref?all.get(anchor.ref):undefined;if(target?.ref.collection==='scenes')scene=target.ref.id;else if(typeof target?.value['scene_id']==='string')scene=target.value['scene_id'];
    }
  }
  if(scene)episode=all.get(scene)?.value['episode_id'] as string|undefined;
  return {...(scene?{scene}:{}),...(episode?{episode}:{})};
}
function inRendition(row:ObjectRow,renditionId:string|undefined,all:Map<string,ObjectRow>):boolean{
  if(!renditionId)return true;if(row.ref.collection==='renditions')return row.ref.id===renditionId;
  if(row.ref.collection==='panels'||row.ref.collection==='shot_takes'){
    const shot=typeof row.value['shot_id']==='string'?all.get(row.value['shot_id']):undefined;return shot?.value['rendition_id']===renditionId;
  }
  if(typeof row.value['rendition_id']==='string')return row.value['rendition_id']===renditionId;
  const only=row.value['only_rendition_ids'];return !Array.isArray(only)||only.includes(renditionId);
}
function select(head:StoryboardPackage,all:Map<string,ObjectRow>,relations:Map<string,Relation[]>,scope:Scope,query:WorkbenchReadQuery):Map<string,'owned'|'context'>{
  const selected=new Map<string,'owned'|'context'>();
  const outlineEpisodes=new Set<string>(),outlineBeats=new Set<string>();
  if(scope.kind==='episode'&&(head.schema_version==='0.7.0-draft'||head.schema_version==='0.8.0-draft')){
    for(const episode of head.outline_episode_plans)if(episode.episode_id===scope.id){outlineEpisodes.add(episode.id);for(const beat of episode.beats)outlineBeats.add(beat.id);}
  }
  for(const row of all.values()){
    // Locks follow selected targets below; selecting them first could pull an unrelated rendition back into view.
    if(row.ref.collection==='locks'||!inRendition(row,query.renditionId,all))continue;const located=owner(row,all);
    if(scope.kind==='project'||scope.kind==='scene'&&located.scene===scope.id||scope.kind==='episode'&&(located.episode===scope.id||row.ref.collection==='plot_units'&&Array.isArray(row.value['episode_ids'])&&row.value['episode_ids'].includes(scope.id)))selected.set(row.ref.id,'owned');
    if(scope.kind==='episode'&&(row.ref.collection==='outline_beats'&&outlineBeats.has(row.ref.id)||row.ref.collection==='asset_plans'&&Array.isArray(row.value['beats'])&&row.value['beats'].some((ref:unknown)=>!!ref&&typeof ref==='object'&&'id' in ref&&outlineBeats.has(String(ref.id)))||row.ref.collection==='outline_plot_units'&&Array.isArray(row.value['episodes'])&&row.value['episodes'].some((ref:unknown)=>!!ref&&typeof ref==='object'&&'id' in ref&&outlineEpisodes.has(String(ref.id)))))selected.set(row.ref.id,'owned');
  }
  if(scope.kind==='scene'){
    const episode=all.get(scope.id)?.value['episode_id'];
    for(const row of all.values())if(['episode_plans','outline_episode_plans'].includes(row.ref.collection)&&row.value['episode_id']===episode)selected.set(row.ref.id,'context');
  }
  const queue=[...selected.keys()];
  for(let index=0;index<queue.length;index++)for(const relation of relations.get(queue[index]!)??[]){
    // The season parent is context; following all its memberships would pull every other episode into this view.
    if(scope.kind!=='project'&&relation.from.collection==='adaptation_plans'&&!relation.field.startsWith('characters['))continue;
    if(scope.kind==='episode'&&(relation.to.collection==='outline_episode_plans'&&!outlineEpisodes.has(relation.to.id)||relation.to.collection==='outline_beats'&&!outlineBeats.has(relation.to.id)))continue;
    const field=relation.field.split(/[.[]/).filter(Boolean).at(-1)!;
    // Do not re-expand an appearance's scene index into every scene that happens to share it.
    if(noExpansion.has(field)||[...noExpansion].some(name=>relation.field===name||relation.field.startsWith(name+'[')||relation.field.endsWith('.'+name)))continue;
    if(!selected.has(relation.to.id)){selected.set(relation.to.id,'context');queue.push(relation.to.id);}
  }
  for(const lock of head.locks)if(selected.has(lock.target)&&!selected.has(lock.id))selected.set(lock.id,'context');
  return selected;
}

/** Read-only projection of one adopted snapshot; cursors never stitch together different revisions. */
export function projectReadSnapshot(input:Input):WorkbenchSnapshot{
  const {projectKey,target,subjectId,head,writeVersion,capabilities}=input;const parsed=WorkbenchReadQuerySchema.safeParse(input.query);if(!parsed.success)fail('INVALID_INPUT','snapshot query');const query=parsed.data;
  if(head.project.id!==target.projectId||head.revision.status!=='adopted')fail('STORAGE_FAILED','snapshot target binding');
  const binding={kind:'snapshot',projectKey,target,subjectId,episodeId:query.episodeId??null,sceneId:query.sceneId??null,renditionId:query.renditionId??null,collection:query.collection??null};
  const cursor=query.cursor?decodeReadCursor(binding,query.cursor,positionSchema):undefined;
  if(query.expectedRevision!==undefined&&query.expectedRevision!==head.revision.number||cursor&&cursor.snapshotRevision!==head.revision.number)fail('SNAPSHOT_STALE','snapshot page baseline');
  const scope=scopeFor(head,query);const all=objects(head);const relations=new Map([...all].map(([id,row])=>[id,relationships(row,all)]));const selected=select(head,all,relations,scope,query);
  const rows=[...all.values()].filter(row=>selected.has(row.ref.id)&&(!query.collection||row.ref.collection===query.collection)).sort(compare);
  let start=0;if(cursor){const index=rows.findIndex(row=>key(row.ref)===key(cursor.last));if(index<0)fail('INVALID_INPUT','snapshot cursor position');start=index+1;}
  const counts=new Map<Collection,number>();for(const row of rows)counts.set(row.ref.collection,(counts.get(row.ref.collection)??0)+1);
  const selectedPage=rows.slice(start,start+(query.limit??100));
  const build=()=>{
    const ids=new Set(selectedPage.map(row=>row.ref.id));const last=selectedPage.at(-1);const nextCursor=last&&start+selectedPage.length<rows.length?encodeReadCursor(binding,{snapshotRevision:head.revision.number,last:{collection:last.ref.collection,id:last.ref.id}}):null;
    return {contractVersion:1 as const,projectKey,projectId:target.projectId,schemaVersion:head.schema_version,snapshotRevision:head.revision.number,writeVersion,scope,renditionId:query.renditionId??null,nextCursor,
      counts:[...counts].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([collection,count])=>({collection,count})),capabilities:{canWrite:capabilities.canWrite,canReview:capabilities.canReview,canReadMedia:false as const},
      rows:selectedPage.map(row=>({ref:{...row.ref},role:selected.get(row.ref.id)!,value:redactReadObject(row.ref.collection,row.value)})),
      relations:selectedPage.flatMap(row=>relations.get(row.ref.id)??[]),
      lineage:head.shot_lineage.filter(row=>[...row.from_ids,...row.to_ids].some(id=>ids.has(id))).map(row=>structuredClone(row)),
      locks:head.locks.filter(row=>ids.has(row.target)||ids.has(row.id)).map(row=>({ref:{collection:'locks' as const,id:row.id,version:row.version},target:row.target,fields:[...row.fields],ownerId:row.owner_id,reason:row.reason})),
    };
  };
  for(;;){
    const page=build();const result=WorkbenchSnapshotSchema.safeParse(page);
    if(!result.success&&result.error.issues.some(issue=>issue.code!=='too_big'))fail('STORAGE_FAILED','snapshot projection integrity');
    if(result.success&&Buffer.byteLength(JSON.stringify(page),'utf8')<=MAX_BYTES)return result.data;
    if(selectedPage.length<=1)fail('INPUT_LIMIT','snapshot page object budget');selectedPage.pop();
  }
}

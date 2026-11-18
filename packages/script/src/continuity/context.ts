import {StoryboardPackage,validatePackage} from '@camery/ir';
import {captureContinuity,freezeContinuity} from './boundary.js';
import {CONTINUITY_CONTEXT_BYTES,CONTINUITY_DRAFT_BYTES,ContinuityContextSchema,ContinuityDraftSchema,ContinuityError} from './contracts.js';
import type {ContinuityContext,ContinuityDraft} from './contracts.js';

function invalid(path:string):never{throw new ContinuityError('INVALID_REFERENCE','source check',path);}
function unique(values:readonly string[],path:string):void{if(new Set(values).size!==values.length)invalid(path);}
const byKey=<T extends {order_key:string}>(rows:readonly T[])=>[...rows].sort((a,b)=>a.order_key<b.order_key?-1:a.order_key>b.order_key?1:0);
function orderedGroups<T extends {order_key:string}>(rows:readonly T[],owner:(row:T)=>string):Map<string,T[]>{
  const groups=new Map<string,T[]>();for(const row of rows){const key=owner(row),group=groups.get(key);if(group)group.push(row);else groups.set(key,[row]);}
  for(const [key,group] of groups)groups.set(key,byKey(group));return groups;
}

/** This only proves captured relationships; a trusted store must supply the actual adopted package. */
export function validateContinuityContext(input:unknown):ContinuityContext{
  const context=captureContinuity(ContinuityContextSchema,input,'context',CONTINUITY_CONTEXT_BYTES);
  const allIds=new Set<string>();
  for(const [name,rows] of Object.entries({episodes:context.episodes,characters:context.characters,props:context.props,appearances:context.appearances,spots:context.spots})){
    for(const [index,row] of rows.entries()){if(allIds.has(row.id))invalid(`${name}.${index}.id`);allIds.add(row.id);}
  }
  const episodes=new Map(context.episodes.map((episode,index)=>{if(episode.number!==index+1)invalid(`episodes.${index}.number`);return [episode.id,episode];}));
  const characters=new Set(context.characters.map(item=>item.id));
  context.appearances.forEach((item,index)=>{if(!characters.has(item.characterId))invalid(`appearances.${index}.characterId`);});
  const locations=new Map<string,number>();
  context.spots.forEach((item,index)=>{
    const previous=locations.get(item.location.id);
    if(allIds.has(item.location.id)||(previous!==undefined&&previous!==item.location.version))invalid(`spots.${index}.location`);
    locations.set(item.location.id,item.location.version);
  });
  let episodeNumber=0,sequence=0;
  context.events.forEach((event,index)=>{
    const path=`events.${index}`,episode=episodes.get(event.episodeId);
    if(!episode||episode.number<episodeNumber)invalid(path+'.episodeId');
    if(episode.number!==episodeNumber){episodeNumber=episode.number;sequence=0;}
    if(event.sequence!==++sequence)invalid(path+'.sequence');
    if(allIds.has(event.ref.id)||locations.has(event.ref.id))invalid(path+'.ref');allIds.add(event.ref.id);
    unique(event.characterIds,path+'.characterIds');for(const characterId of event.characterIds)if(!characters.has(characterId))invalid(path+'.characterIds');
    if(event.ref.kind==='beat'?event.speakerId!==null:event.speakerId===null||!event.characterIds.includes(event.speakerId))invalid(path+'.speakerId');
    if(event.ref.kind==='beat'?event.lineKind!==null:event.lineKind===null)invalid(path+'.lineKind');
    if(!event.text.isWellFormed()||event.text.includes('\0'))invalid(path+'.text');
  });
  return freezeContinuity(context);
}

/** Preserve complete beat/line text and declared sequence; never infer facts from prose. */
export function captureContinuityContext(input:unknown):ContinuityContext{
  const pkg=captureContinuity(StoryboardPackage,input,'native package',CONTINUITY_CONTEXT_BYTES);
  if(pkg.revision.status!=='adopted')throw new ContinuityError('UNADOPTED_SNAPSHOT','native package','revision.status');
  const report=validatePackage(pkg);if(!report.valid)invalid(report.errors[0]!.where);
  pkg.scenes.forEach((scene,index)=>unique(scene.character_ids,`scenes.${index}.character_ids`));
  const ordered=byKey(pkg.episodes),episodes=ordered.map((episode,index)=>({id:episode.id,version:episode.version,number:index+1}));
  const scenes=orderedGroups(pkg.scenes,item=>item.episode_id),beats=orderedGroups(pkg.beats,item=>item.scene_id),lines=orderedGroups(pkg.lines,item=>item.beat_id);
  const events:ContinuityContext['events']=[];
  for(const episode of ordered){let sequence=0;
    for(const scene of scenes.get(episode.id)??[])for(const beat of beats.get(scene.id)??[]){
      events.push({ref:{kind:'beat',id:beat.id,version:beat.version},episodeId:episode.id,sequence:++sequence,characterIds:[...scene.character_ids],speakerId:null,lineKind:null,text:beat.summary});
      for(const line of lines.get(beat.id)??[])events.push({ref:{kind:'line',id:line.id,version:line.version},episodeId:episode.id,sequence:++sequence,characterIds:[...scene.character_ids],speakerId:line.speaker_id,lineKind:line.kind,text:line.text});
    }
  }
  return validateContinuityContext({version:1,projectId:pkg.project.id,packageId:pkg.package_id,snapshotRevision:pkg.revision.number,episodes,
    characters:pkg.characters.map(({id,version})=>({id,version})),props:pkg.props.map(({id,version})=>({id,version})),
    appearances:pkg.appearances.map(item=>({id:item.id,version:item.version,characterId:item.character_id})),
    spots:pkg.locations.flatMap(location=>location.spots.map(spot=>({id:spot.id,location:{id:location.id,version:location.version}}))),events});
}

export function validateContinuityDraft(contextInput:unknown,input:unknown):ContinuityDraft{
  const context=validateContinuityContext(contextInput),draft=captureContinuity(ContinuityDraftSchema,input,'events',CONTINUITY_DRAFT_BYTES);
  const episode=context.episodes.find(item=>item.id===draft.episodeId);if(!episode)invalid('episodeId');
  unique(draft.events.map(event=>event.id),'events.id');
  const byId=new Map(context.events.map(event=>[event.ref.id,event])),characters=new Set(context.characters.map(item=>item.id));
  const appearances=new Map(context.appearances.map(item=>[item.id,item])),spots=new Map(context.spots.map(item=>[item.id,item])),props=new Map(context.props.map(item=>[item.id,item]));
  let sequence=0;
  draft.events.forEach((event,index)=>{
    const path=`events.${index}`,actual=byId.get(event.evidence.event.id),ref=event.evidence.event;
    if(!actual||actual.ref.kind!==ref.kind||actual.ref.version!==ref.version||actual.episodeId!==draft.episodeId)invalid(path+'.evidence.event');
    if(actual.sequence<sequence)invalid(path+'.evidence.event');sequence=actual.sequence;
    if(!actual.text.includes(event.evidence.quote))invalid(path+'.evidence.quote');
    const participant=event.op==='set_character'?event.value.characterId:event.op==='learn'||event.op==='use_fact'?event.characterId:null;
    if(participant!==null&&!actual.characterIds.includes(participant))invalid(path+'.characterId');
    if(event.op==='learn'){
      if(event.source.kind==='told'&&!characters.has(event.source.fromCharacterId))invalid(path+'.source.fromCharacterId');
      if(event.source.kind==='deduced')unique(event.source.factIds,path+'.source.factIds');
    }
    if(event.op==='set_character'){
      const value=event.value;
      if(value.appearance){const appearance=appearances.get(value.appearance.id);if(!appearance||appearance.version!==value.appearance.version||appearance.characterId!==value.characterId)invalid(path+'.value.appearance');}
      if(value.spot){const spot=spots.get(value.spot.id);if(!spot||spot.location.id!==value.spot.location.id||spot.location.version!==value.spot.location.version)invalid(path+'.value.spot');}
      unique(value.holding.map(item=>item.id),path+'.value.holding');for(const prop of value.holding)if(props.get(prop.id)?.version!==prop.version)invalid(path+'.value.holding');
    }
    if(event.op==='plant'&&event.payoffEpisodeId!==null){const payoff=context.episodes.find(item=>item.id===event.payoffEpisodeId);if(!payoff||payoff.number<episode.number)invalid(path+'.payoffEpisodeId');}
  });
  return freezeContinuity(draft);
}

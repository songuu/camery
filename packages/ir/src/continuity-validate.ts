import {CONTINUITY_LEDGER_BYTES} from './continuity-schema';
import type {ContinuitySnapshot,LedgerEvidence} from './continuity-schema';
import type {StoryboardPackageV08} from './schema';
import type {Issue} from './legacy/v05-validate';
type Required={id:string;version?:number;collection:string};
export interface ContinuityDependencyIssue {readonly objectId:string;readonly referenceId:string;readonly expectedVersion:number;readonly actualVersion:number|null}
function evidenceRows(snapshot:ContinuitySnapshot):LedgerEvidence[]{
  const l=snapshot.ledger;return [...l.facts.flatMap(row=>[row.introduced,...(row.retired?[row.retired]:[])]),...l.knowledge.map(row=>row.learned),...l.characters.map(row=>row.changed),...l.threads.flatMap(row=>[row.planted,...(row.paidOff?[row.paidOff]:[])])];
}
function required(snapshot:ContinuitySnapshot):Required[]{
  const l=snapshot.ledger,result:Required[]=[{id:snapshot.episode_id,collection:'episodes'}];
  for(const row of evidenceRows(snapshot))result.push({id:row.episodeId,collection:'episodes'},{...row.evidence.event,collection:row.evidence.event.kind==='beat'?'beats':'lines'});
  for(const row of l.knowledge){result.push({id:row.characterId,collection:'characters'});if(row.source.kind==='told')result.push({id:row.source.fromCharacterId,collection:'characters'});}
  for(const {value} of l.characters){result.push({id:value.characterId,collection:'characters'});if(value.appearance)result.push({...value.appearance,collection:'appearances'});if(value.spot)result.push({...value.spot.location,collection:'locations'});result.push(...value.holding.map(ref=>({...ref,collection:'props'})));}
  for(const row of l.threads)if(row.payoffEpisodeId)result.push({id:row.payoffEpisodeId,collection:'episodes'});return result;
}
function objects(p:StoryboardPackageV08):Map<string,{collection:string;version:number}>{
  const result=new Map<string,{collection:string;version:number}>();for(const [collection,rows] of Object.entries(p))if(Array.isArray(rows))for(const row of rows)if(row&&typeof row==='object'&&'id'in row&&'version'in row)result.set(row.id,{collection,version:row.version});return result;
}
function orderedGroups<T extends {order_key:string}>(rows:readonly T[],key:(row:T)=>string):Map<string,T[]>{
  const groups=new Map<string,T[]>();for(const row of rows){const id=key(row),group=groups.get(id);if(group)group.push(row);else groups.set(id,[row]);}
  for(const group of groups.values())group.sort((a,b)=>a.order_key<b.order_key?-1:a.order_key>b.order_key?1:0);return groups;
}
/** A stale pin remains readable history, but consumers must reject it before deriving new episode constraints. */
export function continuityDependencyIssues(p:StoryboardPackageV08):readonly ContinuityDependencyIssue[]{
  const versions=objects(p);return p.continuity_snapshots.flatMap(snapshot=>snapshot.based_on.filter(ref=>versions.get(ref.id)?.version!==ref.version).map(ref=>({objectId:snapshot.id,referenceId:ref.id,expectedVersion:ref.version,actualVersion:versions.get(ref.id)?.version??null})));
}
/** Structural provenance and freshness only. Human authorization and full event replay belong to the adoption host. */
export function validateContinuityGraph(p:StoryboardPackageV08):{errors:Issue[];warnings:Issue[]}{
  if(p.continuity_snapshots.length===0)return {errors:[],warnings:[]};
  const errors:Issue[]=[],warnings:Issue[]=[],all=objects(p),episodes=p.episodes.toSorted((a,b)=>a.order_key<b.order_key?-1:a.order_key>b.order_key?1:0),episodeIndex=new Map(episodes.map((row,index)=>[row.id,index]));
  const scenes=new Map(p.scenes.map(row=>[row.id,row])),beats=new Map(p.beats.map(row=>[row.id,row])),lines=new Map(p.lines.map(row=>[row.id,row]));
  const eventPositions=new Map<string,readonly number[]>(),scenesByEpisode=orderedGroups(p.scenes,row=>row.episode_id),beatsByScene=orderedGroups(p.beats,row=>row.scene_id),linesByBeat=orderedGroups(p.lines,row=>row.beat_id);
  // Build native event order once; ledger size must not multiply full-script sorting and scans.
  for(const [ei,episode] of episodes.entries())for(const [si,scene] of (scenesByEpisode.get(episode.id)??[]).entries())for(const [bi,beat] of (beatsByScene.get(scene.id)??[]).entries()){
    eventPositions.set(beat.id,[ei,si,bi,0]);for(const [li,line] of (linesByBeat.get(beat.id)??[]).entries())eventPositions.set(line.id,[ei,si,bi,li+1]);
  }
  const error=(where:string,message:string,code='CONTINUITY_REFERENCE')=>{errors.push({code,where,message});};
  const unique=(values:readonly string[],where:string)=>{if(new Set(values).size!==values.length)error(where,'Continuity keys must be unique','CONTINUITY_DUPLICATE');};
  unique(p.continuity_snapshots.map(row=>row.episode_id),'/continuity_snapshots/episode_id');
  for(const [index,snapshot] of p.continuity_snapshots.entries()){
    const path=`/continuity_snapshots/${index}`,l=snapshot.ledger,pins=new Map(snapshot.based_on.map(ref=>[ref.id,ref.version]));
    const fresh=snapshot.based_on.every(ref=>all.get(ref.id)?.version===ref.version),dependencies=required(snapshot);
    // Parent order and ownership are versioned too. Never reconstruct old parentage from a changed live graph.
    if(fresh)for(const row of evidenceRows(snapshot)){
      const ref=row.evidence.event,line=ref.kind==='line'?lines.get(ref.id):undefined,beat=ref.kind==='beat'?beats.get(ref.id):line?beats.get(line.beat_id):undefined;
      if(beat){dependencies.push({id:beat.scene_id,collection:'scenes'});if(line)dependencies.push({id:beat.id,collection:'beats'});}
    }
    unique(snapshot.based_on.map(ref=>ref.id),path+'/based_on');unique(l.facts.map(row=>row.id),path+'/ledger/facts');unique(l.knowledge.map(row=>row.characterId+'/'+row.factId),path+'/ledger/knowledge');unique(l.characters.map(row=>row.value.characterId),path+'/ledger/characters');unique(l.threads.map(row=>row.id),path+'/ledger/threads');
    if(l.projectId!==p.project.id||l.packageId!==p.package_id||l.episodeId!==snapshot.episode_id||l.snapshotRevision>p.revision.number)error(path+'/ledger','Ledger must bind this package, project, episode and an existing source revision','CONTINUITY_SCOPE');
    if(new TextEncoder().encode(JSON.stringify(l)).byteLength>CONTINUITY_LEDGER_BYTES)error(path+'/ledger','Complete ledger exceeds its UTF-8 budget','CONTINUITY_LIMIT');
    for(const ref of dependencies){
      const row=all.get(ref.id);if(!row||row.collection!==ref.collection)error(path+'/ledger','Referenced object is absent from its expected collection');
      if(!pins.has(ref.id)||ref.version!==undefined&&pins.get(ref.id)!==ref.version)error(path+'/based_on','Every ledger dependency must retain its exact pin');
    }
    for(const ref of snapshot.based_on)if(!all.has(ref.id)||ref.id===snapshot.id||all.get(ref.id)?.collection==='continuity_snapshots')error(path+'/based_on','Pins require existing independent versioned content');
    const evidence=(row:LedgerEvidence,where:string):void=>{
      if(!fresh)return;
      const ep=episodeIndex.get(row.episodeId),current=episodeIndex.get(snapshot.episode_id);
      if(ep===undefined||current===undefined||ep>current)error(where,'Evidence cannot come from an unknown or future episode','CONTINUITY_ORDER');
      const ref=row.evidence.event,line=ref.kind==='line'?lines.get(ref.id):undefined,beat=ref.kind==='beat'?beats.get(ref.id):line?beats.get(line.beat_id):undefined,scene=beat?scenes.get(beat.scene_id):undefined,object=ref.kind==='line'?line:beat;
      // Current text cannot disprove historical text at a stale revision; freshness is reported separately below.
      if(object?.version===ref.version){if(scene?.episode_id!==row.episodeId)error(where,'Evidence belongs to a different episode','CONTINUITY_SCOPE');const text=ref.kind==='line'?line!.text:beat!.summary;if(!text.includes(row.evidence.quote))error(where,'Evidence quote is absent from the exact native event','CONTINUITY_EVIDENCE');}
    };
    for(const row of evidenceRows(snapshot))evidence(row,path+'/ledger/evidence');
    const after=(left:LedgerEvidence,right:LedgerEvidence)=>{if(!fresh)return false;const a=eventPositions.get(left.evidence.event.id),b=eventPositions.get(right.evidence.event.id);if(!a||!b)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]!>b[i]!;return left.order>right.order;};
    for(const row of l.facts)if(row.retired&&after(row.introduced,row.retired))error(path+'/ledger/facts','Retirement precedes introduction','CONTINUITY_ORDER');
    for(const row of l.knowledge){const fact=l.facts.find(fact=>fact.id===row.factId);if(!fact)error(path+'/ledger/knowledge','Knowledge requires a ledger fact');else if(after(fact.introduced,row.learned)||fact.retired&&after(row.learned,fact.retired))error(path+'/ledger/knowledge','Learning is outside the fact lifetime','CONTINUITY_ORDER');if(row.source.kind==='deduced'){unique(row.source.factIds,path+'/ledger/knowledge/source');if(row.source.factIds.includes(row.factId)||row.source.factIds.some(id=>!l.facts.some(fact=>fact.id===id)))error(path+'/ledger/knowledge/source','Deduction requires independent existing facts');}}
    for(const {value} of l.characters){unique(value.holding.map(ref=>ref.id),path+'/ledger/characters/holding');if(!fresh)continue;const appearance=value.appearance?p.appearances.find(row=>row.id===value.appearance!.id):undefined;if(appearance?.version===value.appearance?.version&&appearance&&appearance.character_id!==value.characterId)error(path+'/ledger/characters/appearance','Appearance belongs to a different character','CONTINUITY_SCOPE');if(value.spot){const location=p.locations.find(row=>row.id===value.spot!.location.id);if(location?.version===value.spot.location.version&&!location.spots.some(row=>row.id===value.spot!.id))error(path+'/ledger/characters/spot','Spot is absent from its exact location','CONTINUITY_SCOPE');}}
    for(const row of l.threads){if(!fresh)continue;const planted=episodeIndex.get(row.planted.episodeId),payoff=row.payoffEpisodeId?episodeIndex.get(row.payoffEpisodeId):undefined;if(payoff!==undefined&&planted!==undefined&&payoff<planted||row.paidOff&&(after(row.planted,row.paidOff)||payoff!==undefined&&(episodeIndex.get(row.paidOff.episodeId)??-1)<payoff))error(path+'/ledger/threads','Thread payoff precedes its planting or planned episode','CONTINUITY_ORDER');}
  }
  for(const issue of continuityDependencyIssues(p)){const message=`Continuity dependency ${issue.referenceId} is pinned to ${issue.expectedVersion}; current version is ${issue.actualVersion}`;if(issue.actualVersion===null)error('/objects/'+issue.objectId,message);else if(issue.expectedVersion>issue.actualVersion)error('/objects/'+issue.objectId,message,'FUTURE_CONTINUITY_DEPENDENCY');else warnings.push({code:'STALE_CONTINUITY_DEPENDENCY',where:'/objects/'+issue.objectId,message});}
  return {errors,warnings};
}

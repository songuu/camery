import {ChangeSetV08,upgradeV07Package} from '@camery/ir';
import type {StoryboardPackageV08} from '@camery/ir';
import {makeOutlinePackage} from '../../ir/test/outline-formal-fixture';
import {changeSet,fixtureId as id} from '../../ir/test/fixtures';

export function makeContinuityPackage():StoryboardPackageV08{return upgradeV07Package(makeOutlinePackage());}
export function continuitySnapshot(p:StoryboardPackageV08,alias='continuity-snapshot'):StoryboardPackageV08['continuity_snapshots'][number]{
  const episode=p.episodes[0]!;
  return {id:id(alias),version:1,episode_id:episode.id,based_on:[{id:episode.id,version:episode.version}],ledger:{version:1 as const,projectId:p.project.id,packageId:p.package_id,episodeId:episode.id,snapshotRevision:p.revision.number,facts:[],knowledge:[],characters:[],threads:[]}};
}
export function completeContinuitySnapshot(p:StoryboardPackageV08,alias='complete-continuity-snapshot'):StoryboardPackageV08['continuity_snapshots'][number]{
  const snapshot=continuitySnapshot(p,alias),line=p.lines[0]!,episode=p.episodes[0]!,character=p.characters.find(row=>row.id===line.speaker_id)!;
  const evidence=(eventId:string,order:number)=>({episodeId:episode.id,eventId,order,evidence:{event:{kind:'line' as const,id:line.id,version:line.version},quote:line.text}});
  const beat=p.beats.find(row=>row.id===line.beat_id)!,scene=p.scenes.find(row=>row.id===beat.scene_id)!;
  snapshot.based_on.push(...[line,character,beat,scene].map(({id,version})=>({id,version})));
  snapshot.ledger.facts.push({id:'letter',kind:'fact',text:'便签内容已由角色明确说出。',introduced:evidence('fact-letter',1),retired:null});
  snapshot.ledger.knowledge.push({characterId:character.id,factId:'letter',source:{kind:'witness'},learned:evidence('learn-letter',2)});
  snapshot.ledger.characters.push({value:{characterId:character.id,summary:'决定保留并核对便签。',appearance:null,spot:null,holding:[]},changed:evidence('state-letter',3)});
  snapshot.ledger.threads.push({id:'letter-origin',summary:'追查便签的来历。',payoffEpisodeId:null,planted:evidence('plant-letter',4),paidOff:null});return snapshot;
}
export function continuityUpgrade(base=5){return ChangeSetV08.parse({...changeSet([]),schema_version:'0.8.0-draft',id:id('continuity-upgrade'),base_revision:base,ops:[{op_id:id('continuity-upgrade-op'),op:'upgrade_schema',from:'0.7.0-draft',to:'0.8.0-draft'}]});}
export function continuityAdd(p:StoryboardPackageV08,alias='continuity-snapshot'){
  return ChangeSetV08.parse({...changeSet([]),schema_version:'0.8.0-draft',id:id(alias+'-change'),base_revision:p.revision.number,ops:[{op_id:id(alias+'-op'),op:'add',collection:'continuity_snapshots',value:continuitySnapshot(p,alias)}]});
}

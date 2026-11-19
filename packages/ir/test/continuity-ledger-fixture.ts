import {upgradeV07Package} from '../src/schema';
import type {StoryboardPackageV08,LedgerEvidence} from '../src/schema';
import {makeOutlinePackage} from './outline-formal-fixture';
import {fixtureId as id} from './fixtures';
/** Full typed four-ledger fixture uses real native evidence, never invented stage-2 assets. */
export function makeContinuityPackage():StoryboardPackageV08{
  const p=upgradeV07Package(makeOutlinePackage()),episode=p.episodes[0]!,beat=p.beats.find(row=>p.scenes.find(scene=>scene.id===row.scene_id)?.episode_id===episode.id)!,character=p.characters[0]!;
  const evidence=(eventId:string,order:number):LedgerEvidence=>({episodeId:episode.id,eventId,order,evidence:{event:{kind:'beat',id:beat.id,version:beat.version},quote:beat.summary}});
  const refs=[episode,beat,character,p.scenes.find(row=>row.id===beat.scene_id)!].map(({id,version})=>({id,version}));
  p.continuity_snapshots.push({id:id('continuity-snapshot'),version:1,episode_id:episode.id,based_on:refs,ledger:{version:1,projectId:p.project.id,packageId:p.package_id,episodeId:episode.id,snapshotRevision:p.revision.number,
    facts:[{id:'fact.clock',kind:'fact',text:'钟塔来信已核实。',introduced:evidence('assert.clock',1),retired:null}],
    knowledge:[{characterId:character.id,factId:'fact.clock',source:{kind:'witness'},learned:evidence('learn.clock',2)}],
    characters:[{value:{characterId:character.id,summary:'已核实来信，决定公开。',appearance:null,spot:null,holding:[]},changed:evidence('state.clock',3)}],
    threads:[{id:'thread.letter',summary:'公开来信会改变谁的选择？',payoffEpisodeId:episode.id,planted:evidence('plant.letter',4),paidOff:evidence('payoff.letter',5)}],
  }});return p;
}

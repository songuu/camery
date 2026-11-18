import {makeOutlinePackage} from './outline-formal-fixture';
import {fixtureId} from './fixtures';

/** Maximum row counts with real typed references. This is a formal-graph fixture, not an outline mapper or provider receipt. */
export function makeCapacityOutlinePackage(){
  const p=makeOutlinePackage(),plan=p.adaptation_plans[0]!,baseCharacter=p.characters[0]!,baseEpisode=p.episodes[0]!;
  const beat=p.outline_beats[0]!,episode=p.outline_episode_plans[0]!,asset=p.asset_plans[0]!,unit=p.outline_plot_units[0]!,decision=p.outline_adaptation_decisions[0]!;
  const ref=(id:string)=>({id,version:1});
  for(const character of p.characters)if(!character.development)character.development={...baseCharacter.development!,function:'supporting'};
  for(let index=p.characters.length;index<64;index++)p.characters.push({...structuredClone(baseCharacter),id:fixtureId(`outline-capacity-character-${index}`),name:`人物${index+1}`,development:{...baseCharacter.development!,function:'supporting'}});
  // The unchanged development fixture may already contain more than one formal Episode.
  for(let index=p.episodes.length;index<100;index++)p.episodes.push({...structuredClone(baseEpisode),id:fixtureId(`outline-capacity-formal-episode-${index}`),title:`第${index+1}集`,order_key:`z${String(index).padStart(3,'0')}`});
  p.project.scope.expected_episode_count=100;
  p.outline_beats=Array.from({length:500},(_,index)=>({...structuredClone(beat),id:fixtureId(`outline-capacity-beat-${index}`),episode_number:Math.floor(index/5)+1,order:index%5+1}));
  p.outline_episode_plans=Array.from({length:100},(_,index)=>{const beats=p.outline_beats.slice(index*5,index*5+5).map(row=>ref(row.id));return {...structuredClone(episode),id:fixtureId(`outline-capacity-episode-${index}`),episode_id:p.episodes[index]!.id,number:index+1,title:`第${index+1}集`,beats,opening_hook:{...episode.opening_hook,beat:beats[0]!},stakes:{...episode.stakes,beat:beats[1]!},cliffhanger:{...episode.cliffhanger,beat:beats[4]!},paid_breakpoint:index===99};});
  p.asset_plans=Array.from({length:256},(_,index)=>{const beat=ref(p.outline_beats[index]!.id);return {...structuredClone(asset),id:fixtureId(`outline-capacity-asset-${index}`),name:`叙事道具${index+1}`,beats:[beat],prop_states:[{...asset.prop_states[0]!,beat}]};});
  p.outline_plot_units=Array.from({length:100},(_,index)=>({...structuredClone(unit),id:fixtureId(`outline-capacity-unit-${index}`),episodes:[ref(p.outline_episode_plans[index]!.id)],beats:structuredClone(p.outline_episode_plans[index]!.beats)}));
  p.outline_adaptation_decisions=Array.from({length:128},(_,index)=>({...structuredClone(decision),id:fixtureId(`outline-capacity-decision-${index}`)}));
  plan.brief.episode_count=100;plan.brief.paid_episode_numbers=[100];plan.characters=p.characters.slice(0,64).map(character=>({character:ref(character.id),origin:structuredClone(plan.characters[0]!.origin)}));
  plan.beats=p.outline_beats.map(row=>ref(row.id));plan.episodes=p.outline_episode_plans.map(row=>ref(row.id));plan.assets=p.asset_plans.map(row=>ref(row.id));plan.plot_units=p.outline_plot_units.map(row=>ref(row.id));plan.decisions=p.outline_adaptation_decisions.map(row=>ref(row.id));
  plan.recipe.signature_scenes[0]!.beats=[ref(p.outline_beats[0]!.id)];plan.season_engine.characters=plan.characters.map(row=>row.character);plan.season_engine.plot_units=structuredClone(plan.plot_units);
  plan.review.report.emotion_curve=p.outline_episode_plans.map(row=>({episode_number:row.number,intensity:row.emotion_intensity}));return p;
}

import {makeContinuityPackage} from '../../ir/test/continuity-ledger-fixture.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {captureContinuityContext} from '../src/continuity/context.js';
import type {ScreenplayContext,ScreenplayDraft} from '../src/screenplay/contracts.js';

/** Pure writing data only; Node source tests separately establish native and stored human authority. */
export function screenplayFixture(episodeNumber=1){
  const head=makeContinuityPackage();
  if(episodeNumber===2){
    const first=head.outline_episode_plans[0]!,plan=head.adaptation_plans[0]!,beat=head.outline_beats[0]!,beatRef={id:id('screenplay-second-outline-beat'),version:1},episodeRef={id:id('screenplay-second-outline-plan'),version:1};
    plan.brief.episode_count=2;plan.beats.push(beatRef);plan.episodes.push(episodeRef);plan.review.report.emotion_curve.push({episode_number:2,intensity:7});
    head.outline_beats.push({...beat,...beatRef,episode_number:2,order:1});
    head.outline_episode_plans.push({...first,...episodeRef,episode_id:head.episodes[1]!.id,number:2,title:'测试第二集',beats:[beatRef],opening_hook:{...first.opening_hook,beat:beatRef},stakes:{...first.stakes,beat:beatRef},cliffhanger:{...first.cliffhanger,beat:beatRef},paid_breakpoint:false});
    head.outline_plot_units[0]!.episodes.push(episodeRef);head.outline_plot_units[0]!.beats.push(beatRef);
  }
  const nativeContext=captureContinuityContext(head),episode=nativeContext.episodes[episodeNumber-1]!;
  const nativeEpisode=head.episodes.find(row=>row.id===episode.id)!,episodePlan=head.outline_episode_plans.find(row=>row.episode_id===episode.id)!,plan=head.adaptation_plans.find(row=>row.id===episodePlan.adaptation_plan.id)!;
  const beats=episodePlan.beats.map(ref=>head.outline_beats.find(row=>row.id===ref.id)!).sort((a,b)=>a.order-b.order);
  const modules=Array.from({length:5},(_,index)=>({id:'fixture-module-'+index,label:'测试模块'+index,purpose:'仅用于显式配置的领域回归。',minBeats:1,requiredKinds:[]}));
  const rates={minCharactersPerSecond:2,maxCharactersPerSecond:5};
  const previous=episodeNumber===1?null:{episode:{id:nativeContext.episodes[episodeNumber-2]!.id,version:nativeContext.episodes[episodeNumber-2]!.version,number:episodeNumber-1},snapshot:{id:head.continuity_snapshots[0]!.id,version:head.continuity_snapshots[0]!.version},adoptedRevision:head.revision.number,proofDigest:'a'.repeat(64),ledger:head.continuity_snapshots[0]!.ledger};
  const context:ScreenplayContext={version:1,schemaVersion:'0.8.0-draft',projectId:head.project.id,packageId:head.package_id,snapshotRevision:head.revision.number,
    episode:{...episode,title:nativeEpisode.title,targetSeconds:nativeEpisode.target_seconds},outline:{plan:{id:plan.id,version:plan.version},episodePlan:{id:episodePlan.id,version:episodePlan.version},sourceDigest:plan.source.source_digest,synopsis:episodePlan.synopsis,
      openingHook:{type:episodePlan.opening_hook.type,text:episodePlan.opening_hook.text,beat:episodePlan.opening_hook.beat},cliffhanger:{type:episodePlan.cliffhanger.type,text:episodePlan.cliffhanger.text,beat:episodePlan.cliffhanger.beat},
      beats:beats.map(row=>({ref:{id:row.id,version:row.version},order:row.order,characters:row.characters,goal:row.goal,conflict:row.conflict,turn:row.turn,consequence:row.consequence,referenceIds:row.origin.source_ref_ids}))},
    characters:head.characters.map(row=>({id:row.id,version:row.version,name:row.name,role:row.role})),locations:head.locations.map(row=>({id:row.id,version:row.version,name:row.name,description:row.description})),
    references:plan.source.references.map(row=>({...row,kind:'reviewed_bible',text:'供测试核对的原文：人物推门看见便签。',quotes:['人物推门看见便签。']})),previous,nativeContext,
    rules:{version:1,speech:{id:'fixture-speech',version:1,rates:{on_screen:{...rates},inner_monologue:{...rates},off_screen:{...rates},narration:{...rates}}},firstEpisode:{id:'fixture-five',version:1,modules}}};
  const speaker=context.characters[0]!.id,draft:ScreenplayDraft={version:1,episodeId:episode.id,title:nativeEpisode.title,
    scenes:[{id:'scene',title:'核对线索',locationId:null,characterIds:[speaker],startState:'人物带着疑问。',endState:'人物决定进一步核对。',beats:beats.flatMap((row,index)=>[
      {id:'action-'+index,kind:'action' as const,summary:'人物推门看见便签。',outlineBeatIds:[row.id],origin:{kind:'invented' as const,reason:'将已采用大纲转为可见动作。',citations:[]},plannedPause:{minMs:500,maxMs:1000},lines:[]},
      {id:'dialogue-'+index,kind:'dialogue' as const,summary:'人物核对线索。',outlineBeatIds:[row.id],origin:{kind:'invented' as const,reason:'原创对白落实大纲冲突。',citations:[]},plannedPause:{minMs:0,maxMs:500},lines:[{id:'line-'+index,speakerId:speaker,kind:'on_screen' as const,text:'我需要核对便签的来源。',delivery:'认真、克制。'}]},
    ])}],openingHook:{beatId:'action-0',type:context.outline.openingHook.type,reason:'未解决的线索推动本集。'},closingHook:{beatId:'dialogue-'+(beats.length-1),type:context.outline.cliffhanger.type,reason:'把本集后果交给后续。'},
    modules:episodeNumber===1?modules.map(module=>({moduleId:module.id,beatIds:['action-0']})):[],continuity:[]};
  return {head,context,draft,speaker,id};
}

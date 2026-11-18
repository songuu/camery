import {upgradeV05Package,upgradeV06Package} from '@camery/ir';
import type {StoryboardPackageV07} from '@camery/ir';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures.js';
import {createOutlineWorkflow,outlineTaskReference} from '../src/outline/node/index.js';
import {outlineTaskId} from '../src/outline/node/persistence-contracts.js';
import {outlineAdoptionSource} from '../src/outline/node/formal-source.js';
import type {OutlineFormalIdentities} from '../src/outline/node/formal-contracts.js';
import type {OutlineFormalProjection,OutlineProjectionBinding} from '../src/outline/node/formal-projection.js';
import type {OutlineOutput} from '../src/outline/contracts.js';
import {outlineContext} from '../src/outline/node/generation.js';
import {reviewOutlineCraft} from '../src/outline/outline.js';
import {reviewOutline} from '../src/outline/node/review.js';
import {outlineWorkflowFixture} from './outline-workflow-support.js';
import {workflowJournal} from './workflow-support.js';

function capacityOutput(output:OutlineOutput):void{
  const character=output.characters[0]!,beat=output.beats[0]!,episode=output.episodes[0]!,asset=output.assets[0]!,unit=output.plotUnits[0]!,decision=output.adaptation.decisions[0]!;
  output.characters=Array.from({length:64},(_,i)=>({...structuredClone(character),id:`character-${i}`,name:`Character ${i}`,desire:'goal',obstacle:'opposition',arc:'change',function:i===0?'protagonist':'supporting'}));
  output.beats=Array.from({length:500},(_,i)=>({...structuredClone(beat),id:`beat-${i}`,episodeNumber:Math.floor(i/5)+1,order:i%5+1,characterIds:[`character-${i%64}`],goal:'goal',conflict:'conflict',turn:'turn',consequence:'consequence'}));
  output.episodes=Array.from({length:100},(_,i)=>{const beats=output.beats.slice(i*5,i*5+5).map(row=>row.id);return {...structuredClone(episode),number:i+1,title:`Episode ${i+1}`,synopsis:'A choice changes the next conflict.',beatIds:beats,openingHook:{...episode.openingHook,beatId:beats[0]!},stakes:{...episode.stakes,beatId:beats[1]!},cliffhanger:{...episode.cliffhanger,type:(['choice','partial_reveal','identity_near'] as const)[i%3]!,beatId:beats[4]!},paidBreakpoint:i===99};});
  output.assets=Array.from({length:256},(_,i)=>({...structuredClone(asset),id:`asset-${i}`,name:`Prop ${i}`,description:'prop',narrativeRole:'changes choice',characterId:null,beatIds:[`beat-${i}`],propStates:[{beatId:`beat-${i}`,before:'intact',after:'broken',reason:'conflict'}]}));
  output.plotUnits=Array.from({length:100},(_,i)=>({...structuredClone(unit),id:`unit-${i}`,episodeNumbers:[i+1],beatIds:output.episodes[i]!.beatIds,pressure:'pressure',escalation:'escalation',reversal:'reversal',release:'release',nextCrisis:'crisis'}));
  output.adaptation.decisions=Array.from({length:128},(_,i)=>({...structuredClone(decision),id:`decision-${i}`,reason:'Keep an explicit causal choice.'}));
  output.recipe.signatureScenes[0]!.beatIds=['beat-499'];output.recipe.ablations[0]!.affectedBeatIds=['beat-6'];
  output.seasonEngine.characterIds=['character-0'];output.seasonEngine.plotUnitIds=output.plotUnits.map(row=>row.id);
  // Grow real typed prose fields, rather than an opaque padding object, close to the original 512KiB boundary.
  for(const row of output.assets){const remaining=500000-Buffer.byteLength(JSON.stringify(output));if(remaining<=0)break;row.description+='x'.repeat(Math.min(1000-row.description.length,remaining));}
  for(const row of output.beats){const remaining=500000-Buffer.byteLength(JSON.stringify(output));if(remaining<=0)break;row.goal+='x'.repeat(Math.min(500-row.goal.length,remaining));}
  if(Buffer.byteLength(JSON.stringify(output))>524288)throw new Error('Capacity fixture exceeded original outline limit');
}

/** Real workflow receipt and actual domain review on an explicit synthetic test host; no quality or live-model claim. */
export async function outlineFormalMappingFixture(options:{capacity?:boolean}={}){
  const original=await outlineWorkflowFixture();let {key,run,task}=original;
  if(options.capacity){
    capacityOutput(original.output);
    const saved=await original.store.putBrief({...original.put,expectedRevision:original.brief.revision,episodeCount:100,paidEpisodeNumbers:[100]});
    key={...key,runId:'capacity-outline-new-run'};
    run=await original.store.start({...original.command,...key,expectedRevision:saved.brief.revision,expectedBriefDigest:saved.brief.digest});
    task={tenantId:key.tenantId,taskId:outlineTaskId(key)};
  }
  await createOutlineWorkflow(original).run(outlineTaskReference(run),workflowJournal(task).context());
  const candidate=(await original.store.read(key)).candidate!;
  const reviewOutput=structuredClone(candidate.output);reviewOutput.adaptation.title='人工修订后采用的停钟之夜';
  const review=await original.store.review(key,decisionFor(run,candidate.digest,reviewOutput),original.host);
  const progress=await original.store.read(key),source=outlineAdoptionSource(key,progress);
  const head=upgradeV06Package(upgradeV05Package(makePackage()));
  for(const [field,value] of Object.entries(head))if(Array.isArray(value))(head as unknown as Record<string,unknown>)[field]=[];
  head.project.source_ids=[];head.project.rights_status='unknown';head.project.scope={label:'大纲映射',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};
  head.worlds.push({id:id('unrelated-world'),version:1,setting:'无关世界保留',era:'当代',rules:[]});
  const locals=(group:string,rows:readonly {id:string}[])=>rows.map(row=>({localId:row.id,id:id(`outline-mapping-${group}-${row.id}`)}));
  const identities:OutlineFormalIdentities={tenantId:run.tenantId,projectId:run.projectId,target:{tenantId:id('formal-tenant'),projectId:head.project.id},owner:{runId:run.runId,runDigest:run.digest},planId:id('outline-mapping-plan'),characters:locals('character',review.output.characters),beats:locals('beat',review.output.beats),episodes:review.output.episodes.map(row=>({number:row.number,episodeId:id(`outline-mapping-episode-${row.number}`),planId:id(`outline-mapping-episode-plan-${row.number}`)})),assets:locals('asset',review.output.assets),plotUnits:locals('unit',review.output.plotUnits),decisions:locals('decision',review.output.adaptation.decisions)};
  const reviewer={key:review.actorId,id:id('outline-mapping-editor')};
  return {...original,key,run,task,progress,source,review,identities,reviewer,head};
}

function decisionFor(run:Awaited<ReturnType<typeof outlineWorkflowFixture>>['run'],digest:string,output:OutlineOutput){
  const report=reviewOutlineCraft(outlineContext(run.brief,run.source),output,run.brief.thresholds);
  return {candidateDigest:digest,output,ablations:run.brief.auxiliaryGenres.map(genre=>({genre,judgment:'label_only' as const,reason:'人工确认辅助轴仅为标签。'})),waivers:report.issues.map(row=>({issueId:row.id,reason:'人工逐项决定保留创作选择。'}))};
}
export async function rereviewOutlineMapping(f:Awaited<ReturnType<typeof outlineFormalMappingFixture>>){
  const output=structuredClone(f.review.output);output.beats[0]!.goal='复审后主角主动公开证据';
  const review=reviewOutline(f.run.brief,f.run.source,f.progress.candidate,decisionFor(f.run,f.progress.candidate!.digest,output),{...f.host,at:'2026-11-18T09:00:00.000Z'});
  const progress={...f.progress,review};return {...f,progress,review,source:outlineAdoptionSource(f.key,progress)};
}
export function outlineMappingInput(f:Awaited<ReturnType<typeof outlineFormalMappingFixture>>){return {progress:f.progress,source:f.source,identities:f.identities,reviewer:f.reviewer,head:f.head};}
export function selectedOutlineProjection(head:StoryboardPackageV07,identities:OutlineFormalIdentities):{projection:OutlineFormalProjection;binding:OutlineProjectionBinding}{
  const plan=head.adaptation_plans.find(row=>row.id===identities.planId)!;
  const selected=<T extends {id:string}>(rows:readonly T[],ids:readonly string[])=>rows.filter(row=>ids.includes(row.id));
  const characters=selected(head.characters,identities.characters.map(row=>row.id)),episodes=selected(head.episodes,identities.episodes.map(row=>row.episodeId));
  const projection:OutlineFormalProjection={plan,characters,episodes,beats:selected(head.outline_beats,identities.beats.map(row=>row.id)),episodePlans:selected(head.outline_episode_plans,identities.episodes.map(row=>row.planId)),assets:selected(head.asset_plans,identities.assets.map(row=>row.id)),plotUnits:selected(head.outline_plot_units,identities.plotUnits.map(row=>row.id)),decisions:selected(head.outline_adaptation_decisions,identities.decisions.map(row=>row.id))};
  const mapping=(rows:readonly {id:string;version:number}[],locals:readonly {localId:string;id:string}[])=>new Map(locals.map(row=>[row.localId,{id:row.id,version:rows.find(value=>value.id===row.id)!.version}]));
  const binding:OutlineProjectionBinding={plan:{id:plan.id,version:plan.version},characters:mapping(characters,identities.characters),beats:mapping(projection.beats,identities.beats),assets:mapping(projection.assets,identities.assets),plotUnits:mapping(projection.plotUnits,identities.plotUnits),decisions:mapping(projection.decisions,identities.decisions),episodes:new Map(identities.episodes.map(row=>[row.number,{episodeId:row.episodeId,episodeVersion:episodes.find(value=>value.id===row.episodeId)!.version,plan:{id:row.planId,version:projection.episodePlans.find(value=>value.id===row.planId)!.version}}])),reviewer:{key:plan.source.reviewer_key,id:plan.source.reviewer_id}};
  return {projection,binding};
}

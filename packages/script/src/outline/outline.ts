import { capture,deepFreeze } from './boundary.js';
import { OutlineContextSchema,OutlineError,OutlineOutputSchema } from './contracts.js';
import type { OutlineContext,OutlineIssue,OutlineIssueCode,OutlineOutput,RuleThresholds } from './contracts.js';
import { captureRuleThresholds } from './profiles.js';
import { assertOutlineSelection } from './selection.js';

const fail=(path:string):never=>{throw new OutlineError('INVALID_REFERENCE','reference check',path);};
function unique<T>(values:readonly T[],path:string):Set<T>{
  const set=new Set(values);if(set.size!==values.length)fail(path);return set;
}
function refs<T>(values:readonly T[],allowed:ReadonlySet<T>,path:string):void{
  unique(values,path);for(const [index,value] of values.entries())if(!allowed.has(value))fail(`${path}.${index}`);
}
function same<T>(values:readonly T[],expected:readonly T[],path:string):void{
  if(values.length!==expected.length||values.some((value,index)=>value!==expected[index]))fail(path);
}
export function captureOutlineContext(input:unknown):OutlineContext{
  const context=capture(OutlineContextSchema,input,'context',262144);
  unique(context.sourceRefIds,'sourceRefIds');assertOutlineSelection(context);
  return deepFreeze(context);
}
function checkOrigins(context:OutlineContext,output:OutlineOutput):void{
  const sources=new Set(context.sourceRefIds);
  function sourceRefs(values:readonly string[],invented:boolean,path:string){
    refs(values,sources,path);
    // Invention is explicit; an empty citation list cannot silently claim adaptation.
    if(invented?values.length!==0:values.length===0)fail(path);
  }
  output.adaptation.decisions.forEach((decision,index)=>sourceRefs(decision.sourceRefIds,decision.action==='invent',`adaptation.decisions.${index}.sourceRefIds`));
  for(const collection of ['characters','beats','assets'] as const)output[collection].forEach((item,index)=>sourceRefs(item.origin.sourceRefIds,item.origin.kind==='invented',`${collection}.${index}.origin.sourceRefIds`));
}

/** Structural validity is neither human approval nor a measured creative-quality result. */
export function validateOutline(contextInput:unknown,input:unknown):OutlineOutput{
  const context=captureOutlineContext(contextInput);const output=capture(OutlineOutputSchema,input,'five-piece output');
  const {episodeCount,targetSeconds}=context;
  if(output.episodes.length!==episodeCount)throw new OutlineError('INCOMPLETE','episode coverage','episodes');
  same(output.episodes.map(episode=>episode.number),Array.from({length:episodeCount},(_,index)=>index+1),'episodes');
  if(output.recipe.mainGenre!==context.mainGenre)fail('recipe.mainGenre');
  same(output.recipe.auxiliaryGenres,context.auxiliaryGenres,'recipe.auxiliaryGenres');
  const auxiliary=new Set(context.auxiliaryGenres);
  refs(output.recipe.ablations.map(item=>item.genre),auxiliary,'recipe.ablations');
  if(output.recipe.ablations.length!==auxiliary.size)throw new OutlineError('INCOMPLETE','auxiliary ablations','recipe.ablations');
  for(const collection of ['characters','beats','assets','plotUnits'] as const)unique(output[collection].map(item=>item.id),collection);
  unique(output.adaptation.decisions.map(item=>item.id),'adaptation.decisions');unique(output.recipe.signatureScenes.map(item=>item.id),'recipe.signatureScenes');
  checkOrigins(context,output);
  const characters=new Set(output.characters.map(item=>item.id));const units=new Set(output.plotUnits.map(item=>item.id));
  const beats=new Set(output.beats.map(item=>item.id));const beatById=new Map(output.beats.map(beat=>[beat.id,beat]));
  const paid=new Set(context.paidEpisodeNumbers);
  output.beats.forEach((beat,index)=>{
    if(beat.episodeNumber>episodeCount)fail(`beats.${index}.episodeNumber`);
    refs(beat.characterIds,characters,`beats.${index}.characterIds`);
  });
  output.episodes.forEach((episode,index)=>{
    const path=`episodes.${index}`;
    const actual=output.beats.filter(beat=>beat.episodeNumber===episode.number);
    if(actual.length===0)throw new OutlineError('INCOMPLETE','episode beats',`${path}.beatIds`);
    same(actual.map(beat=>beat.order),Array.from({length:actual.length},(_,order)=>order+1),`${path}.beatOrder`);
    same(episode.beatIds,actual.map(beat=>beat.id),`${path}.beatIds`);
    const episodeBeats=new Set(episode.beatIds);
    for(const field of ['openingHook','stakes','cliffhanger'] as const)refs([episode[field].beatId],episodeBeats,`${path}.${field}.beatId`);
    if(episode.openingHook.estimatedSecond>targetSeconds)fail(`${path}.openingHook.estimatedSecond`);
    if(episode.stakes.estimatedSecond>targetSeconds)fail(`${path}.stakes.estimatedSecond`);
    if(episode.paidBreakpoint!==paid.has(episode.number))fail(`${path}.paidBreakpoint`);
  });
  output.recipe.signatureScenes.forEach((item,index)=>refs(item.beatIds,beats,`recipe.signatureScenes.${index}.beatIds`));
  output.recipe.ablations.forEach((item,index)=>refs(item.affectedBeatIds,beats,`recipe.ablations.${index}.affectedBeatIds`));
  output.assets.forEach((asset,index)=>{
    const path=`assets.${index}`;refs(asset.beatIds,beats,`${path}.beatIds`);
    if(asset.characterId!==null)refs([asset.characterId],characters,`${path}.characterId`);
    if((asset.kind==='character'||asset.kind==='appearance')&&asset.characterId===null)fail(`${path}.characterId`);
    if(asset.kind!=='prop'&&asset.propStates.length!==0)fail(`${path}.propStates`);
    if(asset.kind==='prop'&&asset.propStates.length===0)throw new OutlineError('INCOMPLETE','narrative prop states',`${path}.propStates`);
    const appearances=new Set(asset.beatIds);
    refs(asset.propStates.map(state=>state.beatId),appearances,`${path}.propStates`);
    const order=new Map(output.beats.map((beat,position)=>[beat.id,beat.episodeNumber*1000+position]));
    const stateOrder=asset.propStates.map(state=>order.get(state.beatId)!);
    if(stateOrder.some((position,stateIndex)=>stateIndex>0&&position<=stateOrder[stateIndex-1]!))fail(`${path}.propStates`);
  });
  const covered:number[]=[];
  output.plotUnits.forEach((unit,index)=>{
    const path=`plotUnits.${index}`;unique(unit.episodeNumbers,`${path}.episodeNumbers`);
    if(unit.episodeNumbers.some((number,position)=>number>episodeCount||(position>0&&number!==unit.episodeNumbers[position-1]!+1)))fail(`${path}.episodeNumbers`);
    refs(unit.beatIds,beats,`${path}.beatIds`);
    const allowed=new Set(unit.episodeNumbers);
    if(unit.beatIds.some(id=>!allowed.has(beatById.get(id)!.episodeNumber)))fail(`${path}.beatIds`);
    same(unit.beatIds,output.episodes.filter(episode=>allowed.has(episode.number)).flatMap(episode=>episode.beatIds),`${path}.beatIds`);
    covered.push(...unit.episodeNumbers);
  });
  same(covered,output.episodes.map(episode=>episode.number),'plotUnits');
  refs(output.seasonEngine.characterIds,characters,'seasonEngine.characterIds');refs(output.seasonEngine.plotUnitIds,units,'seasonEngine.plotUnitIds');
  const seasonCharacters=new Set(output.seasonEngine.characterIds);const participants=new Set(output.beats.flatMap(beat=>beat.characterIds));
  if(!output.characters.some(character=>character.function==='protagonist'&&seasonCharacters.has(character.id)&&participants.has(character.id)))throw new OutlineError('INCOMPLETE','participating season protagonist','seasonEngine.characterIds');
  return deepFreeze(output);
}

export interface OutlineCraftReport {
  readonly version:1;readonly kind:'craft_review';readonly ruleVersion:'outline-craft-v1';readonly thresholds:RuleThresholds;
  readonly emotionCurve:readonly {readonly episodeNumber:number;readonly intensity:number}[];readonly issues:readonly OutlineIssue[];
}
export function reviewOutlineCraft(context:unknown,input:unknown,thresholdInput?:unknown):OutlineCraftReport{
  const output=validateOutline(context,input);const thresholds=captureRuleThresholds(thresholdInput);const issues:OutlineIssue[]=[];
  function issue(code:OutlineIssueCode,path:string,episodeNumbers:number[],detail:string){
    issues.push({id:`${code}:${path}`,code,path,episodeNumbers,detail});
  }
  output.episodes.forEach((episode,index)=>{
    if(episode.openingHook.estimatedSecond>thresholds.openingHookBySecond)issue('LATE_OPENING_HOOK',`episodes.${index}.openingHook`,[episode.number],'计划钩子出现时间晚于有效阈值，需人审；不是实测成片时间。');
    if(episode.stakes.estimatedSecond>thresholds.stakesBySecond)issue('LATE_STAKES',`episodes.${index}.stakes`,[episode.number],'计划利害交代时间晚于有效阈值，需人审；不是实测成片时间。');
  });
  for(let start=0;start<output.episodes.length;start++){
    const cliff=output.episodes.slice(start,start+thresholds.repeatedCliffhangerWindow);
    if(cliff.length===thresholds.repeatedCliffhangerWindow&&cliff.every(episode=>episode.cliffhanger.type===cliff[0]!.cliffhanger.type))issue('REPEATED_CLIFFHANGER',`episodes.${start}.cliffhanger`,cliff.map(episode=>episode.number),'连续卡点类型重复，需人审或逐项豁免。');
    const emotion=output.episodes.slice(start,start+thresholds.lowEmotionWindow);
    if(emotion.length===thresholds.lowEmotionWindow&&emotion.every(episode=>episode.emotionIntensity<thresholds.lowEmotionBelow))issue('LOW_EMOTION',`episodes.${start}.emotionIntensity`,emotion.map(episode=>episode.number),'连续情绪强度标注低于有效阈值，需人审；不是观众反应测量。');
  }
  output.recipe.ablations.forEach((ablation,index)=>issue('ABLATION_REVIEW',`recipe.ablations.${index}`,output.beats.filter(beat=>ablation.affectedBeatIds.includes(beat.id)).map(beat=>beat.episodeNumber).filter((number,position,all)=>all.indexOf(number)===position),`辅轴 ${ablation.genre} 的抽离影响为提案，须由人工判断是否参与主线。`));
  return deepFreeze({version:1,kind:'craft_review',ruleVersion:'outline-craft-v1',thresholds,
    emotionCurve:output.episodes.map(episode=>({episodeNumber:episode.number,intensity:episode.emotionIntensity})),issues});
}

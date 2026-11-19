import {captureScreenplay,freezeScreenplay} from './boundary.js';
import {SCREENPLAY_OUTPUT_BYTES,ScreenplayReportSchema} from './contracts.js';
import type {ScreenplayBeatKindSchema,ScreenplayIssue,ScreenplayIssueCode,ScreenplayReport} from './contracts.js';
import type {z} from 'zod';
import {inspectScreenplayDraft,makeScreenplayIssue,projectScreenplayContinuity} from './context.js';

const kindLabel:Record<z.infer<typeof ScreenplayBeatKindSchema>,string>={action:'动作',dialogue:'对白',narration:'旁白'};

/** Deterministic structure and declared continuity only; subjective audience effects always remain review findings. */
export function checkScreenplay(contextInput:unknown,draftInput:unknown):ScreenplayReport{
  const {context,draft,issues:inspection}=inspectScreenplayDraft(contextInput,draftInput),continuity=projectScreenplayContinuity(context,draft),found=new Map<string,ScreenplayIssue>();
  for(const issue of [...inspection,...continuity.issues])if(!found.has(issue.id))found.set(issue.id,issue);
  const add=(code:ScreenplayIssueCode,severity:ScreenplayIssue['severity'],path:string,detail:string,remedy:string,variant?:string)=>{
    const issue=makeScreenplayIssue({code,severity,path,detail,audienceImpact:'结构、来源或因果缺口会影响观众理解本集冲突及后续期待。',remedy,collateralImpact:['调整节拍后需重新核对钩子、模块覆盖、四账声明和时长。']});
    // Different module constraints can fail at the same actual draft location; their identities must remain distinct.
    if(variant)issue.id+=':'+variant;if(!found.has(issue.id))found.set(issue.id,issue);
  };
  const beats=draft.scenes.flatMap(scene=>scene.beats),byId=new Map(beats.map((beat,index)=>[beat.id,{beat,index}]));
  if(draft.openingHook===null)add('MISSING_OPENING_HOOK','error','/openingHook','本稿尚未声明开场钩子。','指定本稿前三个实际节拍之一，并说明它推动观看的理由。');
  else{
    const opening=byId.get(draft.openingHook.beatId);
    if(!opening)add('MISSING_OPENING_HOOK','error','/openingHook/beatId','开场钩子没有定位到本稿实际节拍。','选择本稿前三个实际节拍之一，不能使用场次、台词或大纲标识代替。');
    else if(opening.index>=3)add('LATE_OPENING_HOOK','error','/openingHook/beatId','开场钩子位于本稿第四个或更后的节拍。','将明确的开场钩子安排在前三个节拍，并核对调整后的因果顺序。');
    if(draft.openingHook.type!==context.outline.openingHook.type)add('HOOK_TYPE_CHANGED','warning','/openingHook/type','开场钩子类型与已采用的大纲不同。','人工确认类型变化是否保留大纲的冲突与观看承诺。');
  }
  add('HOOK_REVIEW','warning','/openingHook','开场钩子吸引力需要人工核对。'+(draft.openingHook?.reason??'当前尚未提供开场钩子说明。'),'结合实际节拍与本稿说明，确认观众能立即理解悬念、冲突或危险。');
  if(draft.closingHook===null)add('CLOSING_HOOK','error','/closingHook','本稿尚未声明集末钩子。','指定本稿最后一个实际节拍，并说明它留下的期待。');
  else{
    if(!byId.has(draft.closingHook.beatId))add('CLOSING_HOOK','error','/closingHook/beatId','集末钩子没有定位到本稿实际节拍。','选择本稿最后一个实际节拍。');
    else if(beats.at(-1)!.id!==draft.closingHook.beatId)add('CLOSING_HOOK','error','/closingHook/beatId','集末钩子之后仍有其他实际节拍。','将集末钩子落实到本稿最后一拍，并复核后果是否清楚。');
    if(draft.closingHook.type!==context.outline.cliffhanger.type)add('HOOK_TYPE_CHANGED','warning','/closingHook/type','集末钩子类型与已采用的大纲不同。','人工确认变化是否保留本集后果及继续观看的期待。');
  }
  add('HOOK_REVIEW','warning','/closingHook','集末钩子与下一集期待需要人工核对。'+(draft.closingHook?.reason??'当前尚未提供集末钩子说明。'),'结合最后一拍核对悬念、后果及观众继续观看的理由。');

  const first=context.episode.number===1,profile=context.rules.firstEpisode,definitions=new Map(profile?.modules.map(module=>[module.id,module])??[]),annotations=new Map<string,number>();
  if(first&&profile===null)add('FIRST_EPISODE_CONFIG','error','/rules/firstEpisode','尚未配置本项目首集的五模块规则。','先明确五个模块的标识、目的、最少节拍和所需节拍类别。');
  for(const [index,module] of draft.modules.entries()){
    const path=`/modules/${index}`,definition=definitions.get(module.moduleId);
    if(annotations.has(module.moduleId))add('FIRST_EPISODE_MODULE','error',path+'/moduleId','同一配置模块被重复标注。','每个模块仅保留一个注释，并合并其中真实且唯一的节拍引用。');else annotations.set(module.moduleId,index);
    if(!definition)add('FIRST_EPISODE_MODULE','error',path+'/moduleId','模块标识不属于当前明确配置。','使用本项目配置中的准确模块标识。');
    const seen=new Set<string>(),actual=new Set<string>();
    for(const [bi,beatId] of module.beatIds.entries()){
      if(seen.has(beatId))add('FIRST_EPISODE_MODULE','error',path+`/beatIds/${bi}`,'同一模块重复引用了一个节拍。','保留每个实际节拍一次。');seen.add(beatId);
      if(!byId.has(beatId))add('FIRST_EPISODE_MODULE','error',path+`/beatIds/${bi}`,'模块引用没有定位到本稿实际节拍。','选择本稿实际节拍，不能用台词、大纲或不存在的标识代替。');else actual.add(beatId);
    }
    if(!definition)continue;
    if(actual.size<definition.minBeats)add('FIRST_EPISODE_MODULE','error',path+'/beatIds',`模块“${definition.label}”至少需要 ${definition.minBeats} 个真实且不同的节拍。`,'补齐实际节拍，再人工核对它们共同完成的模块目的。','minBeats');
    for(const kind of definition.requiredKinds)if(![...actual].some(id=>byId.get(id)!.beat.kind===kind))add('FIRST_EPISODE_MODULE','error',path+'/beatIds',`模块“${definition.label}”缺少配置要求的${kindLabel[kind]}节拍。`,'补齐该类实际节拍，或先人工修订项目配置。','requiredKind:'+kind);
  }
  for(const [index,module] of (profile?.modules??[]).entries()){
    const annotation=annotations.get(module.id),path=annotation===undefined?`/rules/firstEpisode/modules/${index}`:`/modules/${annotation}`;
    if(first&&annotation===undefined)add('FIRST_EPISODE_MODULE','error',path,'首集尚未标注配置模块“'+module.label+'”。','为该模块选择本稿实际节拍；不同模块可以共享节拍。');
    if(first||annotation!==undefined)add('MODULE_REVIEW','warning',path,'模块“'+module.label+'”的主观目的需人工核对：'+module.purpose,'结合被引用的实际节拍，确认配置目的对观众成立。');
  }
  const covered=new Set(beats.flatMap(beat=>beat.outlineBeatIds));
  for(const [index,beat] of context.outline.beats.entries())if(!covered.has(beat.ref.id))add('OUTLINE_COVERAGE','warning',`/outline/beats/${index}`,'本集第 '+(index+1)+' 个正式大纲节拍尚未映射到本稿实际节拍。','补充对应的本稿节拍，或先人工确认改编取舍。');
  add('CONTINUITY_REVIEW','warning','/continuity','四账预览仅演算显式声明；声明是否完整及其文字含义仍需场记核对。','人工核对事实、角色知情、人物状态和伏笔变化，并补齐准确声明及实际事件证据。');
  return freezeScreenplay(captureScreenplay(ScreenplayReportSchema,{version:1,kind:'screenplay_check',ruleVersion:'screenplay-v1',episodeId:draft.episodeId,issues:[...found.values()]},'screenplay report',SCREENPLAY_OUTPUT_BYTES));
}

import {captureScreenplay,freezeScreenplay} from './boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,SCREENPLAY_DRAFT_BYTES,SCREENPLAY_OUTPUT_BYTES,ScreenplayContextSchema,ScreenplayDraftSchema,ScreenplayContinuityPreviewSchema,ScreenplayError} from './contracts.js';
import type {ScreenplayContext,ScreenplayDraft,ScreenplayIssue,ScreenplayIssueCode,ScreenplayContinuityPreview} from './contracts.js';
import {validateContinuityContext} from '../continuity/context.js';
import {reduceEpisodeContinuity} from '../continuity/reduce.js';
import {ContinuityError} from '../continuity/contracts.js';
import type {ContinuityContext,ContinuityDraft,ContinuityEvent,EventRef} from '../continuity/contracts.js';

function invalid(path:string):never{throw new ScreenplayError('INVALID_REFERENCE','writing context',path);}
function unique(values:readonly string[],path:string):void{if(new Set(values).size!==values.length)invalid(path);}
export function makeScreenplayIssue(input:{code:ScreenplayIssueCode;severity:'error'|'warning';path:string;detail:string;audienceImpact:string;remedy:string;collateralImpact?:string[]}):ScreenplayIssue{
  return {id:input.code+':'+input.path,...input,collateralImpact:input.collateralImpact??[]};
}
/** Pure relationship validation; callers obtain adoption authority from the actual Node source reader. */
export function validateScreenplayContext(input:unknown):ScreenplayContext{
  const context=captureScreenplay(ScreenplayContextSchema,input,'writing context',SCREENPLAY_CONTEXT_BYTES);let native:ContinuityContext;
  try{native=validateContinuityContext(context.nativeContext);}catch{invalid('nativeContext');}
  if(native.projectId!==context.projectId||native.packageId!==context.packageId||native.snapshotRevision!==context.snapshotRevision)invalid('nativeContext.binding');
  const episode=native.episodes.find(row=>row.id===context.episode.id);if(!episode||episode.number!==context.episode.number||episode.version!==context.episode.version)invalid('episode');
  for(const [name,rows] of Object.entries({characters:context.characters,locations:context.locations,references:context.references}))unique(rows.map(row=>row.id),name);
  const characters=new Map(context.characters.map(row=>[row.id,row])),nativeCharacters=new Map(native.characters.map(row=>[row.id,row.version]));
  for(const row of context.characters)if(nativeCharacters.get(row.id)!==row.version)invalid('characters');
  unique(context.outline.beats.map(row=>row.ref.id),'outline.beats');unique(context.outline.beats.map(row=>String(row.order)),'outline.beats.order');
  const references=new Set(context.references.map(row=>row.id));let order=0;
  for(const [index,beat] of context.outline.beats.entries()){
    if(beat.order<=order)invalid(`outline.beats.${index}.order`);order=beat.order;unique(beat.characters.map(row=>row.id),`outline.beats.${index}.characters`);unique(beat.referenceIds,`outline.beats.${index}.referenceIds`);
    for(const ref of beat.characters)if(characters.get(ref.id)?.version!==ref.version)invalid(`outline.beats.${index}.characters`);
    if(beat.referenceIds.some(id=>!references.has(id)))invalid(`outline.beats.${index}.referenceIds`);
  }
  for(const ref of [context.outline.openingHook.beat,context.outline.cliffhanger.beat])if(!context.outline.beats.some(row=>row.ref.id===ref.id&&row.ref.version===ref.version))invalid('outline.hooks');
  if(context.episode.number===1){if(context.previous!==null)invalid('previous');}
  else{
    const previous=context.previous,expected=native.episodes[context.episode.number-2];
    if(!previous||!expected||previous.episode.id!==expected.id||previous.episode.number!==expected.number||previous.episode.version!==expected.version||previous.ledger.episodeId!==expected.id||previous.ledger.projectId!==context.projectId||previous.ledger.packageId!==context.packageId||previous.adoptedRevision>context.snapshotRevision||previous.ledger.snapshotRevision>previous.adoptedRevision)invalid('previous');
    try{reduceEpisodeContinuity(native,{version:1,episodeId:context.episode.id,events:[]},previous.ledger);}catch{invalid('previous.ledger');}
  }
  const profile=context.rules.firstEpisode;if(profile){unique(profile.modules.map(row=>row.id),'rules.firstEpisode.modules');for(const module of profile.modules)unique(module.requiredKinds,'rules.firstEpisode.requiredKinds');}
  for(const [kind,rate] of Object.entries(context.rules.speech.rates))if(rate.minCharactersPerSecond>rate.maxCharactersPerSecond)invalid('rules.speech.rates.'+kind);
  return freezeScreenplay({...context,nativeContext:native});
}
function nativeIds(context:ScreenplayContext):Set<string>{
  const native=context.nativeContext,result=new Set([context.projectId,context.packageId,context.outline.plan.id,context.outline.episodePlan.id,...context.outline.beats.map(row=>row.ref.id),...context.locations.map(row=>row.id)]);
  for(const rows of [native.episodes,native.characters,native.props,native.appearances,native.spots])for(const row of rows)result.add(row.id);
  for(const row of native.spots)result.add(row.location.id);for(const row of native.events)result.add(row.ref.id);if(context.previous)result.add(context.previous.snapshot.id);return result;
}
export function inspectScreenplayDraft(contextInput:unknown,draftInput:unknown):{context:ScreenplayContext;draft:ScreenplayDraft;issues:readonly ScreenplayIssue[]}{
  const context=validateScreenplayContext(contextInput),draft=captureScreenplay(ScreenplayDraftSchema,draftInput,'screenplay draft',SCREENPLAY_DRAFT_BYTES);
  if(draft.episodeId!==context.episode.id)throw new ScreenplayError('CONFLICT','draft episode','episodeId');
  const issues:ScreenplayIssue[]=[],ids=new Set<string>(),reserved=nativeIds(context),characters=new Set(context.characters.map(row=>row.id)),locations=new Set(context.locations.map(row=>row.id)),outline=new Set(context.outline.beats.map(row=>row.ref.id)),references=new Map(context.references.map(row=>[row.id,row]));
  const events=new Map<string,{kind:'beat'|'line';text:string}>();let beatCount=0,lineCount=0;
  const issue=(code:ScreenplayIssueCode,path:string,detail:string,remedy:string)=>issues.push(makeScreenplayIssue({code,severity:'error',path,detail,audienceImpact:'错误的来源、角色或定位会使剧本及下游声音、四账不一致。',remedy}));
  const local=(id:string,path:string)=>{if(ids.has(id)||reserved.has(id))issue('DUPLICATE_ID',path,'场次、节拍与台词必须使用本稿独立且唯一的局部标识。','修正局部标识，并同步更新本稿引用。');ids.add(id);};
  for(const [si,scene] of draft.scenes.entries()){
    const sp=`/scenes/${si}`;local(scene.id,sp+'/id');const participants=new Set(scene.characterIds);
    if(participants.size!==scene.characterIds.length)issue('DUPLICATE_ID',sp+'/characterIds','本场角色重复。','保留每个角色一次。');
    for(const [i,id] of scene.characterIds.entries())if(!characters.has(id))issue('UNKNOWN_CHARACTER',sp+'/characterIds/'+i,'本场角色不在正式写作资料中。','选择实际角色，或先确认新增角色。');
    if(scene.locationId!==null&&!locations.has(scene.locationId))issue('UNKNOWN_LOCATION',sp+'/locationId','本场引用的实际地点不存在。','选择实际地点；尚未准备时保留空地点。');
    for(const [bi,beat] of scene.beats.entries()){
      const bp=sp+`/beats/${bi}`;beatCount++;local(beat.id,bp+'/id');events.set(beat.id,{kind:'beat',text:beat.summary});
      if(new Set(beat.outlineBeatIds).size!==beat.outlineBeatIds.length)issue('DUPLICATE_ID',bp+'/outlineBeatIds','同一规划节拍被重复引用。','保留唯一规划引用。');
      for(const [i,id] of beat.outlineBeatIds.entries())if(!outline.has(id))issue('UNKNOWN_OUTLINE_BEAT',bp+'/outlineBeatIds/'+i,'引用不属于本集正式大纲。','绑定本集规划节拍，不能以规划 ID 充当剧本事件。');
      if(beat.origin.kind==='invented'?!beat.origin.reason:beat.origin.citations.length===0||beat.outlineBeatIds.length===0)issue('ORIGIN_REQUIRED',bp+'/origin','新增内容需说明改编来源或原创理由。','补齐真实来源；原创补充明确创作理由。');
      for(const [ci,citation] of beat.origin.citations.entries()){
        const cp=bp+`/origin/citations/${ci}`,reference=references.get(citation.referenceId);
        if(!reference)issue('UNKNOWN_SOURCE',cp+'/referenceId','引用不在已确认的原文/开发资料目录中。','选择实际资料目录条目。');
        if(citation.relationship==='quoted'&&citation.quote===null||citation.quote!==null&&(!reference||!reference.quotes.some(text=>text.includes(citation.quote!))))issue('SOURCE_QUOTE',cp+'/quote','标注的引文未出现在该条实际原文证据中。','修正引文，或以改编/原创说明代替伪造引用。');
      }
      if(beat.plannedPause.minMs>beat.plannedPause.maxMs)issue('PLANNED_RANGE',bp+'/plannedPause','动作或停顿的计划区间上下限倒置。','设置有序的非负毫秒范围。');
      if(beat.kind==='action'?beat.lines.length>0:beat.lines.length===0)issue('VOICE_SEMANTICS',bp+'/kind','动作节拍与对白/旁白节拍的台词结构不一致。','拆分动作和发声节拍，保留实际顺序。');
      for(const [li,line] of beat.lines.entries()){
        const lp=bp+`/lines/${li}`;lineCount++;local(line.id,lp+'/id');events.set(line.id,{kind:'line',text:line.text});
        if(!characters.has(line.speakerId))issue('UNKNOWN_CHARACTER',lp+'/speakerId','说话者不在已采用角色中。','选择实际角色，不能虚构旁白身份。');
        if(!participants.has(line.speakerId))issue('SCENE_SPEAKER',lp+'/speakerId','说话者没有列入本场参与角色。','核对本场参与者，画外音/旁白也需实际说话者。');
        if(beat.kind==='narration'?line.kind!=='narration':beat.kind==='dialogue'&&line.kind==='narration')issue('VOICE_SEMANTICS',lp+'/kind','旁白与对白节拍的声音类别不一致。','按当面说、内心独白、画外音或旁白明确分类。');
      }
    }
  }
  if(beatCount>2048||lineCount>8192)throw new ScreenplayError('INPUT_LIMIT','screenplay aggregate','scenes');
  const declarations=new Set<string>();for(const [index,event] of draft.continuity.entries()){
    const path=`/continuity/${index}`;if(declarations.has(event.id))issue('DUPLICATE_ID',path+'/id','四账声明标识重复。','为每项声明保留唯一标识。');declarations.add(event.id);
    const actual=events.get(event.evidence.event.id);if(!actual||actual.kind!==event.evidence.event.kind||!actual.text.includes(event.evidence.quote))issue('CONTINUITY_REFERENCE',path+'/evidence','四账声明未绑定本稿实际节拍/台词及原文片段。','定位本稿实际事件，修正声明证据。');
    if('characterId'in event&&!characters.has(event.characterId)||event.op==='set_character'&&!characters.has(event.value.characterId))issue('UNKNOWN_CHARACTER',path,'四账声明引用了写作资料以外的角色。','仅使用实际角色。');
  }
  return freezeScreenplay({context,draft,issues});
}
/** Preview only: current-episode local refs become deterministic disposable IDs for the existing causal reducer. */
export function projectScreenplayContinuity(contextInput:unknown,draftInput:unknown):ScreenplayContinuityPreview{
  const {context,draft,issues}=inspectScreenplayDraft(contextInput,draftInput),references:ScreenplayContinuityPreview['references']=[];
  if(issues.length)return freezeScreenplay({version:1,kind:'candidate_projection',episodeId:draft.episodeId,references,ledger:null,issues:[...issues]});
  const occupied=nativeIds(context),mapping=new Map<string,EventRef>(),current:ContinuityContext['events']=[];let serial=0,sequence=0;
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const allocate=()=>{for(;;){let value=++serial,id='';while(value){id=alphabet[value%32]!+id;value=Math.floor(value/32);}id=id.padStart(26,'0');if(!occupied.has(id)){occupied.add(id);return id;}}};
  for(const scene of draft.scenes)for(const beat of scene.beats){
    const ref:EventRef={kind:'beat',id:allocate(),version:1};mapping.set(beat.id,ref);references.push({localId:beat.id,kind:'beat',ref});current.push({ref,episodeId:draft.episodeId,sequence:++sequence,characterIds:scene.characterIds,speakerId:null,lineKind:null,text:beat.summary});
    for(const line of beat.lines){const ref:EventRef={kind:'line',id:allocate(),version:1};mapping.set(line.id,ref);references.push({localId:line.id,kind:'line',ref});current.push({ref,episodeId:draft.episodeId,sequence:++sequence,characterIds:scene.characterIds,speakerId:line.speakerId,lineKind:line.kind,text:line.text});}
  }
  const native=context.nativeContext,groups=new Map<string,ContinuityContext['events']>();for(const event of native.events){const group=groups.get(event.episodeId);if(group)group.push(event);else groups.set(event.episodeId,[event]);}
  const ordered=native.episodes.flatMap(episode=>episode.id===draft.episodeId?current:groups.get(episode.id)??[]);
  const events=draft.continuity.map(event=>({...event,evidence:{event:mapping.get(event.evidence.event.id)!,quote:event.evidence.quote}})) as ContinuityEvent[];
  try{
    const reduction=reduceEpisodeContinuity({...native,events:ordered},{version:1,episodeId:draft.episodeId,events} satisfies ContinuityDraft,context.previous?.ledger??null);
    const findings=reduction.issues.map(row=>{const issue=makeScreenplayIssue({code:'CONTINUITY_RULE',severity:row.severity,path:'/continuity/'+row.path,detail:row.message,audienceImpact:'无来源知情、错误事实或伏笔时序会破坏跨集连贯。',remedy:'核对本稿声明及真实前账，再由场记审阅。',collateralImpact:[row.code]});return {...issue,id:issue.id+':'+row.code};});
    return freezeScreenplay(captureScreenplay(ScreenplayContinuityPreviewSchema,{version:1,kind:'candidate_projection',episodeId:draft.episodeId,references,ledger:reduction.ledger,issues:findings},'continuity candidate projection',SCREENPLAY_OUTPUT_BYTES));
  }catch(error){
    let path='/continuity',limited=false;try{if(error instanceof ContinuityError||error instanceof ScreenplayError){limited=error.code==='INPUT_LIMIT';path='/continuity/'+error.path;}}catch{/* Dependency diagnostics are not rendered. */}
    if(limited)throw new ScreenplayError('INPUT_LIMIT','continuity candidate projection',path);
    return freezeScreenplay({version:1,kind:'candidate_projection',episodeId:draft.episodeId,references,ledger:null,issues:[makeScreenplayIssue({code:'CONTINUITY_REFERENCE',severity:'error',path,detail:'四账声明与当前实际角色、事件或物理引用不一致。',audienceImpact:'无法把未核实的状态作为下一集约束。',remedy:'修正声明引用并重新核对。'})]});
  }
}

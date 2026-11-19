import {captureScreenplay,freezeScreenplay} from './boundary.js';
import {SCREENPLAY_OUTPUT_BYTES,ScreenplayTimingSchema,ScreenplayIssueSchema,ScreenplayError} from './contracts.js';
import type {ScreenplayContext,ScreenplayDraft,ScreenplayIssue,ScreenplayTiming} from './contracts.js';
import {inspectScreenplayDraft,makeScreenplayIssue} from './context.js';

const Issues=ScreenplayIssueSchema.array().max(65536);
const spokenUnit=/[\p{L}\p{N}]/u;
function inputs(contextInput:unknown,draftInput:unknown){
  const inspected=inspectScreenplayDraft(contextInput,draftInput),error=inspected.issues.find(row=>row.severity==='error');
  if(error)throw new ScreenplayError('INVALID_REFERENCE','screenplay timing',error.path);return inspected;
}
function safe(value:number,path:string):number{if(!Number.isSafeInteger(value)||value<0)throw new ScreenplayError('INPUT_LIMIT','timing arithmetic',path);return value;}
function add(left:number,right:number,path:string):number{return safe(left+right,path);}
function calculate(context:ScreenplayContext,draft:ScreenplayDraft):ScreenplayTiming{
  const total={minMs:0,maxMs:0},scenes:ScreenplayTiming['scenes']=[];
  for(const [si,scene] of draft.scenes.entries()){
    const st={minMs:0,maxMs:0},beats:ScreenplayTiming['scenes'][number]['beats']=[];
    for(const [bi,beat] of scene.beats.entries()){
      const path=`/scenes/${si}/beats/${bi}`,plannedPause={...beat.plannedPause},bt={...plannedPause},lines:ScreenplayTiming['scenes'][number]['beats'][number]['lines']=[];
      for(const [li,line] of beat.lines.entries()){
        let units=0;for(const codepoint of line.text)if(spokenUnit.test(codepoint))units=add(units,1,path+`/lines/${li}/units`);
        const rate=context.rules.speech.rates[line.kind],duration={minMs:safe(Math.floor(units/rate.maxCharactersPerSecond*1000),path+`/lines/${li}/duration/minMs`),maxMs:safe(Math.ceil(units/rate.minCharactersPerSecond*1000),path+`/lines/${li}/duration/maxMs`)};
        bt.minMs=add(bt.minMs,duration.minMs,path+'/total/minMs');bt.maxMs=add(bt.maxMs,duration.maxMs,path+'/total/maxMs');
        lines.push({lineId:line.id,kind:line.kind,units,duration});
      }
      beats.push({beatId:beat.id,plannedPause,total:bt,lines});st.minMs=add(st.minMs,bt.minMs,`/scenes/${si}/total/minMs`);st.maxMs=add(st.maxMs,bt.maxMs,`/scenes/${si}/total/maxMs`);
    }
    scenes.push({sceneId:scene.id,total:st,beats});total.minMs=add(total.minMs,st.minMs,'/total/minMs');total.maxMs=add(total.maxMs,st.maxMs,'/total/maxMs');
  }
  return freezeScreenplay(captureScreenplay(ScreenplayTimingSchema,{version:1,kind:'estimated',basis:'configured_unicode_letter_or_number_rate',profile:{id:context.rules.speech.id,version:context.rules.speech.version},episodeId:draft.episodeId,total,scenes},'screenplay timing',SCREENPLAY_OUTPUT_BYTES));
}

/** Configured text-rate estimate plus explicitly planned pauses; this never represents a measured performance. */
export function estimateScreenplayTiming(contextInput:unknown,draftInput:unknown):ScreenplayTiming{const {context,draft}=inputs(contextInput,draftInput);return calculate(context,draft);}

/** Re-estimate from the complete draft so an attached or previously computed timing object cannot waive a warning. */
export function screenplayTimingIssues(contextInput:unknown,draftInput:unknown):ScreenplayIssue[]{
  const {context,draft}=inputs(contextInput,draftInput),timing=calculate(context,draft),issues:ScreenplayIssue[]=[];
  for(const [si,scene] of draft.scenes.entries())for(const [bi,beat] of scene.beats.entries()){
    const path=`/scenes/${si}/beats/${bi}`;
    if(beat.kind==='action'&&beat.plannedPause.minMs===0&&beat.plannedPause.maxMs===0)issues.push(makeScreenplayIssue({code:'ACTION_TIMING',severity:'warning',path:path+'/plannedPause',detail:'本动作节拍尚未安排动作或停顿时长。',audienceImpact:'可见动作需要表演和理解时间，零时长估计可能挤压叙事节奏。',remedy:'人工核对动作表现，并填写合理的计划时长区间。'}));
    if(beat.kind!=='action'&&!timing.scenes[si]!.beats[bi]!.lines.some(line=>line.units>0))issues.push(makeScreenplayIssue({code:'NO_SPOKEN_UNITS',severity:'warning',path:path+'/lines',detail:'本发声节拍没有可按配置语速计量的文字。',audienceImpact:'标点、表情或呼吸不能据此自动视为实际录音时长。',remedy:'人工核对发声内容与表演停顿，明确需要朗读的文字。'}));
  }
  // Compare in seconds: a legitimate fractional-second target need not become an integer millisecond value.
  if(context.episode.targetSeconds<timing.total.minMs/1000||context.episode.targetSeconds>timing.total.maxMs/1000)issues.push(makeScreenplayIssue({code:'TIMING_BUDGET',severity:'warning',path:'/episode/targetSeconds',detail:'分集目标时长落在当前配置语速与计划停顿的估计区间之外。',audienceImpact:'目标与剧本体量不一致可能影响观众理解、表演和剪辑节奏；估时不等于实际录音时长。',remedy:'人工核对对白体量、语速和停顿；调整目标时长时同步复核分集方案。'}));
  return freezeScreenplay(captureScreenplay(Issues,issues,'screenplay timing issues',SCREENPLAY_OUTPUT_BYTES));
}

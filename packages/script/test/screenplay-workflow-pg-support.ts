import {ModelSession} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import type {HttpTransport} from '@camery/model-modes';
import type {ScreenplayContext} from '../src/screenplay/contracts.js';
import type {ScreenplayModelOutput} from '../src/screenplay/node/model-contracts.js';
import type {ScreenplayWorkflowOptions} from '../src/screenplay/node/workflow.js';
import {screenplayFixture} from './screenplay-support.js';
/** Actual stored context in, explicit synthetic provider DTO out; this makes no live quality or billing claim. */
export function screenplayProtocolOutput(context:ScreenplayContext):ScreenplayModelOutput{
  const draft=structuredClone(screenplayFixture().draft),speaker=context.characters[0]!.id;draft.episodeId=context.episode.id;draft.scenes[0]!.characterIds=[speaker];
  for(const beat of draft.scenes[0]!.beats){beat.outlineBeatIds=context.outline.beats.map(row=>row.ref.id);for(const line of beat.lines)line.speakerId=speaker;}
  return {...draft,openingHook:{...draft.openingHook!,type:context.outline.openingHook.type},closingHook:{...draft.closingHook!,type:context.outline.cliffhanger.type},modules:context.episode.number===1?context.rules.firstEpisode!.modules.map(row=>({moduleId:row.id,beatIds:['action-0']})):[],continuity:{assertFacts:[],retireFacts:[],learnFacts:[],useFacts:[],setCharacters:[],plantThreads:[],payoffThreads:[]}};
}
export function screenplayProtocolSession(output:ScreenplayModelOutput,onCall:()=>void=()=>{}):ScreenplayWorkflowOptions['sessionFor']{
  const captured=structuredClone(output);return async binding=>{
    const transport:HttpTransport={async exchange(){onCall();return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'fixture-screenplay-generation',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(captured)}}],usage:{prompt_tokens:100,completion_tokens:80}}}};}};
    return new ModelSession(new OpenAiCompatibleLlm(transport,{model:'fixture-screenplay',structuredOutput:'json_schema'}),{tenantId:binding.tenantId,connectionId:binding.execution.connectionId,modeDigest:binding.execution.modeDigest,modelIdentity:binding.execution.modelIdentity,evidence:binding.execution.evidence,maxCalls:1,timeoutMs:2000,maxInputBytes:2097152,maxOutputBytes:524288});
  };
}

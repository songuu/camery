import {ModelSession} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import type {HttpTransport} from '@camery/model-modes';
import type {QualityReviewPlan} from '../src/quality/node/plan.js';
import type {QualityRun,QualityBatchAddress} from '../src/quality/node/state.js';
import {qualityBatchTaskId} from '../src/quality/node/state.js';
import type {QualityModelOutput} from '../src/quality/model-contracts.js';
/** Actual source and method protocol with a synthetic transport only; no live quality or provider-capacity claim. */
export function qualityProtocolSession(run:QualityRun,plan:QualityReviewPlan,cycle:1|2,onCall:()=>void=()=>{},change?:(output:QualityModelOutput,address:QualityBatchAddress)=>void){
  return async(binding:Readonly<{tenantId:string;projectId:string;execution:QualityRun['reviewers']['story']['execution']}>,task:Readonly<{tenantId:string;taskId:string}>)=>{
    let address:QualityBatchAddress|undefined;
    for(const phase of ['story','continuity','production'] as const)for(const batch of plan.phases[phase].batches)if(qualityBatchTaskId(run.key,cycle,phase,batch.index)===task.taskId)address={cycle,phase,index:batch.index};
    if(!address)throw new Error('Unknown owned quality batch');const role=plan.phases[address.phase],batch=role.batches[address.index]!,output:QualityModelOutput={version:1,assessments:batch.units.flatMap(unit=>role.topics.map(topic=>({unitId:unit.id,topicId:topic.id,verdict:'clear' as const,reason:'合成协议逐项核对，不代表真人质量判断。',severity:null,problem:null,audienceImpact:null,suggestion:null,ripple:[],evidence:[]}))).reverse()};change?.(output,address);
    const transport:HttpTransport={async exchange(){onCall();return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'fixture-quality-'+address!.phase+'-'+address!.index,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:80}}}};}};
    return new ModelSession(new OpenAiCompatibleLlm(transport,{model:'fixture-quality',structuredOutput:'json_schema'}),{tenantId:binding.tenantId,connectionId:binding.execution.connectionId,modeDigest:binding.execution.modeDigest,modelIdentity:binding.execution.modelIdentity,evidence:binding.execution.evidence,maxCalls:1,timeoutMs:2000,maxInputBytes:2097152,maxOutputBytes:524288});
  };
}

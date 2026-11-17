import { ModelSession } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import type { OutlineWorkflowOptions } from '../src/outline/node/workflow.js';
import { outlineFixture } from './outline-support.js';

/** Safe in a plain crash child: original synthetic protocol values only, no Vitest or external provider. */
export function outlineProtocolTransport(onCall:()=>void=()=>{},large=false):HttpTransport{
  return {async exchange(request){
    onCall();const messages=(request.body as {messages:{content:string}[]}).messages;
    const input=JSON.parse(messages.at(-1)!.content).untrustedSource as {source:{references:{id:string}[]}};
    const reference=input.source.references[0]!.id,output=outlineFixture().output;
    for(const decision of output.adaptation.decisions)decision.sourceRefIds=decision.action==='invent'?[]:[reference];
    for(const item of [...output.characters,...output.beats,...output.assets])item.origin.sourceRefIds=item.origin.kind==='invented'?[]:[reference];
    if(large){
      const asset=output.assets[0]!,decision=output.adaptation.decisions[0]!;
      output.assets=Array.from({length:128},(_,index)=>({...asset,id:`asset-${index}`,description:'x'.repeat(1000),narrativeRole:'y'.repeat(1000)}));
      output.adaptation.decisions=Array.from({length:128},(_,index)=>({...decision,id:`decision-${index}`,reason:'z'.repeat(1000)}));
    }
    return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'fixture-outline-workflow',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:150,completion_tokens:80}}}};
  }};
}
export function outlineSessionFactory(transport:HttpTransport):OutlineWorkflowOptions['sessionFor']{
  return async({tenantId,execution})=>new ModelSession(new OpenAiCompatibleLlm(transport,{model:'fixture-outline',structuredOutput:'json_schema'}),{
    tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:execution.evidence,maxCalls:1,timeoutMs:1000,maxInputBytes:2097152,maxOutputBytes:524288,
  });
}

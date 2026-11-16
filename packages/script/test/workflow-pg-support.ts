import { ModelSession } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import type { DevelopmentWorkflowOptions } from '../src/node/workflow.js';
import { foundationFixture } from './foundation-fixture.js';
import { episodeFixture } from './episode-fixture.js';

/** Synthetic protocol values only; safe to import from an owned crash child without a Vitest runtime. */
export function protocolTransport(onCall:()=>void=()=>{}):HttpTransport{
  return {async exchange(request){
    onCall();const messages=(request.body as {messages:{content:string}[]}).messages;const input=JSON.parse(messages.at(-1)!.content).untrustedSource as {foundation?:unknown;brief:{episodeCount:number}};
    const output=input.foundation?episodeFixture(input.brief.episodeCount).output:foundationFixture();
    return {status:200,contentType:'application/json',body:{kind:'json',value:{id:input.foundation?'fixture-episodes':'fixture-foundation',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:50,completion_tokens:30}}}};
  }};
}
export function sessionFactory(transport:HttpTransport):DevelopmentWorkflowOptions['sessionFor']{
  return async({tenantId,execution})=>new ModelSession(new OpenAiCompatibleLlm(transport,{model:'fixture-original',structuredOutput:'json_schema'}),{
    tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:execution.evidence,maxCalls:1,timeoutMs:2000,
  });
}

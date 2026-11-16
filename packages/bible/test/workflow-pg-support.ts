import { ModelSession } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import type { BibleWorkflowOptions } from '../src/node/workflow.js';
import { fixtureOutput } from './extraction-support.js';
export function protocolTransport(onCall:()=>void=()=>{}):HttpTransport {
  return {async exchange(request){onCall();const messages=(request.body as {messages:{content:string}[]}).messages;
    const input=JSON.parse(messages.at(-1)!.content).untrustedSource;
    return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'fixture-'+input.chunk.id,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(fixtureOutput(input.text))}}],usage:{prompt_tokens:15,completion_tokens:8}}}};
  }};
}
export function sessionFactory(transport:HttpTransport):BibleWorkflowOptions['sessionFor'] {
  return async({tenantId,execution})=>new ModelSession(new OpenAiCompatibleLlm(transport,{model:'fixture-story',structuredOutput:'json_schema'}),
    {tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:execution.evidence,maxCalls:1,timeoutMs:1000});
}

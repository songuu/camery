import { vi } from 'vitest';
import { MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import { createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack } from '../src/method-assets.js';
import { episodeFixture } from './episode-fixture.js';
export function developmentFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay'){
  const fixture=episodeFixture();const methods=new MethodRegistry();const foundationMethod=methods.register(createOriginalFoundationMethodPack());const episodeMethod=methods.register(createOriginalEpisodesMethodPack());
  const exchange=vi.fn<HttpTransport['exchange']>(async request=>{
    const messages=(request.body as {messages:{content:string}[]}).messages;const source=JSON.parse(messages.at(-1)!.content).untrustedSource;
    return {status:200,contentType:'application/json',body:{kind:'json',value:{id:source.foundation?'episode-reply':'foundation-reply',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(source.foundation?fixture.output:fixture.foundation)}}],usage:{prompt_tokens:50,completion_tokens:30}}}};
  });
  const session=new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'fixture-original',structuredOutput:'json_schema'}),{tenantId:fixture.brief.tenantId,connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/original',evidence,maxCalls:2,timeoutMs:1000});
  const runner=new MethodRunner(methods,[createStructuredGenerationExecutor(session)]);
  const context=(key:string)=>({tenantId:fixture.brief.tenantId,connectionId:'fixture',modeDigest:'a'.repeat(64),idempotencyKey:key,signal:new AbortController().signal});
  const host={tenantId:fixture.brief.tenantId,projectId:fixture.brief.projectId,actor:{kind:'human' as const,id:'human-fixture'},at:'2026-11-16T12:00:00.000Z',authorize:()=>true};
  return {...fixture,methods,foundationMethod,episodeMethod,exchange,session,runner,context,host};
}

import { vi } from 'vitest';
import { MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import { captureOutlineBrief } from '../src/outline/node/brief.js';
import { resolveOutlineSource } from '../src/outline/node/source.js';
import { createOutlineMethodPack } from '../src/outline/node/method-assets.js';
import { mappingFixture } from './development-mapping-fixture.js';
import { outlineFixture } from './outline-support.js';

/** A synthetic protocol fixture with explicit upstream human-host audits; no real inference or quality claim. */
export async function outlineModelFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay'){
  const upstream=await mappingFixture({count:3});
  const source=await resolveOutlineSource({kind:'development',...upstream.source},{development:{read:async()=>upstream.progress,isCurrent:async()=>true}});
  const sample=outlineFixture();const {sourceRefIds:_refs,...selection}=sample.context;
  const brief=captureOutlineBrief({tenantId:source.descriptor.tenantId,projectId:source.descriptor.projectId,briefId:'outline',revision:1,notes:'保持选择改变共同记忆的冲突。',...selection});
  const reference=(path:string)=>source.references.find(item=>item.path===path)!.id;
  const output=sample.output;output.adaptation.decisions[0]!.sourceRefIds=[reference('/foundation/world')];
  output.characters[0]!.origin.sourceRefIds=[reference('/foundation/characters/0')];
  for(const item of [...output.beats,...output.assets])item.origin.sourceRefIds=[reference('/foundation/world')];
  const exchange=vi.fn<HttpTransport['exchange']>(async()=>({status:200,contentType:'application/json',body:{kind:'json',value:{id:'outline-protocol-reply',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:150,completion_tokens:80}}}}));
  const session=new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'fixture-outline',structuredOutput:'json_schema'}),{tenantId:brief.tenantId,connectionId:'fixture-outline',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline',evidence,maxCalls:1,timeoutMs:1000,maxInputBytes:2097152,maxOutputBytes:524288});
  const methods=new MethodRegistry();const method=methods.register(createOutlineMethodPack());const runner=new MethodRunner(methods,[createStructuredGenerationExecutor(session)]);
  const context={tenantId:brief.tenantId,connectionId:'fixture-outline',modeDigest:'a'.repeat(64),idempotencyKey:'outline-call',signal:new AbortController().signal};
  const host={tenantId:brief.tenantId,projectId:brief.projectId,actor:{kind:'human' as const,id:'outline-editor'},at:'2026-11-17T10:30:00.000Z',authorize:()=>true};
  return {brief,source,output,exchange,session,methods,method,runner,context,host};
}

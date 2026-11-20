import {vi} from 'vitest';
import {MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import type {MethodExecution} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import type {HttpTransport,Json} from '@camery/model-modes';
import {prepareQualityReviewPlan,prepareQualityReviewAt} from '../src/quality/node/plan.js';
import {readQualitySource} from '../src/quality/node/source.js';
import {createDefaultQualityPolicy} from '../src/quality/catalog.js';
import {qualityDigest} from '../src/quality/node/data.js';
import {qualitySourceFixture} from './quality-source-support.js';
import {clearOutput,flagged} from './quality-model-support.js';

async function baseline(){const f=await qualitySourceFixture(),source=await readQualitySource(f.client,f.selection,f.readers,f.host),plan=prepareQualityReviewPlan('quality-task',source,createDefaultQualityPolicy());return prepareQualityReviewAt(plan,1,'story',0,[]);}
let cached:ReturnType<typeof baseline>|undefined;
/** Actual Methods/model protocol with isolated transport and output per call; this does not establish PostgreSQL authority. */
export async function qualityGenerationFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay',issue=false){
  const prepared=await(cached??=baseline()),raw=clearOutput(prepared.batch,[...prepared.topics]);
  if(issue)raw.assessments[0]=flagged(raw.assessments[0]!,[{path:'/output',start:0,end:0,quote:null}],'uncertain');
  raw.assessments.reverse();
  const exchange=vi.fn<HttpTransport['exchange']>(async()=>({status:200,contentType:'application/json',body:{kind:'json',value:{id:'review-protocol',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(raw)}}],usage:{prompt_tokens:300,completion_tokens:100}}}})),controller=new AbortController(),session=new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'quality-review',structuredOutput:'json_schema'}),{tenantId:prepared.plan.preparation.scope.tenantId,connectionId:'quality-review',modeDigest:'b'.repeat(64),modelIdentity:'fixture/quality-review',evidence,maxCalls:1,timeoutMs:2000,maxInputBytes:2097152,maxOutputBytes:524288}),registry=new MethodRegistry();
  registry.register(prepared.plan.phases.story.pack);const runner=new MethodRunner(registry,[createStructuredGenerationExecutor(session)]),call={tenantId:session.profile.tenantId,connectionId:session.profile.connectionId,modeDigest:session.profile.modeDigest,idempotencyKey:'quality-call',signal:controller.signal},options={prepared,method:prepared.method,runner,call};
  return {prepared,raw,exchange,controller,session,runner,call,options};
}
export async function qualityExecutionFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay',issue=false){const f=await qualityGenerationFixture(evidence,issue),execution=structuredClone(await f.runner.run(f.prepared.method,f.prepared.input as unknown as Json,f.call)),run=vi.fn<MethodRunner['run']>(async()=>execution);return {...f,execution,run,options:{...f.options,runner:{run}}};}
export function rehashQualityBatch<T extends {digest:string}>(value:T):T{const {digest:_digest,...body}=value;value.digest=qualityDigest(body);return value;}
export function receipt(execution:MethodExecution){return execution.trace[0]!.modelCall!;}

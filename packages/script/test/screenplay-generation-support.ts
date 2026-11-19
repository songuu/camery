import {vi} from 'vitest';
import {MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import type {HttpTransport} from '@camery/model-modes';
import {createScreenplayMethodPack} from '../src/screenplay/node/method-assets.js';
import type {ScreenplayModelOutput} from '../src/screenplay/node/model-contracts.js';
import {screenplayFixture} from './screenplay-support.js';
import {generationDigest,screenplayGenerationCommand} from '../src/screenplay/node/generation-state.js';
import type {ScreenplayGenerationRun} from '../src/screenplay/node/generation-contracts.js';
/** Explicit synthetic provider protocol. No live inference, real bill or human quality/signoff claim. */
export function screenplayGenerationFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay',number=1){
  const f=screenplayFixture(number),scope={tenantId:'screenplay-generation-tenant',projectId:'screenplay-generation-project'},notes='保留已采用大纲的冲突与完整前账。';
  const output:ScreenplayModelOutput={...structuredClone(f.draft),openingHook:f.draft.openingHook!,closingHook:f.draft.closingHook!,continuity:{assertFacts:[],retireFacts:[],learnFacts:[],useFacts:[],setCharacters:[],plantThreads:[],payoffThreads:[]}};
  const exchange=vi.fn<HttpTransport['exchange']>(async()=>({status:200,contentType:'application/json',body:{kind:'json',value:{id:'screenplay-protocol',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:80}}}}));
  const session=new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'fixture-screenplay',structuredOutput:'json_schema'}),{tenantId:scope.tenantId,connectionId:'screenplay-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/screenplay',evidence,maxCalls:1,timeoutMs:2000,maxInputBytes:2097152,maxOutputBytes:524288}),registry=new MethodRegistry(),method=registry.register(createScreenplayMethodPack()),runner=new MethodRunner(registry,[createStructuredGenerationExecutor(session)]);
  const call={tenantId:scope.tenantId,connectionId:session.profile.connectionId,modeDigest:session.profile.modeDigest,idempotencyKey:'screenplay-protocol-call',signal:new AbortController().signal};
  return {...f,scope,notes,output,exchange,session,registry,method,runner,call};
}
/** Pure protocol fixture only; actual source resolution belongs to the PostgreSQL integration cases. */
export function screenplayGenerationRunFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay'){
  const f=screenplayGenerationFixture(evidence),key={...f.scope,runId:'screenplay-run'},execution={connectionId:f.session.profile.connectionId,modeDigest:f.session.profile.modeDigest,modelIdentity:f.session.profile.modelIdentity,evidence:f.session.profile.evidence,modelTier:'balanced' as const,currency:'USD',reservation:{tokens:1000,costMicros:100},limits:{steps:1,tokens:1000,costMicros:100},...(evidence==='live_model'?{pricing:{inputMicrosPerMillionTokens:10000,outputMicrosPerMillionTokens:10000}}:{})};
  const body={version:1 as const,...key,candidateId:'generated-script',source:{version:1 as const,native:{version:1 as const,target:{tenantId:f.id('native-tenant'),projectId:f.context.projectId},packageId:f.context.packageId,snapshotRevision:f.context.snapshotRevision,episodeId:f.context.episode.id,packageDigest:generationDigest(f.head),contextDigest:generationDigest(f.context.nativeContext),previousDigest:null},contextDigest:generationDigest(f.context)},context:f.context,previous:null,notes:f.notes,method:f.method,execution,authorId:'editor',createdAt:'2026-11-19T00:00:00.000Z'};
  const record={...body,requestDigest:generationDigest(screenplayGenerationCommand(body))},run:ScreenplayGenerationRun={...record,digest:generationDigest(record)};return {...f,key,run,execution};
}

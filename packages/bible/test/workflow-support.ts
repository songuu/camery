import { vi } from 'vitest';
import { createStructuredGenerationExecutor, MethodRegistry, MethodRunner, ModelSession } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import type { BudgetLedger } from '@camery/agents';
import type { Json, TaskKey, WorkflowContext } from '@camery/durable';
import { stepIdempotencyKey } from '@camery/durable';
import { createStoryBibleMethodPack } from '../src/extraction.js';
import { createChunkPlan, validateChunkPlan } from '../src/chunks.js';
import { canonical, captureSource, hash } from '../src/data.js';
import { assembleBibleCandidate } from '../src/candidate.js';
import { sourceInput, fixtureOutput } from './extraction-support.js';
import type { BibleProgress, BibleRun, BibleStore } from '../src/node/contracts.js';
import { bibleRunDigest } from '../src/node/contracts.js';
export function workflowFixture() {
  const source=sourceInput('第一章 车站\n小林来到车站。\n第二章 来信\n小林收到来信。\n'); const snapshot=captureSource(source);
  const plan=validateChunkPlan(snapshot,createChunkPlan(source,{maxCharacters:22,maxBytes:88}));
  const methods=new MethodRegistry(); const method=methods.register(createStoryBibleMethodPack());
  const execution={connectionId:'fixture-connection',modeDigest:hash('fixture-mode'),modelIdentity:'fixture/story-model',evidence:'synthetic_replay' as const,
    modelTier:'economy' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:plan.chunks.length,tokens:plan.chunks.length*100,costMicros:0}};
  const run:BibleRun={tenantId:source.tenantId,projectId:source.projectId,runId:'run-one',source:snapshot,plan,method,execution,
    digest:bibleRunDigest(plan,method,execution),createdAt:'2026-11-16T10:00:00.000Z'};
  const progress:BibleProgress={run,records:[],candidate:null,review:null};
  const store:BibleStore={start:vi.fn(async()=>run),read:vi.fn(async()=>progress),isCurrent:vi.fn(async()=>true),
    saveChunk:vi.fn(async(_key,record)=>{const previous=progress.records.find(value=>value.chunkId===record.chunkId);if(!previous)Object.assign(progress,{records:[...progress.records,record]});return previous??record;}),
    materialize:vi.fn(async()=>{const candidate=assembleBibleCandidate(source,plan,progress.records,method);Object.assign(progress,{candidate});return candidate;}),
    confirm:vi.fn(async()=>{throw new Error('not used');}),reject:vi.fn(async()=>{throw new Error('not used');})};
  const allocate=vi.fn<BudgetLedger['allocate']>(async request=>({...request,taskFingerprint:hash(request),state:'held',confirmation:null}));
  const exchange=vi.fn<HttpTransport['exchange']>(async request=>{
    const messages=(request.body as {messages:{content:string}[]}).messages;const input=JSON.parse(messages.at(-1)!.content).untrustedSource;
    return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'reply-'+input.chunk.id,choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(fixtureOutput(input.text))}}],usage:{prompt_tokens:15,completion_tokens:8}}}};
  });
  const sessionFor=vi.fn(async()=>new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'fixture-story',structuredOutput:'json_schema'}),
    {tenantId:run.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,modelIdentity:run.execution.modelIdentity,evidence:run.execution.evidence,maxCalls:1,timeoutMs:1000}));
  // Node workflow constructs its own pinned runner from the host session; this runner is available for fixture assertions.
  const sessionRunner=(session:ModelSession)=>new MethodRunner(methods,[createStructuredGenerationExecutor(session)]);
  return {source,run,progress,store,ledger:{allocate},allocate,exchange,sessionFor,sessionRunner,key:{tenantId:run.tenantId,projectId:run.projectId,runId:run.runId}};
}
export function workflowJournal(task:TaskKey) {
  const cache=new Map<string,{input:string;output:Json}>();const signal=new AbortController().signal;
  const context:WorkflowContext={task,signal,async step(key,options,effect){const input=canonical(options);const prior=cache.get(key);
    if(prior){if(prior.input!==input)throw new Error('JOURNAL_CHANGED');return structuredClone(prior.output);}
    const result=await effect({input:options.input,idempotencyKey:stepIdempotencyKey(task,key),signal});cache.set(key,{input,output:structuredClone(result)});return result;},
    waitForSignal:async()=>{throw new Error('not expected');},sleepUntil:async()=>{throw new Error('not expected');}};
  return {context,cache};
}

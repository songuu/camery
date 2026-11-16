import { vi } from 'vitest';
import { ModelSession } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import type { BudgetLedger } from '@camery/agents';
import type { Json,TaskKey,WorkflowContext } from '@camery/durable';
import { stepIdempotencyKey } from '@camery/durable';
import { prepareDevelopmentStage,validateFoundationCandidate,validateEpisodeCandidate } from '../src/development.js';
import { createOriginalEpisodesMethodPack } from '../src/method-assets.js';
import { MethodRegistry } from '@camery/methods';
import { reviewFoundation,reviewEpisodes,rejectDevelopment } from '../src/review.js';
import { developmentRunDigest } from '../src/node/contracts.js';
import type { DevelopmentProgress,DevelopmentRun,DevelopmentStore } from '../src/node/contracts.js';
import { canonical,hash } from '../src/data.js';
import { developmentFixture } from './development-support.js';

export function workflowFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay'){
  const f=developmentFixture(evidence);const methods={foundation:prepareDevelopmentStage(f.brief,'foundation').method,episodes:new MethodRegistry().register(createOriginalEpisodesMethodPack())};
  const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/original',evidence,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:evidence==='live_model'?10:0},limits:{steps:2,tokens:200,costMicros:evidence==='live_model'?20:0}};
  const body={tenantId:f.brief.tenantId,projectId:f.brief.projectId,runId:'run-one',brief:f.brief,methods,execution};
  const run:DevelopmentRun={...body,digest:developmentRunDigest(body),createdAt:'2026-11-16T12:00:00.000Z'};
  const progress:DevelopmentProgress={run,foundation:{candidate:null,review:null},episodes:{candidate:null,review:null}};
  const store:DevelopmentStore={putBrief:vi.fn(async()=>({brief:f.brief,actorId:f.host.actor.id,createdAt:run.createdAt})),getBrief:vi.fn(async()=>({brief:f.brief,actorId:f.host.actor.id,createdAt:run.createdAt})),start:vi.fn(async()=>run),read:vi.fn(async()=>progress),isCurrent:vi.fn(async()=>true),
    saveCandidate:vi.fn<DevelopmentStore['saveCandidate']>(async(_key,candidate)=>{
      const stage=candidate.stage;const existing=progress[stage].candidate;if(existing)return existing;
      const checked=stage==='foundation'?validateFoundationCandidate(run.brief,candidate):validateEpisodeCandidate(run.brief,progress.foundation.review as ReturnType<typeof reviewFoundation>,candidate);
      Object.assign(progress[stage],{candidate:checked});return checked;
    }),
    review:vi.fn<DevelopmentStore['review']>(async(_key,stage,decision,host)=>{
      const candidate=progress[stage].candidate;if(!candidate)throw new Error('Fixture missing candidate');
      const result=stage==='foundation'?reviewFoundation(run.brief,candidate as NonNullable<DevelopmentProgress['foundation']['candidate']>,decision,host):reviewEpisodes(run.brief,progress.foundation.review as ReturnType<typeof reviewFoundation>,candidate as NonNullable<DevelopmentProgress['episodes']['candidate']>,decision,host);
      Object.assign(progress[stage],{review:result});return result;
    }),reject:vi.fn<DevelopmentStore['reject']>(async(_key,stage,reason,host)=>{
      const candidate=progress[stage].candidate;if(!candidate)throw new Error('Fixture missing candidate');
      const upstream=progress.foundation.review?.status==='reviewed'?progress.foundation.review:undefined;
      const result=rejectDevelopment(run.brief,candidate,reason,host,upstream);Object.assign(progress[stage],{review:result});return result;
    })};
  const allocate=vi.fn<BudgetLedger['allocate']>(async input=>({...input,taskFingerprint:hash(input),state:'held',confirmation:null}));
  const exchange=vi.fn<HttpTransport['exchange']>(f.exchange.getMockImplementation()!);
  const sessionFor=vi.fn(async()=>new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'fixture-original',structuredOutput:'json_schema'}),{tenantId:run.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence,maxCalls:1,timeoutMs:1000}));
  return {...f,run,progress,store,allocate,ledger:{allocate},exchange,sessionFor,key:{tenantId:run.tenantId,projectId:run.projectId,runId:run.runId}};
}
export function workflowJournal(task:TaskKey){
  const cache=new Map<string,{input:string;output:Json}>();const signal=new AbortController().signal;
  function context():WorkflowContext{return {task:{...task},signal,async step(key,options,effect){
    const input=canonical(options);const prior=cache.get(key);if(prior){if(prior.input!==input)throw new Error('JOURNAL_CHANGED');return structuredClone(prior.output);}
    const output=await effect({input:options.input,idempotencyKey:stepIdempotencyKey(task,key),signal});cache.set(key,{input,output:structuredClone(output)});return output;
  },waitForSignal:async()=>{throw new Error('Fixture has no signals');},sleepUntil:async()=>{throw new Error('Fixture has no timers');}};}
  return {cache,context};
}

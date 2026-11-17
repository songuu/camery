import { vi } from 'vitest';
import type { BudgetLedger } from '@camery/agents';
import type { TaskKey } from '@camery/durable';
import { ModelSession } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import { outlineCallId,outlineTaskId } from '../src/outline/node/persistence-contracts.js';
import type { OutlineExecution } from '../src/outline/node/persistence-contracts.js';
import type { OutlineSourceSnapshot } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import { outlineModelFixture } from './outline-model-support.js';
import { outlineMemory } from './outline-store-memory.js';

export interface OutlineWorkflowFixtureOptions {
  readonly reservationTokens?:number;
  readonly reservationCostMicros?:number;
  readonly pricing?:OutlineExecution['pricing'];
  readonly source?:OutlineSourceSnapshot;
}
/** Synthetic adapter protocol and explicit test-host audits only; no real inference, bill or human quality signoff. */
export async function outlineWorkflowFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay',options:OutlineWorkflowFixtureOptions={}){
  const reservationTokens=options.reservationTokens??300,reservationCostMicros=options.reservationCostMicros??(evidence==='live_model'?10:0);
  const pricing=options.pricing===undefined?undefined:structuredClone(options.pricing);
  const f=await outlineModelFixture(evidence),source=options.source??f.source,db=outlineMemory(source);
  if(options.source){
    const reference=source.references[0]!.id;
    for(const decision of f.output.adaptation.decisions)decision.sourceRefIds=decision.action==='invent'?[]:[reference];
    for(const item of [...f.output.characters,...f.output.beats,...f.output.assets])item.origin.sourceRefIds=item.origin.kind==='invented'?[]:[reference];
  }
  const {version:_version,digest:_digest,profiles:_profiles,revision:_revision,...fields}=f.brief;
  const put={...fields,expectedRevision:0,actorId:f.host.actor.id};const brief=(await db.store.putBrief(put)).brief;
  const key={tenantId:brief.tenantId,projectId:brief.projectId,runId:'workflow-outline'};
  const execution:OutlineExecution={connectionId:f.session.profile.connectionId,modeDigest:f.session.profile.modeDigest,modelIdentity:f.session.profile.modelIdentity,evidence,modelTier:'balanced',currency:'CNY',
    reservation:{tokens:reservationTokens,costMicros:reservationCostMicros},limits:{steps:1,tokens:reservationTokens,costMicros:reservationCostMicros},...(pricing===undefined?{}:{pricing})};
  const command={...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:source.descriptor,execution};
  const run=await db.store.start(command);const task:TaskKey={tenantId:key.tenantId,taskId:outlineTaskId(key)};
  const sessionFor=vi.fn(async(binding:Readonly<{tenantId:string;projectId:string;execution:OutlineExecution}>,_task:Readonly<TaskKey>)=>new ModelSession(new OpenAiCompatibleLlm({exchange:f.exchange},{model:'fixture-outline',structuredOutput:'json_schema'}),{
    tenantId:binding.tenantId,connectionId:binding.execution.connectionId,modeDigest:binding.execution.modeDigest,modelIdentity:binding.execution.modelIdentity,evidence:binding.execution.evidence,
    maxCalls:1,maxInputBytes:2097152,maxOutputBytes:524288,timeoutMs:1000,
  }));
  const allocate=vi.fn<BudgetLedger['allocate']>(async input=>({...structuredClone(input),taskFingerprint:hash(input),state:'held',confirmation:null}));
  return {...f,key,task,run,store:db.store,db,put,command,brief:run.brief,source:run.source,execution:run.execution,context:{...f.context,idempotencyKey:outlineCallId(key)},
    progress:()=>db.store.read(key),exchange:f.exchange,sessionFor,allocate,ledger:{allocate}};
}

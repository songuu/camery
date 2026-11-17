import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {MethodRunner,MethodRegistry,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import {generateFoundation,generateEpisodes} from '../src/development.js';
import type {DevelopmentReviewHost,ReviewedDevelopment,DevelopmentBrief} from '../src/contracts.js';
import {createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack} from '../src/method-assets.js';
import {developmentStageCallId} from '../src/node/contracts.js';
import type {DevelopmentRun} from '../src/node/contracts.js';
import {PostgresDevelopmentStore} from '../src/node/store.js';
import {protocolTransport} from './workflow-pg-support.js';
import {fixtureId as id} from '../../ir/test/fixtures';

const registry=new MethodRegistry();
export const identityMethods={foundation:registry.register(createOriginalFoundationMethodPack()),episodes:registry.register(createOriginalEpisodesMethodPack())};
const execution={connectionId:'identity-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture-original',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
export async function identityPgFixture(pool:Pool,owned:string[],reviewEpisodes=true){
  const tenantId='local-ir-identities-'+randomUUID();owned.push(tenantId);const scope={tenantId,projectId:'project'};const store=new PostgresDevelopmentStore(pool);let calls=0;
  const target={tenantId:id(tenantId),projectId:id('identity-project-'+tenantId)};
  const put={...scope,briefId:'idea',expectedRevision:0,actorId:'author',idea:'修钟学徒收到未来的潮汐来信。',episodeCount:10,targetSeconds:120};const saved=await store.putBrief(put);
  const host:DevelopmentReviewHost={...scope,actor:{kind:'human',id:'source-reviewer'},at:'2026-11-17T04:00:00.000Z',authorize:()=>true};
  function stage(run:DevelopmentRun,phase:'foundation'|'episodes'){
    const session=new ModelSession(new OpenAiCompatibleLlm(protocolTransport(()=>{calls++;}),{model:run.execution.modelIdentity,structuredOutput:'json_schema'}),{tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,modelIdentity:run.execution.modelIdentity,evidence:run.execution.evidence,maxCalls:1,timeoutMs:2000});
    return {brief:run.brief,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(session)]),method:run.methods[phase],context:{tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,idempotencyKey:developmentStageCallId({...scope,runId:run.runId},phase),signal:new AbortController().signal}};
  }
  async function finishEpisodes(run:DevelopmentRun,foundation:ReviewedDevelopment<'foundation'>,review=true){
    const key={...scope,runId:run.runId};const candidate=await generateEpisodes({...stage(run,'episodes'),foundation});await store.saveCandidate(key,candidate);
    return review?await store.review(key,'episodes',{candidateDigest:candidate.digest,output:candidate.output},host):null;
  }
  async function start(runId:string,brief:DevelopmentBrief,review=true){
    const key={...scope,runId};const run=await store.start({...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,methods:identityMethods,execution});
    const candidate=await generateFoundation(stage(run,'foundation'));await store.saveCandidate(key,candidate);const foundation=await store.review(key,'foundation',{candidateDigest:candidate.digest,output:candidate.output},host) as ReviewedDevelopment<'foundation'>;
    const episodes=await finishEpisodes(run,foundation,review);return {run,foundation,source:{...key,runDigest:run.digest,briefDigest:run.brief.digest,foundationReviewDigest:foundation.digest,episodesReviewDigest:episodes?.digest??'f'.repeat(64)}};
  }
  const initial=await start('original',saved.brief,reviewEpisodes);return {...initial,scope,target,store,host,put,start,finishEpisodes,calls:()=>calls};
}

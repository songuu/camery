import {MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import {upgradeV05Package} from '@camery/ir';
import {fixtureId as id,makePackage} from '../../ir/test/fixtures';
import {captureBrief} from '../src/brief.js';
import {generateFoundation,generateEpisodes} from '../src/development.js';
import {reviewFoundation,reviewEpisodes} from '../src/review.js';
import {developmentMethodPins,developmentRunDigest,developmentStageCallId,developmentCandidateOwner,episodeExecutionFromFull} from '../src/node/contracts.js';
import type {DevelopmentProgress,DevelopmentRun} from '../src/node/contracts.js';
import type {DevelopmentFormalIdentities} from '../src/node/adoption-contracts.js';
import {foundationFixture} from './foundation-fixture.js';
import {episodeFixture} from './episode-fixture.js';

/** Actual protocol validation with explicit synthetic transport and host audits; never a live-model quality claim. */
export async function mappingFixture(options:{count?:number;revision?:number;runId?:string;parent?:{progress:DevelopmentProgress};constructorId?:boolean}={}){
  const count=options.count??2;const runId=options.runId??'mapping-source';const parent=options.parent?.progress;
  const sample=episodeFixture(count).brief;const brief=parent?.run.brief??captureBrief({tenantId:sample.tenantId,projectId:sample.projectId,briefId:sample.briefId,idea:sample.idea,episodeCount:sample.episodeCount,targetSeconds:sample.targetSeconds,revision:options.revision??1});
  const methods=developmentMethodPins();const fullExecution={connectionId:'fixture-mapping',modeDigest:'a'.repeat(64),modelIdentity:'fixture/original',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
  const inherited=parent?{runId:parent.run.origin?.foundation?.runId??parent.run.runId,runDigest:parent.run.origin?.foundation?.runDigest??parent.run.digest,candidateDigest:parent.foundation.candidate!.digest,reviewDigest:parent.foundation.review!.digest,execution:developmentCandidateOwner(parent.run,'foundation').execution}:null;
  const body={tenantId:brief.tenantId,projectId:brief.projectId,runId,brief,methods,execution:parent?episodeExecutionFromFull({...fullExecution,connectionId:'child-mapping'}):fullExecution,
    ...(parent?{origin:{version:1 as const,stage:'episodes' as const,sourceRunId:parent.run.runId,sourceRunDigest:parent.run.digest,actorId:'forker',foundation:inherited!}}:{})};
  const run:DevelopmentRun={...body,digest:developmentRunDigest(body),createdAt:'2026-11-17T04:00:00.000Z'};
  const foundationOutput=foundationFixture();const episodeOutput=episodeFixture(brief.episodeCount).output;
  if(options.constructorId){foundationOutput.world.rules[0]!.id='constructor';foundationOutput.openQuestions[0]!.id='constructor';for(const episode of episodeOutput.episodes)episode.ruleIds[0]='constructor';foundationOutput.mainline.ruleIds[0]='constructor';}
  const registry=new MethodRegistry();registry.register((await import('../src/method-assets.js')).createOriginalFoundationMethodPack());registry.register((await import('../src/method-assets.js')).createOriginalEpisodesMethodPack());
  const session=new ModelSession(new OpenAiCompatibleLlm({async exchange(request){const source=JSON.parse((request.body as {messages:{content:string}[]}).messages.at(-1)!.content).untrustedSource;return {status:200,contentType:'application/json',body:{kind:'json',value:{id:source.foundation?'episodes':'foundation',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(source.foundation?episodeOutput:foundationOutput)}}],usage:{prompt_tokens:50,completion_tokens:30}}}};}},{model:'fixture-original',structuredOutput:'json_schema'}),{tenantId:run.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,modelIdentity:run.execution.modelIdentity,evidence:'synthetic_replay',maxCalls:2,timeoutMs:1000});
  const runner=new MethodRunner(registry,[createStructuredGenerationExecutor(session)]);const context=(stage:'foundation'|'episodes')=>({tenantId:run.tenantId,connectionId:run.execution.connectionId,modeDigest:run.execution.modeDigest,idempotencyKey:developmentStageCallId({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},stage),signal:new AbortController().signal});
  const host=(actorId:string,at:string)=>({tenantId:run.tenantId,projectId:run.projectId,actor:{kind:'human' as const,id:actorId},at,authorize:()=>true});
  const candidate=parent?.foundation.candidate??await generateFoundation({brief,runner,method:methods.foundation,context:context('foundation')});
  const foundation=parent?.foundation.review?.status==='reviewed'?parent.foundation.review:reviewFoundation(brief,candidate!,{candidateDigest:candidate!.digest,output:candidate!.output},host('foundation-editor','2026-11-17T04:01:00.000Z'));
  const episodes=await generateEpisodes({brief,foundation,runner,method:methods.episodes,context:context('episodes')});const reviewed=reviewEpisodes(brief,foundation,episodes,{candidateDigest:episodes.digest,output:episodes.output},host('episode-editor','2026-11-17T04:02:00.000Z'));
  const progress:DevelopmentProgress={run,foundation:{candidate:candidate!,review:foundation},episodes:{candidate:episodes,review:reviewed}};
  const source={tenantId:run.tenantId,projectId:run.projectId,runId:run.runId,runDigest:run.digest,briefDigest:brief.digest,foundationReviewDigest:foundation.digest,episodesReviewDigest:reviewed.digest};
  const head=upgradeV05Package(makePackage());for(const [key,value] of Object.entries(head))if(Array.isArray(value))(head as unknown as Record<string,unknown>)[key]=[];head.project.source_ids=[];head.project.scope={label:'原创开发',expected_episode_count:0,expected_scene_count:0,expected_required_beat_count:0};head.project.rights_status='unknown';
  const owner=run.origin?.foundation??{runId:run.runId,runDigest:run.digest};
  const identities:DevelopmentFormalIdentities={tenantId:run.tenantId,projectId:run.projectId,target:{tenantId:id('formal-tenant'),projectId:head.project.id},foundationOwner:{runId:owner.runId,runDigest:owner.runDigest},planId:id('mapping-plan'),worldId:id('mapping-world-'+owner.runId),
    characters:foundation.output.characters.map(character=>({localId:character.id,id:id('mapping-character-'+owner.runId+'-'+character.id)})),relationships:foundation.output.relationships.map(relationship=>({localId:relationship.id,id:id('mapping-relationship-'+owner.runId+'-'+relationship.id)})),episodes:reviewed.output.episodes.map(episode=>({number:episode.number,episodeId:id('mapping-episode-'+episode.number),planId:id('mapping-episode-plan-'+episode.number)}))};
  const reviewers={foundation:{key:foundation.actorId,id:id('mapping-'+foundation.actorId)},episodes:{key:reviewed.actorId,id:id('mapping-'+reviewed.actorId)}};
  return {progress,source,identities,reviewers,head};
}

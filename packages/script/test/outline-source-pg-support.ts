import type { Pool } from 'pg';
import { MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import { PostgresBibleStore } from '@camery/bible/node';
import { PostgresDocumentStore } from '../../ingest/src/node/index.js';
import { reviewFixture } from '../../bible/test/review-support.js';
import { generateFoundation,generateEpisodes } from '../src/development.js';
import { createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack } from '../src/method-assets.js';
import { validateReviewedFoundation } from '../src/reviewed.js';
import { PostgresDevelopmentStore,developmentMethodPins,developmentStageCallId } from '../src/node/index.js';
import { captureOutlineBrief,generateOutline,createOutlineMethodPack,reviewOutline } from '../src/outline/node/index.js';
import type { OutlineBrief,OutlineSourceSnapshot } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import { protocolTransport } from './workflow-pg-support.js';
import { outlineFixture } from './outline-support.js';

type SourceTarget={tenantId:string;projectId:string};
const execution={connectionId:'outline-source-fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture-original',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:2,tokens:200,costMicros:0}};
function host(target:SourceTarget){return {...target,actor:{kind:'human' as const,id:'fixture-editor'},at:'2026-11-17T10:45:00.000Z',authorize:()=>true};}

/** Actual old PG stores and audits; caller owns scope, pool, migrations and cleanup. */
export async function createDevelopmentSourceFixture(pool:Pool,target:SourceTarget){
  const key={...target,runId:'development'};const store=new PostgresDevelopmentStore(pool);const put={...target,briefId:'idea',expectedRevision:0,actorId:'author',idea:'旧信让学徒重新决定港城的航期。',episodeCount:3,targetSeconds:90};const brief=(await store.putBrief(put)).brief;
  const run=await store.start({...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,methods:developmentMethodPins(),execution});
  const context=(stage:'foundation'|'episodes')=>({tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:developmentStageCallId(key,stage),signal:new AbortController().signal});
  const registry=new MethodRegistry();for(const pack of [createOriginalFoundationMethodPack(),createOriginalEpisodesMethodPack()])registry.register(pack);
  const session=new ModelSession(new OpenAiCompatibleLlm(protocolTransport(),{model:'fixture-original',structuredOutput:'json_schema'}),{tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:'synthetic_replay',maxCalls:2,timeoutMs:2000});
  const runner=new MethodRunner(registry,[createStructuredGenerationExecutor(session)]);
  const foundation=await generateFoundation({brief,runner,method:run.methods.foundation,context:context('foundation')});await store.saveCandidate(key,foundation);
  const reviewed=validateReviewedFoundation(brief,await store.review(key,'foundation',{candidateDigest:foundation.digest,output:{...foundation.output,title:'实际数据库中人工改名的港城'}},host(target)));
  const episodes=await generateEpisodes({brief,foundation:reviewed,runner,method:run.methods.episodes,context:context('episodes')});await store.saveCandidate(key,episodes);
  const episodesReview=await store.review(key,'episodes',{candidateDigest:episodes.digest,output:episodes.output},host(target));
  const descriptor={kind:'development' as const,...key,runDigest:run.digest,briefDigest:brief.digest,foundationReviewDigest:reviewed.digest,episodesReviewDigest:episodesReview.digest};
  return {target,key,store,put,descriptor,run};
}

export async function createBibleSourceFixture(pool:Pool,target:SourceTarget){
  const template=reviewFixture(),key={...target,runId:'bible'};const documents=new PostgresDocumentStore(pool);await documents.append({...target,documentId:'book',batchId:'first',expectedRevision:0,text:template.source.document.text});
  const model=template.candidate.records[0]!.model;
  const store=new PostgresBibleStore(pool);const run=await store.start({...key,documentId:'book',kind:'novel',expectedRevision:1,expectedSourceDigest:template.source.document.sourceDigest,method:template.candidate.method,chunkLimits:{maxCharacters:22,maxBytes:88},execution:{...execution,connectionId:model.connectionId,modeDigest:model.modeDigest,modelIdentity:model.modelIdentity,limits:{steps:10,tokens:1000,costMicros:0}}});
  for(const [index,entry] of template.candidate.records.entries()){
    const body={version:1 as const,planDigest:run.plan.digest,chunkId:run.plan.chunks[index]!.id,method:run.method,output:entry.output,model:{...entry.model,tenantId:target.tenantId}};await store.saveChunk(key,{...body,digest:hash(body)});
  }
  const candidate=await store.materialize(key);const confirmed=await store.confirm(key,{...template.decision,candidateDigest:candidate.digest},host(target));
  const descriptor={kind:'bible' as const,...key,runDigest:run.digest,documentId:'book',revision:confirmed.source.revision,sourceDigest:confirmed.source.sourceDigest,reviewDigest:confirmed.digest};
  return {target,key,store,documents,descriptor,run};
}

/** One structured-adapter protocol call; no live inference, billing, persisted outline or human quality grade. */
export async function createOutlineProposal(source:OutlineSourceSnapshot,options:{callId?:string;brief?:OutlineBrief}={}){
  const sample=outlineFixture(),output=sample.output,reference=source.references[0]!.id;const {sourceRefIds:_refs,...selection}=sample.context;
  output.adaptation.decisions[0]!.sourceRefIds=[reference];for(const item of [...output.characters,...output.beats,...output.assets])item.origin.sourceRefIds=[reference];
  const target={tenantId:source.descriptor.tenantId,projectId:source.descriptor.projectId};const brief=options.brief??captureOutlineBrief({...target,briefId:'adaptation',revision:1,notes:'保留人工确认的来源冲突。',...selection});
  let calls=0;const session=new ModelSession(new OpenAiCompatibleLlm({async exchange(){calls++;return {status:200,contentType:'application/json',body:{kind:'json',value:{id:'outline-source-protocol',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:150,completion_tokens:80}}}};}},{model:'fixture-outline',structuredOutput:'json_schema'}),{tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:'fixture/outline',evidence:'synthetic_replay',maxCalls:1,timeoutMs:2000});
  const registry=new MethodRegistry(),method=registry.register(createOutlineMethodPack());const context={tenantId:target.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:options.callId??'outline-proposal',signal:new AbortController().signal};
  const candidate=await generateOutline({brief,source,method,context,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(session)])});
  const reviewHost=host(target);const review=reviewOutline(brief,source,candidate,{candidateDigest:candidate.digest,output:candidate.output,ablations:[{genre:'suspense',judgment:'participates',reason:'模拟人工核对查证改变反击条件。'}],waivers:[]},reviewHost);
  return {brief,candidate,review,host:reviewHost,output,calls};
}

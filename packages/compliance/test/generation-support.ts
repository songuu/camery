import {vi} from 'vitest';
import {ModelSession,MethodRegistry,MethodRunner,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import type {HttpTransport} from '@camery/model-modes';
import {createComplianceMethodPack} from '../src/node/method-assets.js';
import {hash} from '../src/node/data.js';
import {projectScreenplayCorpus} from '../src/corpus.js';
import {createClassificationBatches} from '../src/classification.js';
import type {ModelOutput} from '../src/contracts.js';
import type {PrecheckSource} from '../src/node/source.js';
import {screenplayFixture} from '../../script/test/screenplay-support.js';
import {classificationFixture} from './classification-support.js';
/** Synthetic provider protocol only, not real inference, legal recall, human approval or billing. */
export function generationFixture(evidence:'synthetic_replay'|'live_model'='synthetic_replay'){
  const f=screenplayFixture(),scope={tenantId:'precheck-tenant',projectId:'precheck-project'},selection={key:{...scope,candidateId:'script'},variant:'candidate' as const,expectedPreparationDigest:'a'.repeat(64),expectedReviewDigest:null,finalization:null},speakers=[{id:f.speaker,name:f.context.characters.find(row=>row.id===f.speaker)!.name}],body={version:1 as const,selection,draft:f.draft,speakers,corpus:projectScreenplayCorpus(f.draft,speakers)},source:PrecheckSource={...body,digest:hash(body)},policy=classificationFixture().policy,batch=createClassificationBatches(policy,source.corpus)[0]!,output:ModelOutput={version:1,assessments:batch.segments.flatMap(s=>policy.categories.map(c=>({segmentId:s.id,categoryId:c.id,verdict:'not_flagged' as const,start:0,end:0,quote:null,reason:'仅合成分类，不代表合法。'}))).reverse()};
  const exchange=vi.fn<HttpTransport['exchange']>(async()=>({status:200,contentType:'application/json',body:{kind:'json',value:{id:'synthetic-precheck',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(output)}}],usage:{prompt_tokens:100,completion_tokens:90}}}})),session=new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'fixture-precheck',structuredOutput:'json_schema'}),{tenantId:scope.tenantId,connectionId:'fixture-precheck',modeDigest:'b'.repeat(64),modelIdentity:'fixture/precheck',evidence,maxCalls:1,maxInputBytes:2097152,maxOutputBytes:524288,timeoutMs:2000}),registry=new MethodRegistry(),method=registry.register(createComplianceMethodPack()),runner=new MethodRunner(registry,[createStructuredGenerationExecutor(session)]),call={tenantId:scope.tenantId,connectionId:session.profile.connectionId,modeDigest:session.profile.modeDigest,idempotencyKey:'precheck-protocol-call',signal:new AbortController().signal};
  return {...f,scope,source,policy,batch,output,exchange,session,method,runner,call,index:0};
}

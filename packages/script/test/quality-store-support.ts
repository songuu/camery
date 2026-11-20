import {vi} from 'vitest';
import {MethodRegistry,MethodRunner,ModelSession,createStructuredGenerationExecutor} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import type {HttpTransport} from '@camery/model-modes';
import {PostgresQualityStore} from '../src/quality/node/store.js';
import {captureQualityBatchProgress} from '../src/quality/node/progress.js';
import {generateQualityReview} from '../src/quality/node/generation.js';
import {qualityBatchCallId} from '../src/quality/node/state.js';
import type {QualityBatchAddress} from '../src/quality/node/state.js';
import {qualityFreeFindings} from '../src/quality/node/preparation.js';
import {createDefaultQualityPolicy} from '../src/quality/catalog.js';
import {qualitySourceFixture} from './quality-source-support.js';
import {outlineMemory} from './outline-store-memory.js';
import {qualityStoreMemory,qualitySharedProtocol} from './quality-store-memory.js';
import {nodeQualityExecution,nodeQualityPhases} from './quality-node-state-support.js';
import {clearOutput,flagged} from './quality-model-support.js';

let cached:ReturnType<typeof qualitySourceFixture>|undefined;
/** Real quality store + actual pure Outline/source/model protocols over explicit SQL memory. Does not prove real PostgreSQL behavior. */
export async function qualityStoreFixture(){
  const original=await(cached??=qualitySourceFixture()),outline=outlineMemory(original.source);Object.assign(outline.data,structuredClone(original.data));
  const memory=qualityStoreMemory(async(sql,values)=>sql==='SHOW transaction_isolation'?{rows:[{transaction_isolation:'read committed'}]}:outline.query(sql,values)),readers={...original.readers,outline:outline.store},shared=qualitySharedProtocol(memory.pool),store=new PostgresQualityStore(memory.pool,readers),key={...original.key,runId:'quality-store'},host={scope:{tenantId:key.tenantId,projectId:key.projectId},actor:{kind:'human' as const,id:'editor'},at:'2026-11-19T05:00:00.000Z',authorize:vi.fn((_request:{action:string})=>true)},execution=nodeQualityExecution(),command={key,source:structuredClone(original.selection),policy:createDefaultQualityPolicy(),executions:{story:execution,continuity:execution,production:execution}},exchange=vi.fn<HttpTransport['exchange']>();
  async function model(address:QualityBatchAddress={cycle:1,phase:'story',index:0},issue=false){const progress=await store.readBatch(key,address,host),prepared=captureQualityBatchProgress(key,address,progress).prepared,raw=clearOutput(prepared.batch,[...prepared.topics]);if(issue)raw.assessments[0]=flagged(raw.assessments[0]!,[{path:'/output',start:0,end:0,quote:null}],'uncertain');raw.assessments.reverse();exchange.mockImplementation(async()=>({status:200,contentType:'application/json',body:{kind:'json',value:{id:'quality-store-protocol',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(raw)}}],usage:{prompt_tokens:30,completion_tokens:10}}}}));const execution=progress.run.reviewers[address.phase].execution,session=new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'quality-store',structuredOutput:'json_schema'}),{tenantId:key.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:execution.evidence,maxCalls:1,timeoutMs:2000,maxInputBytes:2097152,maxOutputBytes:524288}),registry=new MethodRegistry();registry.register(prepared.plan.phases[address.phase].pack);return generateQualityReview({prepared,method:prepared.method,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(session)]),call:{tenantId:key.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,idempotencyKey:qualityBatchCallId(key,address.cycle,address.phase,address.index),signal:new AbortController().signal}});}
  async function saveModel(address:QualityBatchAddress={cycle:1,phase:'story',index:0},issue=false){const result=await model(address,issue);return store.saveBatch(key,address,result,host);}
  async function stages(cycle:1|2=1,issue=false){for(const phase of nodeQualityPhases){const progress=await store.read(key,host),count=progress.cycles[cycle-1]!.record.manifests![phase].count;for(let index=0;index<count;index++)await saveModel({cycle,phase,index},issue&&phase==='story');await store.completeStage(key,cycle,phase,host);}return store.read(key,host);}
  async function waiveFree(cycle:1|2=1){const progress=await store.read(key,host),material=progress.cycles[cycle-1]!,findings=qualityFreeFindings(material.preparation).filter(finding=>finding.waivable);return findings.length?store.waive(key,{cycle,target:{kind:'free'},resultDigest:material.preparation.digest,findings:findings.map(finding=>({id:finding.id,reason:'人工核对后保留此表达，协议夹具不宣称质量通过。'}))},host):[];}
  async function reviseOutline(){const output=structuredClone(original.candidate.output);output.adaptation.logline+=' 人工修订后的第二周期。';const review=await outline.store.review(original.key,{candidateDigest:original.candidate.digest,output,ablations:[{genre:'suspense',judgment:'participates',reason:'人工核对查证改变反击。'}],waivers:[]},original.outlineHost);return {...structuredClone(original.selection),variant:'reviewed' as const,expectedReviewDigest:review.digest};}
  return {memory,shared,data:memory.data,dbState:memory.state,query:memory.query,client:memory.client,pool:memory.pool,connect:memory.connect,release:memory.release,outline,readers,store,key,host,command,exchange,model,saveModel,stages,waiveFree,reviseOutline};
}

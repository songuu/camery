import {vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
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
import {qualityScreenplaySourceFixture} from './quality-screenplay-source-support.js';
import {qualityStoreMemory,qualitySharedProtocol} from './quality-store-memory.js';
import {nodeQualityExecution,nodeQualityPhases} from './quality-node-state-support.js';
import {clearOutput,flagged} from './quality-model-support.js';
import {ScreenplayKeySchema} from '../src/screenplay/node/contracts.js';
import type {ScreenplayDraft} from '../src/screenplay/contracts.js';
import {continuityDigest} from '../src/continuity/node/digest.js';

/** Real quality/source/candidate/Methods constructors over SQL and repository protocols; actual native proofs, locks and FK require PG. */
export async function qualityScreenplayStoreFixture(options:Parameters<typeof qualityScreenplaySourceFixture>[0]={}){
  const source=await qualityScreenplaySourceFixture(options),memory=qualityStoreMemory(async()=>{throw new Error('Unexpected Outline SQL in isolated screenplay repository protocol');});
  const connect=vi.fn(async()=>{const client=await memory.pool.connect();return new Proxy(client,{get(target,key){if(key==='query')return async(sql:string,values?:unknown[])=>{if(sql.includes("to_regclass('camery_screenplay.generation_deliveries')")||sql.includes('FROM camery_screenplay.generation_runs')||sql.includes('FROM camery_screenplay.generation_deliveries')){const result=await source.query(sql,values);return {...result,rowCount:result.rows.length};}return target.query(sql,values);};const value:unknown=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as PoolClient;}),pool={connect} as unknown as Pool,shared=qualitySharedProtocol(pool),store=new PostgresQualityStore(pool,source.readers),key={...source.scope,runId:'quality-screenplay-store'},execution=nodeQualityExecution(),command={key,source:structuredClone(source.selection),policy:createDefaultQualityPolicy(),executions:{story:execution,continuity:execution,production:execution}},exchange=vi.fn<HttpTransport['exchange']>();
  async function model(address:QualityBatchAddress={cycle:1,phase:'story',index:0},issue=false){const progress=await store.readBatch(key,address,source.host),prepared=captureQualityBatchProgress(key,address,progress).prepared,raw=clearOutput(prepared.batch,[...prepared.topics]);if(issue)raw.assessments[0]=flagged(raw.assessments[0]!,[{path:'/draft',start:0,end:0,quote:null}],'uncertain');raw.assessments.reverse();exchange.mockImplementation(async()=>({status:200,contentType:'application/json',body:{kind:'json',value:{id:'quality-sc-store-protocol',choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(raw)}}],usage:{prompt_tokens:30,completion_tokens:10}}}}));const profile=progress.run.reviewers[address.phase].execution,session=new ModelSession(new OpenAiCompatibleLlm({exchange},{model:'quality-sc-store',structuredOutput:'json_schema'}),{tenantId:key.tenantId,connectionId:profile.connectionId,modeDigest:profile.modeDigest,modelIdentity:profile.modelIdentity,evidence:profile.evidence,maxCalls:1,timeoutMs:2000,maxInputBytes:2097152,maxOutputBytes:524288}),registry=new MethodRegistry();registry.register(prepared.plan.phases[address.phase].pack);return generateQualityReview({prepared,method:prepared.method,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(session)]),call:{tenantId:key.tenantId,connectionId:profile.connectionId,modeDigest:profile.modeDigest,idempotencyKey:qualityBatchCallId(key,address.cycle,address.phase,address.index),signal:new AbortController().signal}});}
  async function stages(cycle:1|2=1,issue=false){for(const phase of nodeQualityPhases){const view=await store.read(key,source.host),count=view.cycles[cycle-1]!.record.manifests![phase].count;for(let index=0;index<count;index++){const address={cycle,phase,index},result=await model(address,issue&&phase==='story');await store.saveBatch(key,address,result,source.host);}await store.completeStage(key,cycle,phase,source.host);}return store.read(key,source.host);}
  async function waiveFree(cycle:1|2=1){const progress=await store.read(key,source.host),material=progress.cycles[cycle-1]!,findings=qualityFreeFindings(material.preparation).filter(row=>row.waivable);return findings.length?store.waive(key,{cycle,target:{kind:'free'},resultDigest:material.preparation.digest,findings:findings.map(row=>({id:row.id,reason:'协议夹具的人类保留理由，非真人质量验收。'}))},source.host):[];}
  return {...source,memory,data:memory.data,dbState:memory.state,qualityQuery:memory.query,pool,connect,shared,store,qualityKey:key,execution,command,exchange,model,stages,waiveFree};
}

/** Keep the preparation command audit aligned with the pure candidate when a scenario edits its draft or native context. */
export function refreshQualityScreenplayPreparation(f:Awaited<ReturnType<typeof qualityScreenplayStoreFixture>>){const preparation=f.state.progress.preparation,command={key:preparation.key,target:f.target,expectedSnapshotRevision:preparation.source.native.snapshotRevision,expectedPackageDigest:preparation.source.native.packageDigest,rules:preparation.context.rules,draft:preparation.candidate.draft,authorId:preparation.authorId};preparation.commandDigest=continuityDigest(command,67108864);const {digest:_digest,...body}=preparation;preparation.digest=continuityDigest(body,67108864);f.selection.expectedPreparationDigest=preparation.digest;return preparation;}

/** Create another pure preparation audit and retain both immutable repository views; this does not create a database/native revision. */
export function forkQualityScreenplayCandidate(f:Awaited<ReturnType<typeof qualityScreenplayStoreFixture>>,candidateId:string,edit:(draft:ScreenplayDraft)=>void){
  const previous=structuredClone(f.state.progress),previousView=structuredClone(f.view()),oldKey={...previous.preparation.key};f.state.progress=structuredClone(previous);f.state.progress.review=null;f.state.progress.preparation.key.candidateId=candidateId;edit(f.state.progress.preparation.candidate.draft);f.selection.key={...oldKey,candidateId};f.selection.variant='candidate';f.selection.expectedReviewDigest=null;f.rebuild();
  refreshQualityScreenplayPreparation(f);const next=f.state.progress,nextView=structuredClone(f.view());
  f.scripts.readHistorical.mockImplementation(async(_client,input)=>ScreenplayKeySchema.parse(input).candidateId===oldKey.candidateId?previous:next);return {previous,previousView,next,nextView};
}

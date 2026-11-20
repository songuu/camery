import {digest} from '@camery/methods';
import {qualityNodeStateFixture,nodeQualityExecution} from './quality-node-state-support.js';
import {qualityDigest} from '../src/quality/node/data.js';
import {qualityCycleMaterial,qualityBatchCallId,qualityReviewers,qualityInitialState,qualityRunRequest} from '../src/quality/node/state.js';
import type {QualityRun} from '../src/quality/node/state.js';
import type {QualityBatchAddress,StoredQualityCycle} from '../src/quality/node/state.js';
import {qualitySourceReference} from '../src/quality/node/source.js';
import type {QualitySource} from '../src/quality/node/source.js';
import {createDefaultQualityPolicy} from '../src/quality/catalog.js';
import {completeQualityStage,resolveQualityCycle,reviseQualityReview} from '../src/quality/state.js';
import type {QualityReview} from '../src/quality/state.js';
import {captureQualityBatchProgress} from '../src/quality/node/progress.js';
import {createQualityReviewedBatch} from '../src/quality/node/generation.js';
import type {QualityReviewedBatch} from '../src/quality/node/generation.js';
import {clearOutput,flagged} from './quality-model-support.js';

export function rehashProgress<T extends {digest:string}>(value:T):T{const {digest:_digest,...body}=value;return {...value,digest:qualityDigest(body)};}
/** Each component is a genuine pure-constructor derivative; source freshness and database receipts still require actual readers. */
export function qualityLargeProgress(source:QualitySource){
  const key={...source.scope,runId:'quality-large-progress'},policy=createDefaultQualityPolicy(),material=qualityCycleMaterial(key,source,policy),execution=nodeQualityExecution();execution.limits={steps:16384,tokens:1638400,costMicros:81920};
  const reviewers=qualityReviewers({story:execution,continuity:execution,production:execution}),initialState=qualityInitialState(key,reviewers,material),body={version:1 as const,key,policy,reviewers,sourceSelection:source.selection,initialSourceDigest:source.digest,initialPreparationDigest:material.preparation.digest,initialState,authorId:'progress-editor',createdAt:'2026-11-19T05:00:00.000Z',requestDigest:''};body.requestDigest=qualityDigest(qualityRunRequest(body));
  const run:QualityRun={...body,digest:qualityDigest(body)},recordBody={version:1 as const,key,number:1 as const,runDigest:run.digest,sourceDigest:source.digest,preparationDigest:material.preparation.digest,manifests:material.manifests,actorId:run.authorId,at:run.createdAt},record={...recordBody,digest:qualityDigest(recordBody)},progress={run,cycles:[{record,source,preparation:material.preparation,plan:material.plan}],state:run.initialState,result:null},address:QualityBatchAddress={cycle:1,phase:'story',index:0};
  return {key,address,progress,material};
}
/** Pure constructors and captured-data protocol only: these rehashed fixtures prove no database/source authority or paid eligibility. */
export async function qualityProgressFixture(cycle:1|2=1,phase:QualityBatchAddress['phase']='story',result=false){
  const f=await qualityNodeStateFixture(),first={record:f.cycle,source:structuredClone(f.source),preparation:structuredClone(f.material.preparation),plan:f.material.plan},cycles=[first],address:QualityBatchAddress={cycle,phase,index:0};let state=structuredClone(f.run.initialState);
  function stage(before:QualityReview,material:ReturnType<typeof qualityCycleMaterial>,role:QualityBatchAddress['phase'],issues=0){const manifest=material.manifests![role],body={phase:role,sourceDigest:material.source.digest,policyDigest:material.preparation.policyDigest,reviewerDigest:digest(before.definition.reviewers[role]),method:before.definition.reviewers[role].method,manifestDigest:manifest.digest,expectedBatches:manifest.count,completedBatches:manifest.count,issueCount:issues};return completeQualityStage(before,{...body,digest:digest(body)},before.digest);}
  let material=f.material;
  if(cycle===2){
    for(const role of ['story','continuity','production'] as const)state=stage(state,material,role,role==='story'?1:0);
    const active=state.projection.cycles[0]!;state=resolveQualityCycle(state,{sourceDigest:active.source.digest,gateDigest:active.gates.digest,stageDigests:active.stages.map(row=>row.digest),openGateWaivable:active.gates.waivable,openStageIssues:active.stages.map(row=>row.issueCount),waiverDigest:null},state.digest);
    const source=structuredClone(f.source);if(source.subject.kind!=='outline')throw new Error('Progress fixture expects Outline');source.subject.output.adaptation.logline+='第二周期的新文本。';const revised=rehashProgress(source);material=qualityCycleMaterial(f.key,revised,f.policy);state=reviseQualityReview(state,{source:qualitySourceReference(revised),gates:material.preparation.summary},state.digest);
    const body={...f.cycle,number:2 as const,sourceDigest:revised.digest,preparationDigest:material.preparation.digest,manifests:material.manifests,at:'2026-11-19T05:01:00.000Z'},record:StoredQualityCycle=rehashProgress(structuredClone(body));cycles.push({record,source:revised,preparation:structuredClone(material.preparation),plan:material.plan});
  }
  const preceding=['story','continuity','production'].indexOf(phase);for(const role of (['story','continuity','production'] as const).slice(0,preceding))state=stage(state,material,role);
  const progress={run:f.run,cycles,state,result:null as QualityReviewedBatch|null};
  if(result){const prepared=captureQualityBatchProgress(f.key,address,progress).prepared,raw=clearOutput(prepared.batch,[...prepared.topics]);raw.assessments[0]=flagged(raw.assessments[0]!,[{path:'/output',start:0,end:0,quote:null}],'uncertain');raw.assessments.reverse();const execution=f.run.reviewers[phase].execution,receipt={tenantId:f.key.tenantId,connectionId:execution.connectionId,modeDigest:execution.modeDigest,modelIdentity:execution.modelIdentity,evidence:execution.evidence,callId:qualityBatchCallId(f.key,cycle,phase,0),providerRequestId:'quality-progress-original',inputDigest:prepared.inputDigest,outputDigest:digest(raw),usage:{inputTokens:300,outputTokens:100}};progress.result=createQualityReviewedBatch(prepared,raw,receipt);}
  return {...f,address,material,progress,stage};
}

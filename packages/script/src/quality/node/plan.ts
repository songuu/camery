import {z} from 'zod';
import {MethodRegistry,MethodError,Pin,digest,prepareStructuredGenerationRequest} from '@camery/methods';
import type {MethodPack} from '@camery/methods';
import type {Json} from '@camery/model-modes';
import {Hash,Integer} from '../../contracts.js';
import {QualityError,QualityPhaseSchema,QUALITY_MATERIAL_BYTES} from '../contracts.js';
import type {QualityPhase} from '../contracts.js';
import {captureQuality,freezeQuality} from '../boundary.js';
import {validateQualityPolicy} from '../catalog.js';
import {createQualityReviewTopics,captureQualityLogicalRoot} from '../model.js';
import {QUALITY_REVIEW_INPUT_BYTES,QUALITY_REVIEW_MAX_BATCHES,QUALITY_REVIEW_PAIRS,QUALITY_REVIEW_UNIT_TARGET_BYTES,QUALITY_REVIEW_UNITS_PER_BATCH} from '../model-contracts.js';
import type {QualityReviewBatch,QualityReviewUnit,QualityReviewTopic} from '../model-contracts.js';
import {validateQualitySource} from './source.js';
import {prepareQualityChecks} from './preparation.js';
import {createQualityReviewMethodPack} from './method-assets.js';
import {qualityDigest,canonicalQualityData} from './data.js';

const phases=['story','continuity','production'] as const;
const Cycle=z.union([z.literal(1),z.literal(2)]);
const ownedPlans=new WeakSet<object>(),ownedRequests=new WeakSet<object>();
interface PhasePlan{readonly topics:readonly QualityReviewTopic[];readonly batches:readonly QualityReviewBatch[];readonly manifestDigest:string;readonly pack:MethodPack;readonly method:z.infer<typeof Pin>}
type PlanBase=Pick<QualityReviewPlan,'preparation'>;
export interface QualityReviewPlan{readonly source:ReturnType<typeof validateQualitySource>;readonly policy:ReturnType<typeof validateQualityPolicy>;readonly preparation:ReturnType<typeof prepareQualityChecks>;readonly root:Json;readonly phases:Readonly<Record<QualityPhase,PhasePlan>>}
function fail(code:QualityError['code'],path:string):never{throw new QualityError(code,'complete quality review plan',path);}
function boundary(error:unknown):never{let known=false,limit=false;try{known=error instanceof QualityError;limit=error instanceof MethodError&&error.code==='DATA_LIMIT';}catch{/* Opaque dependency exceptions cannot supply diagnostics. */}if(known)throw error;return fail(limit?'INPUT_LIMIT':'INVALID_INPUT','request');}
function escape(part:string){return part.replaceAll('~','~0').replaceAll('/','~1');}
function size(value:unknown){return Buffer.byteLength(canonicalQualityData(value,QUALITY_MATERIAL_BYTES));}
function whole(text:string,offset:number){return offset===0||offset===text.length||!(text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff&&text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff);}
function unit(kind:QualityReviewUnit['kind'],path:string,content:Json,start:number|null=null,end:number|null=null):QualityReviewUnit{
  if(path.length>1000)fail('INPUT_LIMIT','unit path');const body={kind,path,start,end,content},hash=digest(body);return {id:'unit-'+hash,...body,digest:hash};
}
/** Recursive, exhaustive partition: every leaf/container belongs to exactly one unit; large strings retain original UTF-16 ranges. */
function partition(root:Json,path:string,units:QualityReviewUnit[]):void{
  if(units.length>=QUALITY_REVIEW_MAX_BATCHES*QUALITY_REVIEW_UNITS_PER_BATCH)fail('INPUT_LIMIT','complete unit count');
  if(size(root)<=QUALITY_REVIEW_UNIT_TARGET_BYTES){units.push(unit('subtree',path,root));return;}
  if(typeof root==='string'){
    let start=0;while(start<root.length){let low=start+1,high=Math.min(root.length,start+QUALITY_REVIEW_UNIT_TARGET_BYTES),end=start;
      while(low<=high){const middle=Math.floor((low+high)/2),bytes=Buffer.byteLength(JSON.stringify(root.slice(start,middle)));if(bytes<=QUALITY_REVIEW_UNIT_TARGET_BYTES){end=middle;low=middle+1;}else high=middle-1;}
      if(!whole(root,end))end--;if(end<=start)fail('INPUT_LIMIT','string unit');units.push(unit('string_slice',path,root.slice(start,end),start,end));start=end;if(units.length>QUALITY_REVIEW_MAX_BATCHES*QUALITY_REVIEW_UNITS_PER_BATCH)fail('INPUT_LIMIT','complete unit count');
    }return;
  }
  if(root===null||typeof root!=='object')fail('INPUT_LIMIT','unpartitionable unit');
  for(const key of Object.keys(root).sort()){const value=(root as Record<string,Json>)[key]!;partition(value,path+'/'+escape(key),units);}
}
function inputFor(base:PlanBase,phase:QualityPhase,topics:readonly QualityReviewTopic[],manifestDigest:string,batch:QualityReviewBatch,cycle:1|2,previousStageDigests:readonly string[]){const p=base.preparation;return {version:1,scope:p.scope,cycle,phase,sourceDigest:p.scope.sourceDigest,policyDigest:p.policyDigest,preparationDigest:p.digest,manifestDigest,previousStageDigests,topics,batch};}
function requestFor(pack:MethodPack,input:ReturnType<typeof inputFor>){try{const request=prepareStructuredGenerationRequest(pack,input as unknown as Json),envelope={messages:request.messages,outputSchema:request.outputSchema};if(size(envelope)>QUALITY_REVIEW_INPUT_BYTES)fail('INPUT_LIMIT','complete method request');return {inputDigest:digest(envelope)};}catch(error){return boundary(error);}}
function manifest(base:PlanBase,phase:QualityPhase,topics:readonly QualityReviewTopic[],batches:readonly QualityReviewBatch[]){return qualityDigest({phase,sourceDigest:base.preparation.scope.sourceDigest,policyDigest:base.preparation.policyDigest,preparationDigest:base.preparation.digest,topics,batches:batches.map(batch=>({index:batch.index,digest:qualityDigest(batch),unitIds:batch.units.map(row=>row.id)}))});}
function phasePlan(base:PlanBase,root:Json,phase:QualityPhase,topics:readonly QualityReviewTopic[]):PhasePlan{
  const pack=createQualityReviewMethodPack(phase),method=new MethodRegistry().register(pack),previous=Array.from({length:phases.indexOf(phase)},()=> '0'.repeat(64)),placeholder='0'.repeat(64);
  // A whole document is preferred when the actual encoded method envelope fits, including instructions and schema.
  if(size(root)<=QUALITY_REVIEW_INPUT_BYTES/2){const batch:QualityReviewBatch={version:1,phase,index:0,common:[],units:[unit('document','',root)]};try{requestFor(pack,inputFor(base,phase,topics,placeholder,batch,2,previous));const batches=[batch];return {topics,batches,manifestDigest:manifest(base,phase,topics,batches),pack,method};}catch(error){let limit=false;try{limit=error instanceof QualityError&&error.code==='INPUT_LIMIT';}catch{/* Opaque failures are not request-limit signals. */}if(!limit)throw error;}}
  if(root===null||typeof root!=='object'||Array.isArray(root))fail('INVALID_INPUT','logical root');
  const record=root as Record<string,Json>,residual=new Set(record['kind']==='screenplay'?['context','upstream']:['upstream']),common=Object.keys(record).filter(key=>!residual.has(key)).sort().map(key=>({path:'/'+escape(key),content:record[key]!})),units:QualityReviewUnit[]=[];
  for(const key of Object.keys(record).filter(key=>residual.has(key)).sort())partition(record[key]!,'/'+escape(key),units);
  const batches:QualityReviewBatch[]=[],maxUnits=Math.min(QUALITY_REVIEW_UNITS_PER_BATCH,Math.floor(QUALITY_REVIEW_PAIRS/topics.length));let current:QualityReviewUnit[]=[];
  function candidate(next:QualityReviewUnit[]){return {version:1 as const,phase,index:batches.length,common,units:next};}
  function fits(batch:QualityReviewBatch){try{requestFor(pack,inputFor(base,phase,topics,placeholder,batch,2,previous));return true;}catch(error){let limit=false;try{limit=error instanceof QualityError&&error.code==='INPUT_LIMIT';}catch{/* Other failures must not be silently partitioned around. */}if(!limit)throw error;return false;}}
  for(const next of units){const proposed=candidate([...current,next]);if(current.length&&(current.length>=maxUnits||!fits(proposed))){batches.push(candidate(current));if(batches.length>=QUALITY_REVIEW_MAX_BATCHES)fail('INPUT_LIMIT','complete batch count');current=[];}if(!current.length&&!fits(candidate([next])))fail('INPUT_LIMIT','complete common and unit request');current.push(next);}
  if(current.length)batches.push(candidate(current));if(!batches.length)fail('INCOMPLETE','complete batches');return {topics,batches,manifestDigest:manifest(base,phase,topics,batches),pack,method};
}
/** Captures one full immutable narrative view, preflights every role/batch, and grants no current-source or budget authority. */
export function prepareQualityReviewPlan(taskId:unknown,sourceInput:unknown,policyInput:unknown):QualityReviewPlan{
  try{const source=validateQualitySource(sourceInput),policy=validateQualityPolicy(policyInput),preparation=prepareQualityChecks(taskId,source,policy);if(preparation.summary.nonWaivable)fail('INCOMPLETE','non-waivable free gates');
    const root=captureQualityLogicalRoot({...source.subject,upstream:source.upstream,names:source.names,unknownPrincipalIds:source.unknownPrincipalIds}),base={preparation},roles={} as Record<QualityPhase,PhasePlan>;
    for(const phase of phases)roles[phase]=phasePlan(base,root,phase,createQualityReviewTopics(policy,phase));
    const plan=freezeQuality({source,policy,preparation,root,phases:roles});ownedPlans.add(plan);return plan;
  }catch(error){return boundary(error);}
}
export function prepareQualityReviewAt(plan:QualityReviewPlan,cycleInput:unknown,phaseInput:unknown,indexInput:unknown,previousInput:unknown){
  try{if(!ownedPlans.has(plan))fail('INVALID_INPUT','captured plan');const cycle=captureQuality(Cycle,cycleInput,'quality cycle',16),phase=captureQuality(QualityPhaseSchema,phaseInput,'quality phase',64),index=captureQuality(Integer.max(QUALITY_REVIEW_MAX_BATCHES-1),indexInput,'quality batch index',32),previousStageDigests=captureQuality(z.array(Hash).length(phases.indexOf(phase)),previousInput,'previous quality stages',256),role=plan.phases[phase],batch=role.batches[index];if(!batch)fail('INVALID_REFERENCE','batch index');const input=freezeQuality(inputFor(plan,phase,role.topics,role.manifestDigest,batch,cycle,previousStageDigests)),request=requestFor(role.pack,input),prepared=Object.freeze({plan,cycle,phase,index,batch,topics:role.topics,method:role.method,manifestDigest:role.manifestDigest,input,...request});ownedRequests.add(prepared);return prepared;
  }catch(error){return boundary(error);}
}
export type PreparedQualityReview=ReturnType<typeof prepareQualityReviewAt>;
export function assertPreparedQualityReview(prepared:PreparedQualityReview){if(!ownedRequests.has(prepared))fail('INVALID_INPUT','captured request');}

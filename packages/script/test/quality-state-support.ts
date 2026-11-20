import {digest} from '@camery/methods';
import {createQualityReview,completeQualityStage} from '../src/quality/state.js';
import type {QualityReview,QualityStageProof} from '../src/quality/state.js';
import type {QualityPhase} from '../src/quality/contracts.js';

export const qualityPhases=['story','continuity','production'] as const;
/** Pure control/protocol fixture. These identities and references are not actual source, receipt or waiver authority. */
export function qualityStateFixture(){
  const pin=(id:string)=>({id,version:'1.0.0',digest:'a'.repeat(64)}),reviewer=(phase:QualityPhase)=>({agent:pin('quality-'+phase),method:pin('review.'+phase),connectionId:'review-'+phase,modeDigest:(phase==='story'?'b':phase==='continuity'?'c':'d').repeat(64),modelIdentity:'review/'+phase,evidence:'synthetic_replay' as const}),reviewers={story:reviewer('story'),continuity:reviewer('continuity'),production:reviewer('production')};
  const definition:QualityReview['definition']={scope:{tenantId:'tenant',projectId:'project',taskId:'quality-task',objectId:'episode'},policyDigest:'e'.repeat(64),reviewers,source:{kind:'screenplay',objectId:'episode',digest:'f'.repeat(64),humanAuthorIds:['editor'],producingModels:[{modelIdentity:'writer/model',modeDigest:'a'.repeat(64)}]},gates:{digest:'1'.repeat(64),nonWaivable:0,waivable:1}};
  return {definition,reviewers,state:createQualityReview(definition)};
}
export function qualityStageProof(state:QualityReview,phase:QualityPhase,issues=0):QualityStageProof{const body={phase,sourceDigest:state.projection.cycles.at(-1)!.source.digest,policyDigest:state.definition.policyDigest,reviewerDigest:digest(state.definition.reviewers[phase]),method:state.definition.reviewers[phase].method,manifestDigest:'2'.repeat(64),expectedBatches:2,completedBatches:2,issueCount:issues};return {...body,digest:digest(body)};}
export function qualityStages(state:QualityReview,counts:readonly [number,number,number]=[0,0,0]){for(const [index,phase]of qualityPhases.entries())state=completeQualityStage(state,qualityStageProof(state,phase,counts[index]),state.digest);return state;}
export function qualityResolution(state:QualityReview,changes:{sourceDigest?:string;gateDigest?:string;stageDigests?:string[];openGateWaivable?:number;openStageIssues?:number[];waiverDigest?:string|null}={}){const cycle=state.projection.cycles.at(-1)!;return {sourceDigest:cycle.source.digest,gateDigest:cycle.gates.digest,stageDigests:cycle.stages.map(row=>row.digest),openGateWaivable:cycle.gates.waivable,openStageIssues:cycle.stages.map(row=>row.issueCount),waiverDigest:null,...changes};}
export function qualityRehash<T extends {digest:string}>(record:T):T{const {digest:_digest,...body}=record;return {...record,digest:digest(body)};}

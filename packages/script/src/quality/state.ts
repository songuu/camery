import {z} from 'zod';
import {Name,createQuestion} from '@camery/agents';
import type {AgentQuestion} from '@camery/agents';
import {Pin,digest,canonical} from '@camery/methods';
import {Id,Hash,Integer} from '../contracts.js';
import {QualityError,QualityPhaseSchema} from './contracts.js';
import type {QualityPhase} from './contracts.js';
import {captureQuality,freezeQuality} from './boundary.js';
const CONTROL_BYTES=1048576;
const Scope=z.strictObject({tenantId:Id,projectId:Id,taskId:Id,objectId:Id});
const ModelIdentity=z.strictObject({modelIdentity:Name,modeDigest:Hash});
export const QualitySourceReferenceSchema=z.strictObject({kind:z.enum(['outline','screenplay']),objectId:Id,digest:Hash,humanAuthorIds:z.array(Id).max(64),producingModels:z.array(ModelIdentity).max(32)});
export const QualityReviewerSchema=ModelIdentity.extend({agent:Pin,method:Pin,connectionId:Name,evidence:z.enum(['synthetic_replay','live_model'])});
const Reviewers=z.strictObject({story:QualityReviewerSchema,continuity:QualityReviewerSchema,production:QualityReviewerSchema});
const Gate=z.strictObject({digest:Hash,nonWaivable:Integer.max(65536),waivable:Integer.max(65536)});
export const QualityReviewDefinitionSchema=z.strictObject({scope:Scope,policyDigest:Hash,reviewers:Reviewers,source:QualitySourceReferenceSchema,gates:Gate});
export const QualityStageProofSchema=z.strictObject({phase:QualityPhaseSchema,sourceDigest:Hash,policyDigest:Hash,reviewerDigest:Hash,method:Pin,manifestDigest:Hash,expectedBatches:Integer.min(1).max(8192),completedBatches:Integer.max(8192),issueCount:Integer.max(2097152),digest:Hash});
export type QualityStageProof=z.infer<typeof QualityStageProofSchema>;
export const QualityCycleResolutionSchema=z.strictObject({sourceDigest:Hash,gateDigest:Hash,stageDigests:z.array(Hash).length(3),openGateWaivable:Integer.max(65536),openStageIssues:z.array(Integer.max(2097152)).length(3),waiverDigest:Hash.nullable()});
const Revision=z.strictObject({source:QualitySourceReferenceSchema,gates:Gate});
const Event=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('stage'),proof:QualityStageProofSchema}),z.strictObject({kind:z.literal('resolution'),resolution:QualityCycleResolutionSchema}),z.strictObject({kind:z.literal('revision'),revision:Revision})]);
const Envelope=z.strictObject({version:z.literal(1),kind:z.literal('text_quality_review'),definition:QualityReviewDefinitionSchema,events:z.array(Event).max(9),projection:z.unknown(),digest:Hash});
type Definition=z.infer<typeof QualityReviewDefinitionSchema>;
type ReviewEvent=z.infer<typeof Event>;
interface QualityCycle{number:1|2;source:z.infer<typeof QualitySourceReferenceSchema>;gates:z.infer<typeof Gate>;stages:QualityStageProof[];resolution:z.infer<typeof QualityCycleResolutionSchema>|null}
export interface QualityReviewProjection{status:'blocked'|'awaiting_story'|'awaiting_continuity'|'awaiting_production'|'awaiting_resolution'|'revision_required'|'reviewed_candidate'|'needs_human';cycles:QualityCycle[];question:AgentQuestion|null;evidenceScope:'text';mediaQualityVerified:false}
export interface QualityReview{version:1;kind:'text_quality_review';definition:Definition;events:ReviewEvent[];projection:QualityReviewProjection;digest:string}
const phases:readonly QualityPhase[]=['story','continuity','production'];
function invalid(code:QualityError['code'],path:string):never{throw new QualityError(code,'quality review state',path);}
function sourceFor(definition:Definition,source:z.infer<typeof QualitySourceReferenceSchema>){
  if(source.objectId!==definition.scope.objectId||source.humanAuthorIds.length+source.producingModels.length===0||new Set(source.humanAuthorIds).size!==source.humanAuthorIds.length||new Set(source.producingModels.map(row=>canonical(row))).size!==source.producingModels.length)invalid('INVALID_REFERENCE','source provenance');
  const reviewer=definition.reviewers.story;if(source.producingModels.some(model=>model.modelIdentity===reviewer.modelIdentity||model.modeDigest===reviewer.modeDigest))invalid('FORBIDDEN','independent story reviewer');
}
function replay(definition:Definition,events:ReviewEvent[]):QualityReviewProjection{
  sourceFor(definition,definition.source);if(new Set(phases.map(phase=>definition.reviewers[phase].agent.id)).size!==3)invalid('CONFLICT','reviewer roles');
  const projection:QualityReviewProjection={status:definition.gates.nonWaivable?'blocked':'awaiting_story',cycles:[{number:1,source:definition.source,gates:definition.gates,stages:[],resolution:null}],question:null,evidenceScope:'text',mediaQualityVerified:false};
  const escalate=()=>{projection.status='needs_human';const cycle=projection.cycles.at(-1)!;projection.question=createQuestion({questionId:'quality-'+digest({scope:definition.scope,policyDigest:definition.policyDigest,sourceDigest:cycle.source.digest,cycle:cycle.number}),taskId:definition.scope.taskId,scope:{tenantId:definition.scope.tenantId,projectId:definition.scope.projectId},objectIds:[definition.scope.objectId],prompt:`第二周期仍有未解决的文本质量问题，来源 ${cycle.source.digest}；请人工处理，不能自动开始第三周期。`,choices:[]});};
  for(const event of events){const cycle=projection.cycles.at(-1)!;
    if(event.kind==='stage'){
      const proof=event.proof,expected=phases[cycle.stages.length];if(!expected||projection.status!=='awaiting_'+expected||proof.phase!==expected)invalid('CONFLICT','stage order');
      const reviewer=definition.reviewers[expected],{digest:storedDigest,...body}=proof;if(proof.sourceDigest!==cycle.source.digest||proof.policyDigest!==definition.policyDigest||proof.reviewerDigest!==digest(reviewer)||canonical(proof.method)!==canonical(reviewer.method)||digest(body)!==storedDigest)invalid('CONFLICT','stage binding');if(proof.completedBatches!==proof.expectedBatches)invalid('INCOMPLETE','stage coverage');cycle.stages.push(proof);projection.status=cycle.stages.length===3?'awaiting_resolution':cycle.stages.length===1?'awaiting_continuity':'awaiting_production';
    }else if(event.kind==='resolution'){
      if(projection.status!=='awaiting_resolution'||cycle.resolution!==null||cycle.stages.length!==3)invalid('CONFLICT','cycle resolution');const r=event.resolution;
      if(r.sourceDigest!==cycle.source.digest||r.gateDigest!==cycle.gates.digest||r.stageDigests.some((value,index)=>value!==cycle.stages[index]!.digest)||r.openGateWaivable>cycle.gates.waivable||r.openStageIssues.some((value,index)=>value>cycle.stages[index]!.issueCount))invalid('CONFLICT','resolution binding');
      const reduced=r.openGateWaivable<cycle.gates.waivable||r.openStageIssues.some((value,index)=>value<cycle.stages[index]!.issueCount);if(reduced!==(r.waiverDigest!==null))invalid('INVALID_REFERENCE','human waiver reference');cycle.resolution=r;
      const pending=cycle.gates.nonWaivable+r.openGateWaivable+r.openStageIssues.reduce((sum,value)=>sum+value,0);if(pending===0)projection.status='reviewed_candidate';else if(cycle.number===1)projection.status='revision_required';else escalate();
    }else{
      if(!['revision_required','blocked'].includes(projection.status)||projection.cycles.length!==1)invalid('CONFLICT','two-cycle revision limit');const {source,gates}=event.revision;
      if(source.kind!==cycle.source.kind||source.digest===cycle.source.digest)invalid('CONFLICT','new source revision');sourceFor(definition,source);projection.cycles.push({number:2,source,gates,stages:[],resolution:null});projection.status=gates.nonWaivable?'needs_human':'awaiting_story';if(gates.nonWaivable)escalate();
    }
  }
  return projection;
}
function seal(definition:Definition,events:ReviewEvent[]):QualityReview{const body={version:1 as const,kind:'text_quality_review' as const,definition,events,projection:replay(definition,events)};return freezeQuality({...body,digest:digest(body)});}
/** Pure integrity/control projection. Only Node repositories can prove actual sources, completed receipts and human waivers. */
export function createQualityReview(input:unknown):QualityReview{return seal(captureQuality(QualityReviewDefinitionSchema,input,'quality definition',65536),[]);}
export function validateQualityReview(input:unknown,expectedDigest:unknown):QualityReview{
  const raw=captureQuality(Envelope,input,'quality review',CONTROL_BYTES),expected=captureQuality(Hash,expectedDigest,'expected quality review digest',128),actual=seal(raw.definition,raw.events);if(actual.digest!==expected||raw.digest!==expected||canonical(actual)!==canonical(raw))invalid('CONFLICT','stored review projection');return actual;
}
function append(input:unknown,expectedDigest:unknown,event:ReviewEvent){const state=validateQualityReview(input,expectedDigest);return seal(state.definition,[...state.events,event]);}
export function completeQualityStage(input:unknown,proof:unknown,expectedDigest:unknown){return append(input,expectedDigest,{kind:'stage',proof:captureQuality(QualityStageProofSchema,proof,'quality stage proof',8192)});}
export function resolveQualityCycle(input:unknown,resolution:unknown,expectedDigest:unknown){return append(input,expectedDigest,{kind:'resolution',resolution:captureQuality(QualityCycleResolutionSchema,resolution,'quality cycle resolution',8192)});}
export function reviseQualityReview(input:unknown,revision:unknown,expectedDigest:unknown){return append(input,expectedDigest,{kind:'revision',revision:captureQuality(Revision,revision,'quality source revision',16384)});}

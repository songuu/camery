import { z } from 'zod';
import { Name } from '@camery/agents';
import { MethodRegistry,Pin } from '@camery/methods';
import { stepIdempotencyKey } from '@camery/durable';
import { DevelopmentError,Id,Hash,Integer,BriefInputSchema,Stage } from '../contracts.js';
import type { DevelopmentBrief,DevelopmentCandidate,ReviewedDevelopment,RejectedDevelopment,DevelopmentReviewHost,DevelopmentStage } from '../contracts.js';
import type { MethodPin } from '@camery/methods';
import { copy,freeze,hash,parse } from '../data.js';
import { validateBrief } from '../brief.js';
import { canonicalTime } from '../reviewed.js';
import { createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack } from '../method-assets.js';

const ModelName=Name.refine(value=>value.isWellFormed());
export const ExecutionSchema=z.strictObject({connectionId:ModelName,modeDigest:Hash,modelIdentity:ModelName,evidence:z.enum(['live_model','synthetic_replay']),modelTier:z.literal('balanced'),
  currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),reservation:z.strictObject({tokens:Integer.min(1),costMicros:Integer}),
  pricing:z.strictObject({inputMicrosPerMillionTokens:Integer,outputMicrosPerMillionTokens:Integer}).optional(),limits:z.strictObject({steps:Integer.min(2),tokens:Integer,costMicros:Integer})});
export type DevelopmentExecution=z.infer<typeof ExecutionSchema>;
export const EpisodeExecutionSchema=ExecutionSchema.extend({limits:ExecutionSchema.shape.limits.extend({steps:Integer.min(1)})});
const FoundationOriginSchema=z.strictObject({runId:Id,runDigest:Hash,candidateDigest:Hash,reviewDigest:Hash,execution:ExecutionSchema});
const OriginFields={version:z.literal(1),sourceRunId:Id,sourceRunDigest:Hash,actorId:Id};
export const DevelopmentOriginSchema=z.discriminatedUnion('stage',[
  z.strictObject({...OriginFields,stage:z.literal('foundation'),foundation:z.null()}),
  z.strictObject({...OriginFields,stage:z.literal('episodes'),foundation:FoundationOriginSchema}),
]);
export type DevelopmentOrigin=z.infer<typeof DevelopmentOriginSchema>;
export const BriefKeySchema=z.strictObject({tenantId:Id,projectId:Id,briefId:Id});
export type DevelopmentBriefKey=z.infer<typeof BriefKeySchema>;
export const PutBriefSchema=BriefInputSchema.omit({revision:true}).extend({expectedRevision:Integer.max(Number.MAX_SAFE_INTEGER-1),actorId:Id});
export type PutDevelopmentBrief=z.infer<typeof PutBriefSchema>;
export const ReadBriefSchema=BriefKeySchema.extend({revision:Integer.min(1).optional()});
export interface StoredDevelopmentBrief {readonly brief:DevelopmentBrief;readonly actorId:string;readonly createdAt:string}
export const RunKeySchema=z.strictObject({tenantId:Id,projectId:Id,runId:Id});
export type DevelopmentRunKey=z.infer<typeof RunKeySchema>;
export const MethodPinsSchema=z.strictObject({foundation:Pin,episodes:Pin});
export const StartRunSchema=RunKeySchema.extend({briefId:Id,expectedRevision:Integer.min(1),expectedBriefDigest:Hash,methods:MethodPinsSchema,execution:ExecutionSchema});
export type StartDevelopmentRun=z.infer<typeof StartRunSchema>;
const ForkFields={...RunKeySchema.shape,sourceRunId:Id,expectedSourceRunDigest:Hash,expectedRevision:Integer.min(1),expectedBriefDigest:Hash,actorId:Id,methods:MethodPinsSchema};
export const StartForkSchema=z.discriminatedUnion('stage',[
  z.strictObject({...ForkFields,stage:z.literal('foundation'),expectedFoundationReviewDigest:z.null(),execution:ExecutionSchema}),
  z.strictObject({...ForkFields,stage:z.literal('episodes'),expectedFoundationReviewDigest:Hash,execution:EpisodeExecutionSchema}),
]);
export type StartDevelopmentFork=z.infer<typeof StartForkSchema>;
export interface DevelopmentRun extends DevelopmentRunKey {
  readonly brief:DevelopmentBrief;readonly methods:{readonly foundation:MethodPin;readonly episodes:MethodPin};readonly execution:DevelopmentExecution;readonly digest:string;readonly createdAt:string;readonly origin?:DevelopmentOrigin;
}
export interface DevelopmentStageProgress<S extends DevelopmentStage> {readonly candidate:DevelopmentCandidate<S>|null;readonly review:ReviewedDevelopment<S>|RejectedDevelopment|null}
export interface DevelopmentProgress {readonly run:DevelopmentRun;readonly foundation:DevelopmentStageProgress<'foundation'>;readonly episodes:DevelopmentStageProgress<'episodes'>}
/** Internal service API. Host authentication supplies scope and author; no migration or role escalation occurs at runtime. */
export interface DevelopmentStore {
  putBrief(input:unknown):Promise<StoredDevelopmentBrief>;
  getBrief(input:z.infer<typeof ReadBriefSchema>):Promise<StoredDevelopmentBrief>;
  start(input:unknown):Promise<DevelopmentRun>;
  fork(input:unknown):Promise<DevelopmentRun>;
  read(key:DevelopmentRunKey):Promise<DevelopmentProgress>;
  isCurrent(key:DevelopmentRunKey):Promise<boolean>;
  saveCandidate(key:DevelopmentRunKey,candidate:DevelopmentCandidate):Promise<DevelopmentCandidate>;
  review(key:DevelopmentRunKey,stage:DevelopmentStage,decision:unknown,host:DevelopmentReviewHost):Promise<ReviewedDevelopment>;
  reject(key:DevelopmentRunKey,stage:DevelopmentStage,reason:unknown,host:DevelopmentReviewHost):Promise<RejectedDevelopment>;
}
function checkedExecution(input:unknown,shares:1|2):DevelopmentExecution{
  const execution=parse(shares===2?ExecutionSchema:EpisodeExecutionSchema,copy(input),'stage execution');const {reservation,limits}=execution;
  if(execution.evidence==='live_model'&&(!execution.pricing||execution.pricing.inputMicrosPerMillionTokens>0||execution.pricing.outputMicrosPerMillionTokens>0)&&reservation.costMicros===0)throw new DevelopmentError('INVALID_INPUT','model cost reservation');
  if(BigInt(shares)*BigInt(reservation.tokens)>BigInt(limits.tokens)||BigInt(shares)*BigInt(reservation.costMicros)>BigInt(limits.costMicros))throw new DevelopmentError('INPUT_LIMIT','development budget shares');return freeze(execution);
}
export function executionForDevelopment(input:unknown):DevelopmentExecution{return checkedExecution(input,2);}
export function executionForEpisodes(input:unknown):DevelopmentExecution{return checkedExecution(input,1);}
/** Derive the sole new stage from a trusted full host profile; inherited work never receives a second allocation. */
export function episodeExecutionFromFull(input:unknown):DevelopmentExecution{
  const execution=executionForDevelopment(input);return executionForEpisodes({...execution,limits:{steps:1,tokens:execution.reservation.tokens,costMicros:execution.reservation.costMicros}});
}
export function developmentRunDigest(input:Pick<DevelopmentRun,'tenantId'|'projectId'|'runId'|'brief'|'methods'|'execution'|'origin'>):string{
  const fields=parse(z.object({...RunKeySchema.shape,brief:z.unknown(),methods:MethodPinsSchema,execution:EpisodeExecutionSchema,origin:DevelopmentOriginSchema.optional()}),copy(input),'run digest input');
  return hash({version:fields.origin?2:1,...fields});
}
export function developmentMethodPins():DevelopmentRun['methods']{
  const registry=new MethodRegistry();return freeze({foundation:registry.register(createOriginalFoundationMethodPack()),episodes:registry.register(createOriginalEpisodesMethodPack())});
}
const RunEnvelope=RunKeySchema.extend({brief:z.unknown(),methods:MethodPinsSchema,execution:EpisodeExecutionSchema,digest:Hash,createdAt:z.string().max(24),origin:DevelopmentOriginSchema.optional()});
/** Full trusted-store protocol validation, also used before a worker resolves any model session. */
export function validateDevelopmentRun(key:DevelopmentRunKey,input:unknown):DevelopmentRun{
  const scope=freeze(parse(RunKeySchema,copy(key),'run scope'));const raw=parse(RunEnvelope,copy(input),'run snapshot');const brief=validateBrief(raw.brief);const execution=raw.origin?.stage==='episodes'?executionForEpisodes(raw.execution):executionForDevelopment(raw.execution);
  if(raw.origin&&(raw.origin.sourceRunId===scope.runId||raw.origin.foundation?.runId===scope.runId))throw new DevelopmentError('CONFLICT','origin self reference');
  if(raw.origin?.foundation)executionForDevelopment(raw.origin.foundation.execution);
  const {origin,...plain}=raw;const normalized={...plain,brief,execution,...(origin?{origin}:{})};
  if(raw.tenantId!==scope.tenantId||raw.projectId!==scope.projectId||raw.runId!==scope.runId||brief.tenantId!==scope.tenantId||brief.projectId!==scope.projectId||!canonicalTime(raw.createdAt)
    ||hash(raw.methods)!==hash(developmentMethodPins())||raw.digest!==developmentRunDigest(normalized))throw new DevelopmentError('CONFLICT','run snapshot binding');
  return freeze(normalized);
}
export const DEVELOPMENT_STAGE_WORKFLOW='original.development-stage';
export const DEVELOPMENT_STAGE_WORKFLOW_VERSION=1;
export const DEVELOPMENT_REDO_WORKFLOW_VERSION=2;
function capturedRun(input:DevelopmentRun):DevelopmentRun{const value=copy(input);return validateDevelopmentRun({tenantId:value.tenantId,projectId:value.projectId,runId:value.runId},value);}
export function developmentWorkflowVersion(input:DevelopmentRun):1|2{return capturedRun(input).origin?2:1;}
/** Storage must resolve the referenced source rows. This tuple binds their original receipt; it grants no approval. */
export function developmentCandidateOwner(input:DevelopmentRun,stage:DevelopmentStage):{readonly key:DevelopmentRunKey;readonly execution:DevelopmentExecution}{
  const run=capturedRun(input);const phase=parse(Stage,stage,'candidate owner stage');const source=phase==='foundation'?run.origin?.foundation:null;
  return freeze({key:{tenantId:run.tenantId,projectId:run.projectId,runId:source?.runId??run.runId},execution:source?.execution??run.execution});
}
export function developmentStageTaskId(input:DevelopmentRunKey,stage:DevelopmentStage):string{
  return 'original-'+hash({key:parse(RunKeySchema,copy(input),'stage task scope'),stage:parse(Stage,stage,'stage task phase')});
}
export function developmentStageCallId(input:DevelopmentRunKey,stage:DevelopmentStage):string{
  const key=freeze(parse(RunKeySchema,copy(input),'stage call scope'));return stepIdempotencyKey({tenantId:key.tenantId,taskId:developmentStageTaskId(key,stage)},'agent.0.decision');
}

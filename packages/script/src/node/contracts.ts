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
export interface DevelopmentRun extends DevelopmentRunKey {
  readonly brief:DevelopmentBrief;readonly methods:{readonly foundation:MethodPin;readonly episodes:MethodPin};readonly execution:DevelopmentExecution;readonly digest:string;readonly createdAt:string;
}
export interface DevelopmentStageProgress<S extends DevelopmentStage> {readonly candidate:DevelopmentCandidate<S>|null;readonly review:ReviewedDevelopment<S>|RejectedDevelopment|null}
export interface DevelopmentProgress {readonly run:DevelopmentRun;readonly foundation:DevelopmentStageProgress<'foundation'>;readonly episodes:DevelopmentStageProgress<'episodes'>}
/** Internal service API. Host authentication supplies scope and author; no migration or role escalation occurs at runtime. */
export interface DevelopmentStore {
  putBrief(input:unknown):Promise<StoredDevelopmentBrief>;
  getBrief(input:z.infer<typeof ReadBriefSchema>):Promise<StoredDevelopmentBrief>;
  start(input:unknown):Promise<DevelopmentRun>;
  read(key:DevelopmentRunKey):Promise<DevelopmentProgress>;
  isCurrent(key:DevelopmentRunKey):Promise<boolean>;
  saveCandidate(key:DevelopmentRunKey,candidate:DevelopmentCandidate):Promise<DevelopmentCandidate>;
  review(key:DevelopmentRunKey,stage:DevelopmentStage,decision:unknown,host:DevelopmentReviewHost):Promise<ReviewedDevelopment>;
  reject(key:DevelopmentRunKey,stage:DevelopmentStage,reason:unknown,host:DevelopmentReviewHost):Promise<RejectedDevelopment>;
}
export function executionForDevelopment(input:unknown):DevelopmentExecution{
  const execution=parse(ExecutionSchema,copy(input),'stage execution');const {reservation,limits}=execution;
  if(execution.evidence==='live_model'&&(!execution.pricing||execution.pricing.inputMicrosPerMillionTokens>0||execution.pricing.outputMicrosPerMillionTokens>0)&&reservation.costMicros===0)throw new DevelopmentError('INVALID_INPUT','model cost reservation');
  if(2n*BigInt(reservation.tokens)>BigInt(limits.tokens)||2n*BigInt(reservation.costMicros)>BigInt(limits.costMicros))throw new DevelopmentError('INPUT_LIMIT','development budget shares');return freeze(execution);
}
export function developmentRunDigest(input:Pick<DevelopmentRun,'tenantId'|'projectId'|'runId'|'brief'|'methods'|'execution'>):string{
  const fields=parse(z.object({...RunKeySchema.shape,brief:z.unknown(),methods:MethodPinsSchema,execution:ExecutionSchema}),copy(input),'run digest input');
  return hash({version:1,...fields});
}
export function developmentMethodPins():DevelopmentRun['methods']{
  const registry=new MethodRegistry();return freeze({foundation:registry.register(createOriginalFoundationMethodPack()),episodes:registry.register(createOriginalEpisodesMethodPack())});
}
const RunEnvelope=RunKeySchema.extend({brief:z.unknown(),methods:MethodPinsSchema,execution:ExecutionSchema,digest:Hash,createdAt:z.string().max(24)});
/** Full trusted-store protocol validation, also used before a worker resolves any model session. */
export function validateDevelopmentRun(key:DevelopmentRunKey,input:unknown):DevelopmentRun{
  const scope=freeze(parse(RunKeySchema,copy(key),'run scope'));const raw=parse(RunEnvelope,copy(input),'run snapshot');const brief=validateBrief(raw.brief);const execution=executionForDevelopment(raw.execution);
  if(raw.tenantId!==scope.tenantId||raw.projectId!==scope.projectId||raw.runId!==scope.runId||brief.tenantId!==scope.tenantId||brief.projectId!==scope.projectId||!canonicalTime(raw.createdAt)
    ||hash(raw.methods)!==hash(developmentMethodPins())||raw.digest!==developmentRunDigest({...raw,brief,execution}))throw new DevelopmentError('CONFLICT','run snapshot binding');
  return freeze({...raw,brief,execution});
}
export const DEVELOPMENT_STAGE_WORKFLOW='original.development-stage';
export const DEVELOPMENT_STAGE_WORKFLOW_VERSION=1;
export function developmentStageTaskId(input:DevelopmentRunKey,stage:DevelopmentStage):string{
  return 'original-'+hash({key:parse(RunKeySchema,copy(input),'stage task scope'),stage:parse(Stage,stage,'stage task phase')});
}
export function developmentStageCallId(input:DevelopmentRunKey,stage:DevelopmentStage):string{
  const key=freeze(parse(RunKeySchema,copy(input),'stage call scope'));return stepIdempotencyKey({tenantId:key.tenantId,taskId:developmentStageTaskId(key,stage)},'agent.0.decision');
}

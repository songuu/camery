import {z} from 'zod';
import {Pin,MethodRegistry} from '@camery/methods';
import {stepIdempotencyKey} from '@camery/durable';
import {EpisodeExecutionSchema,executionForEpisodes} from '@camery/script/node';
import {capture,freeze} from '../boundary.js';
import {ComplianceError,Id,Hash,Integer,PolicySchema,LiteralReportSchema,Text} from '../contracts.js';
import {DevelopmentError} from '@camery/script/contracts';
import {validatePolicy,checkLiteralRules} from '../rules.js';
import {createClassificationBatches} from '../classification.js';
import {PrecheckSourceSchema,ScreenplaySelectionSchema,validatePrecheckSource} from './source.js';
import {ScopeSchema,validateClassifiedBatch,validateClassifiedPrepared} from './generation.js';
import type {ClassifiedBatch,prepareClassificationAt} from './generation.js';
import {createComplianceMethodPack} from './method-assets.js';
import {hash,equal} from './data.js';
export const RUN_BYTES=41943040,MAX_BATCHES=8192;
export const ScanKeySchema=ScopeSchema.extend({runId:Id});
export type ScanKey=z.infer<typeof ScanKeySchema>;
export const ManifestEntrySchema=z.strictObject({index:Integer.max(MAX_BATCHES-1),batchDigest:Hash,segmentIds:z.array(Id).min(1).max(32)});
export const ManifestSchema=z.array(ManifestEntrySchema).min(1).max(MAX_BATCHES);
export const StartScanSchema=z.strictObject({key:ScanKeySchema,source:ScreenplaySelectionSchema,policy:PolicySchema,execution:EpisodeExecutionSchema});
export const ScanRunSchema=ScanKeySchema.extend({version:z.literal(1),source:PrecheckSourceSchema,policy:PolicySchema,literal:LiteralReportSchema,manifest:ManifestSchema,method:Pin,execution:EpisodeExecutionSchema,authorId:Id,createdAt:z.iso.datetime({precision:3}),requestDigest:Hash,digest:Hash});
export type ScanRun=z.infer<typeof ScanRunSchema>;
const Counts=z.strictObject({segments:Integer,pairs:Integer,flagged:Integer,uncertain:Integer,notFlagged:Integer,literalFindings:Integer});
export const CompletionSchema=z.strictObject({version:z.literal(1),kind:z.literal('complete_advisory_precheck'),key:ScanKeySchema,runDigest:Hash,batchDigests:z.array(Hash).min(1).max(MAX_BATCHES),counts:Counts,requiresHumanReview:z.literal(true),authority:z.literal('unverified_configuration'),actorId:Id,at:z.iso.datetime({precision:3}),digest:Hash});
export type Completion=z.infer<typeof CompletionSchema>;
export const ReviewTargetSchema=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('literal')}),z.strictObject({kind:z.literal('model'),index:Integer.max(MAX_BATCHES-1)})]);
export const ReviewDecisionSchema=z.strictObject({target:ReviewTargetSchema,resultDigest:Hash,dispositions:z.array(z.strictObject({findingId:Text(512),decision:z.enum(['confirm','dismiss','needs_expert']),reason:Text(1000)})).max(65536)});
export const ReviewSchema=ReviewDecisionSchema.extend({version:z.literal(1),kind:z.literal('advisory_human_review'),key:ScanKeySchema,runDigest:Hash,actorId:Id,at:z.iso.datetime({precision:3}),digest:Hash});
export type PrecheckReview=z.infer<typeof ReviewSchema>;
export function scanCommand(run:Omit<ScanRun,'requestDigest'|'digest'>){return {key:{tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},source:run.source.selection,policy:run.policy,execution:run.execution,authorId:run.authorId};}
export function scanExecution(input:unknown,count:number){let execution;try{execution=executionForEpisodes(input);}catch(error){let limit=false;try{limit=error instanceof DevelopmentError&&error.code==='INPUT_LIMIT';}catch{/* Opaque execution configuration cannot supply diagnostics. */}throw new ComplianceError(limit?'INPUT_LIMIT':'INVALID_INPUT','scan execution','execution');}if(count<1||count>MAX_BATCHES||execution.limits.steps<count||BigInt(count)*BigInt(execution.reservation.tokens)>BigInt(execution.limits.tokens)||BigInt(count)*BigInt(execution.reservation.costMicros)>BigInt(execution.limits.costMicros))throw new ComplianceError('INPUT_LIMIT','complete scan reservations','execution');return execution;}
export function scanManifest(policy:unknown,corpus:unknown){return freeze(createClassificationBatches(policy,corpus).map(batch=>({index:batch.index,batchDigest:hash(batch),segmentIds:batch.segments.map(row=>row.id)})));}
export function validateScanRun(keyInput:unknown,input:unknown):ScanRun{
  const key=capture(ScanKeySchema,keyInput,'scan key',2048),raw=capture(ScanRunSchema,input,'scan run',RUN_BYTES),source=validatePrecheckSource(raw.source),policy=validatePolicy(raw.policy),manifest=scanManifest(policy,source.corpus),execution=scanExecution(raw.execution,manifest.length),method=new MethodRegistry().register(createComplianceMethodPack()),{digest,...body}=raw;
  if(raw.tenantId!==key.tenantId||raw.projectId!==key.projectId||raw.runId!==key.runId||source.selection.key.tenantId!==key.tenantId||source.selection.key.projectId!==key.projectId||new Date(raw.createdAt).toISOString()!==raw.createdAt||!equal(raw.method,method)||!equal(raw.execution,execution)||!equal(raw.manifest,manifest)||!equal(raw.literal,checkLiteralRules(policy,source.corpus))||hash(body,RUN_BYTES)!==digest||hash(scanCommand(raw))!==raw.requestDigest)throw new ComplianceError('CONFLICT','scan run binding','run');return freeze(raw);
}
export const CLASSIFICATION_WORKFLOW='compliance.classify-batch',CLASSIFICATION_WORKFLOW_VERSION=1;
export const BatchTaskReferenceSchema=z.strictObject({projectId:Id,runId:Id,runDigest:Hash,index:Integer.max(MAX_BATCHES-1)});
export function batchTaskId(keyInput:unknown,indexInput:unknown){const key=capture(ScanKeySchema,keyInput,'batch task key',2048),index=capture(Integer.max(MAX_BATCHES-1),indexInput,'batch task index',32);return 'precheck-'+hash({key,index});}
export function batchCallId(keyInput:unknown,index:unknown){const key=capture(ScanKeySchema,keyInput,'batch call key',2048);return stepIdempotencyKey({tenantId:key.tenantId,taskId:batchTaskId(key,index)},'agent.0.decision');}
export function batchReference(run:ScanRun,index:number){if(!run.manifest[index])throw new ComplianceError('INVALID_REFERENCE','scan batch reference','index');return freeze({projectId:run.projectId,runId:run.runId,runDigest:run.digest,index});}
function bindRunBatch(run:ScanRun,index:number,result:ClassifiedBatch){const entry=run.manifest[index];if(!entry)throw new ComplianceError('INVALID_REFERENCE','scan result batch','index');const m=result.model,e=run.execution;if(result.sourceDigest!==run.source.digest||result.policyDigest!==hash(run.policy)||result.batchIndex!==index||result.batchDigest!==entry.batchDigest||m.callId!==batchCallId({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},index)||m.connectionId!==e.connectionId||m.modeDigest!==e.modeDigest||m.modelIdentity!==e.modelIdentity||m.evidence!==e.evidence)throw new ComplianceError('CONFLICT','scan model profile','model');return result;}
export function validateRunBatch(run:ScanRun,index:number,input:unknown){return bindRunBatch(run,index,validateClassifiedBatch({tenantId:run.tenantId,projectId:run.projectId},run.source,run.policy,index,input));}
export function validateRunBatchPrepared(run:ScanRun,index:number,prepared:ReturnType<typeof prepareClassificationAt>,input:unknown){return bindRunBatch(run,index,validateClassifiedPrepared(prepared,input));}
/** Capture components independently: a legal run/result/review aggregate must not inherit the smaller run JSON cap. */
export function captureScanBatchProgress(key:ScanKey,index:number,input:unknown):{run:ScanRun;result:ClassifiedBatch|null}{
  try{if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error();const fields=Object.getOwnPropertyDescriptors(input),r=fields['run'],b=fields['result'];if(!r||!b||!('value'in r)||!('value'in b))throw new Error();const run=validateScanRun(key,r.value);if(!run.manifest[index])throw new ComplianceError('INVALID_REFERENCE','workflow scan index','index');return {run,result:b.value===null?null:validateRunBatch(run,index,b.value)};}
  catch(error){let known=false;try{known=error instanceof ComplianceError;}catch{/* Opaque store views cannot provide public diagnostics. */}if(known)throw error;throw new ComplianceError('STORAGE_FAILED','scan progress protocol','progress');}
}

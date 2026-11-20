import {z} from 'zod';
import {MethodError,Pin,ModelReceiptSchema,captureContext,digest} from '@camery/methods';
import type {MethodPin,MethodRunner} from '@camery/methods';
import {ModelError} from '@camery/model-modes';
import type {CallContext,Outcome,Json} from '@camery/model-modes';
import {Hash,Integer} from '../../contracts.js';
import {QualityScopeSchema,QualityPhaseSchema,QualityFindingSchema,QualityError} from '../contracts.js';
import {QualityModelOutputSchema,QUALITY_REVIEW_MAX_BATCHES,QUALITY_REVIEW_OUTPUT_BYTES} from '../model-contracts.js';
import {validateQualityModelOutput,qualityModelFindings} from '../model.js';
import {captureQuality,freezeQuality} from '../boundary.js';
import {qualityDigest,equalQualityData} from './data.js';
import {assertPreparedQualityReview} from './plan.js';
import type {PreparedQualityReview} from './plan.js';

export const QUALITY_BATCH_BYTES=4194304;
export const QualityReviewedBatchSchema=z.strictObject({version:z.literal(1),kind:z.literal('text_quality_batch'),scope:QualityScopeSchema,cycle:z.union([z.literal(1),z.literal(2)]),phase:QualityPhaseSchema,index:Integer.max(QUALITY_REVIEW_MAX_BATCHES-1),policyDigest:Hash,preparationDigest:Hash,manifestDigest:Hash,batchDigest:Hash,previousStageDigests:z.array(Hash).max(2),method:Pin,rawOutput:QualityModelOutputSchema,normalized:QualityModelOutputSchema,model:ModelReceiptSchema,findings:z.array(QualityFindingSchema).max(128),evidenceScope:z.literal('text'),mediaQualityVerified:z.literal(false),digest:Hash});
export type QualityReviewedBatch=z.infer<typeof QualityReviewedBatchSchema>;
function conflict(path:string):never{throw new QualityError('CONFLICT','quality batch binding',path);}
function build(prepared:PreparedQualityReview,rawInput:unknown,receiptInput:unknown):QualityReviewedBatch{
  assertPreparedQualityReview(prepared);const rawOutput=captureQuality(QualityModelOutputSchema,rawInput,'original quality output',QUALITY_REVIEW_OUTPUT_BYTES),model=captureQuality(ModelReceiptSchema,receiptInput,'original quality receipt',8192),{plan}=prepared,scope=plan.preparation.scope;
  if(model.tenantId!==scope.tenantId||model.inputDigest!==prepared.inputDigest||model.outputDigest!==digest(rawOutput))conflict('original model receipt');
  const normalized=validateQualityModelOutput(scope,prepared.topics,prepared.batch,plan.root,rawOutput),findings=qualityModelFindings(scope,prepared.topics,prepared.batch,plan.root,normalized),body={version:1 as const,kind:'text_quality_batch' as const,scope,cycle:prepared.cycle,phase:prepared.phase,index:prepared.index,policyDigest:plan.preparation.policyDigest,preparationDigest:plan.preparation.digest,manifestDigest:prepared.manifestDigest,batchDigest:qualityDigest(prepared.batch),previousStageDigests:prepared.input.previousStageDigests,method:prepared.method,rawOutput,normalized,model,findings,evidenceScope:'text' as const,mediaQualityVerified:false as const};
  return freezeQuality(captureQuality(QualityReviewedBatchSchema,{...body,digest:qualityDigest(body,QUALITY_BATCH_BYTES)},'reviewed quality batch',QUALITY_BATCH_BYTES));
}
/** The original provider DTO order remains receipt-bound; normalized assessments and Issues are reproducible derivatives. */
export function createQualityReviewedBatch(prepared:PreparedQualityReview,output:unknown,receipt:unknown){return build(prepared,output,receipt);}
export function validateQualityReviewedBatch(prepared:PreparedQualityReview,input:unknown){assertPreparedQualityReview(prepared);const stored=captureQuality(QualityReviewedBatchSchema,input,'stored quality batch',QUALITY_BATCH_BYTES),actual=build(prepared,stored.rawOutput,stored.model);if(!equalQualityData(stored,actual))conflict('complete reviewed result');return actual;}
const Execution=z.strictObject({status:z.literal('candidate'),method:Pin,output:z.unknown(),trace:z.array(z.strictObject({tool:z.literal('method.generate'),effect:z.enum(['paid','read']),network:z.boolean(),evidence:z.enum(['synthetic_replay','live_model']),status:z.literal('completed'),modelCall:ModelReceiptSchema})).length(1)});
interface Options{readonly prepared:PreparedQualityReview;readonly method:MethodPin;readonly runner:Pick<MethodRunner,'run'>;readonly call:CallContext}
/** Exactly one request; source grants/currentness, pinned reviewer independence and Durable reservations remain repository duties. */
export async function generateQualityReview(options:Options):Promise<QualityReviewedBatch>{
  const prepared=options.prepared;assertPreparedQualityReview(prepared);const pin=captureQuality(Pin,options.method,'quality review method',2048);let call:Readonly<CallContext>,run:MethodRunner['run'];
  try{const fields:Record<string,unknown>={};for(const field of ['tenantId','connectionId','modeDigest','idempotencyKey','signal']){const descriptor=Object.getOwnPropertyDescriptor(options.call,field);if(!descriptor||!('value'in descriptor))throw new Error();fields[field]=descriptor.value;}call=captureContext(fields as unknown as CallContext,'quality call');}catch{throw new QualityError('INVALID_INPUT','quality model call','call');}
  if(call.tenantId!==prepared.plan.preparation.scope.tenantId)throw new QualityError('FORBIDDEN','quality model scope','tenantId');if(!equalQualityData(pin,prepared.method))conflict('fixed method');if(call.signal.aborted)throw new MethodError('ABORTED','quality model preflight','not_sent');
  try{run=options.runner.run.bind(options.runner);}catch{throw new MethodError('EXECUTION_FAILED','quality runner binding','not_sent');}
  let result:unknown;try{result=await run(pin,prepared.input as unknown as Json,call);}catch(error){let known=false;try{known=error instanceof MethodError||error instanceof ModelError;}catch{/* Opaque provider failures cannot expose diagnostics or assert no charge. */}if(known)throw error;throw new MethodError('EXECUTION_FAILED','quality model call','unknown');}
  let outcome:Outcome='unknown';try{
    const execution=captureQuality(Execution,result,'quality method execution',QUALITY_BATCH_BYTES),trace=execution.trace[0]!,model=trace.modelCall;
    if(!equalQualityData(execution.method,pin)||model.tenantId!==call.tenantId||model.connectionId!==call.connectionId||model.modeDigest!==call.modeDigest||model.callId!==call.idempotencyKey||model.inputDigest!==prepared.inputDigest||model.evidence!==trace.evidence||trace.network!==(model.evidence==='live_model')||trace.effect!==(model.evidence==='live_model'?'paid':'read'))conflict('method trace');
    outcome=model.evidence==='live_model'?'completed':'not_applicable';call.signal.throwIfAborted();return build(prepared,execution.output,model);
  }catch(error){let code='INVALID_OUTPUT';try{if(error instanceof QualityError)code=error.code;}catch{/* Unknown exception prototypes are private. */}throw new MethodError(call.signal.aborted?'ABORTED':'QUALITY_'+code,'quality model result',outcome);}
}

import {z} from 'zod';
import {MethodError,MethodRegistry,Pin,ModelReceiptSchema,captureContext,digest,prepareStructuredGenerationRequest} from '@camery/methods';
import type {MethodPin,MethodRunner} from '@camery/methods';
import {ModelError} from '@camery/model-modes';
import type {CallContext,Outcome,Json} from '@camery/model-modes';
import {ComplianceError,Id,Hash,Integer,MODEL_INPUT_BYTES,MODEL_OUTPUT_BYTES,ModelOutputSchema,FindingSchema} from '../contracts.js';
import {capture,freeze} from '../boundary.js';
import {validatePolicy} from '../rules.js';
import {createClassificationBatches,validateClassification,classificationFindings} from '../classification.js';
import {createComplianceMethodPack} from './method-assets.js';
import {validatePrecheckSource} from './source.js';
import {hash,equal,canonical} from './data.js';
export const ScopeSchema=z.strictObject({tenantId:Id,projectId:Id});
export const CLASSIFIED_BATCH_BYTES=2097152;
export const ClassifiedBatchSchema=z.strictObject({version:z.literal(1),status:z.literal('advisory_classification'),scope:ScopeSchema,sourceDigest:Hash,policyDigest:Hash,batchIndex:Integer,batchDigest:Hash,method:Pin,rawOutput:ModelOutputSchema,normalized:ModelOutputSchema,model:ModelReceiptSchema,findings:z.array(FindingSchema).max(256),requiresHumanReview:z.literal(true),digest:Hash});
export type ClassifiedBatch=z.infer<typeof ClassifiedBatchSchema>;
function conflict(path:string):never{throw new ComplianceError('CONFLICT','classification binding',path);}
function preflight(error:unknown):never{let known=false,limit=false;try{known=error instanceof ComplianceError;limit=error instanceof MethodError&&error.code==='DATA_LIMIT';}catch{/* Opaque dependency failures stay private. */}if(known)throw error;throw new ComplianceError(limit?'INPUT_LIMIT':'INVALID_INPUT','classification preflight','$');}
const preparedPlans=new WeakSet<object>(),preparedRequests=new WeakSet<object>();
/** Capture once for full-run preflight; source/authorization/budget authority still belongs to the repositories. */
export function prepareClassificationPlan(scopeInput:unknown,sourceInput:unknown,policyInput:unknown){
  try{
    const scope=capture(ScopeSchema,scopeInput,'classification scope',1024),source=validatePrecheckSource(sourceInput),policy=validatePolicy(policyInput);
    if(source.selection.key.tenantId!==scope.tenantId||source.selection.key.projectId!==scope.projectId)throw new ComplianceError('FORBIDDEN','classification source scope','scope');
    const batches=createClassificationBatches(policy,source.corpus),pack=createComplianceMethodPack(),method=new MethodRegistry().register(pack),plan=freeze({scope,source,policy,batches,pack,method,policyDigest:hash(policy)});preparedPlans.add(plan);return plan;
  }catch(error){return preflight(error);}
}
export function prepareClassificationAt(plan:ReturnType<typeof prepareClassificationPlan>,indexInput:unknown){
  try{if(!preparedPlans.has(plan))throw new ComplianceError('INVALID_INPUT','captured classification plan','plan');const index=capture(Integer,indexInput,'classification batch index',32),batch=plan.batches[index];if(!batch)throw new ComplianceError('INVALID_REFERENCE','classification batch index','index');
    const {scope,source,policy,pack,method,policyDigest}=plan,batchDigest=hash(batch),input=freeze({version:1,scope,sourceDigest:source.digest,policyDigest,batchDigest,episodeId:source.corpus.episodeId,categories:policy.categories,batch}),request=prepareStructuredGenerationRequest(pack,input as unknown as Json),envelope={messages:request.messages,outputSchema:request.outputSchema};if(Buffer.byteLength(canonical(envelope))>MODEL_INPUT_BYTES)throw new ComplianceError('INPUT_LIMIT','complete classification request','request');
    // Shared captured source/catalog objects are already deep-frozen; do not walk the full corpus for every batch.
    const prepared=Object.freeze({scope,source,policy,batch,batchCount:plan.batches.length,policyDigest,batchDigest,pack,method,input,inputDigest:digest(envelope)});preparedRequests.add(prepared);return prepared;
  }catch(error){return preflight(error);}
}
/** Integrity preflight only. Stores must prove actual source, current authorization and budget separately. */
export function prepareClassification(scope:unknown,source:unknown,policy:unknown,index:unknown){return prepareClassificationAt(prepareClassificationPlan(scope,source,policy),index);}
function build(prepared:ReturnType<typeof prepareClassification>,rawInput:unknown,receiptInput:unknown):ClassifiedBatch{
  const rawOutput=capture(ModelOutputSchema,rawInput,'original classification output',MODEL_OUTPUT_BYTES),model=capture(ModelReceiptSchema,receiptInput,'original classification receipt',8192);
  if(model.tenantId!==prepared.scope.tenantId||model.inputDigest!==prepared.inputDigest||model.outputDigest!==digest(rawOutput))conflict('original model receipt');
  const normalized=validateClassification(prepared.policy,prepared.batch,rawOutput),findings=classificationFindings(prepared.policy,prepared.batch,normalized),body={version:1 as const,status:'advisory_classification' as const,scope:prepared.scope,sourceDigest:prepared.source.digest,policyDigest:prepared.policyDigest,batchIndex:prepared.batch.index,batchDigest:prepared.batchDigest,method:prepared.method,rawOutput,normalized,model,findings,requiresHumanReview:true as const};
  return freeze(capture(ClassifiedBatchSchema,{...body,digest:hash(body,CLASSIFIED_BATCH_BYTES)},'classified precheck batch',CLASSIFIED_BATCH_BYTES));
}
/** Reuses the original provider/Agent envelope; never invokes a repair model call. */
export function createClassifiedBatch(scope:unknown,source:unknown,policy:unknown,index:unknown,output:unknown,receipt:unknown){return build(prepareClassification(scope,source,policy,index),output,receipt);}
export function validateClassifiedPrepared(prepared:ReturnType<typeof prepareClassificationAt>,input:unknown){if(!preparedRequests.has(prepared))throw new ComplianceError('INVALID_INPUT','captured classification request','prepared');const stored=capture(ClassifiedBatchSchema,input,'stored classification',CLASSIFIED_BATCH_BYTES),actual=build(prepared,stored.rawOutput,stored.model);if(!equal(stored,actual))conflict('complete classified result');return actual;}
export function validateClassifiedBatch(scope:unknown,source:unknown,policy:unknown,index:unknown,input:unknown){return validateClassifiedPrepared(prepareClassification(scope,source,policy,index),input);}
const Execution=z.strictObject({status:z.literal('candidate'),method:Pin,output:z.unknown(),trace:z.array(z.strictObject({tool:z.literal('method.generate'),effect:z.enum(['paid','read']),network:z.boolean(),evidence:z.enum(['synthetic_replay','live_model']),status:z.literal('completed'),modelCall:ModelReceiptSchema})).length(1)});
interface GenerateOptions{readonly scope:unknown;readonly source:unknown;readonly policy:unknown;readonly index:unknown;readonly method:MethodPin;readonly runner:Pick<MethodRunner,'run'>;readonly call:CallContext}
/** One fixed call; actual source resolution, per-batch project reservation and Durable unknown recovery are host duties. */
export async function generateClassification(options:GenerateOptions):Promise<ClassifiedBatch>{
  const prepared=prepareClassification(options.scope,options.source,options.policy,options.index),pin=capture(Pin,options.method,'classification method',2048);let call:Readonly<CallContext>,run:MethodRunner['run'];
  try{const fields:Record<string,unknown>={};for(const field of ['tenantId','connectionId','modeDigest','idempotencyKey','signal']){const d=Object.getOwnPropertyDescriptor(options.call,field);if(!d||!('value'in d))throw new Error();fields[field]=d.value;}call=captureContext(fields as unknown as CallContext,'classification call');}catch{return preflight(new Error());}
  if(call.tenantId!==prepared.scope.tenantId)throw new ComplianceError('FORBIDDEN','classification call scope','tenantId');if(!equal(pin,prepared.method))conflict('fixed method');if(call.signal.aborted)throw new MethodError('ABORTED','classification preflight','not_sent');
  try{run=options.runner.run.bind(options.runner);}catch{throw new MethodError('EXECUTION_FAILED','classification runner binding','not_sent');}
  let result:unknown;try{result=await run(pin,prepared.input as unknown as Json,call);}catch(error){let known=false;try{known=error instanceof MethodError||error instanceof ModelError;}catch{/* Opaque provider errors cannot leak diagnostics. */}if(known)throw error;throw new MethodError('EXECUTION_FAILED','classification model call','unknown');}
  let outcome:Outcome='unknown';try{const execution=capture(Execution,result,'classification execution',CLASSIFIED_BATCH_BYTES),trace=execution.trace[0]!,model=trace.modelCall;if(!equal(execution.method,pin)||model.tenantId!==call.tenantId||model.connectionId!==call.connectionId||model.modeDigest!==call.modeDigest||model.callId!==call.idempotencyKey||model.inputDigest!==prepared.inputDigest||model.evidence!==trace.evidence||trace.network!==(model.evidence==='live_model')||trace.effect!==(model.evidence==='live_model'?'paid':'read'))conflict('execution trace');outcome=model.evidence==='live_model'?'completed':'not_applicable';call.signal.throwIfAborted();return build(prepared,execution.output,model);}
  catch(error){let code='INVALID_OUTPUT';try{if(error instanceof ComplianceError)code=error.code;}catch{/* Private exception prototypes cannot supply public error codes. */}throw new MethodError(call.signal.aborted?'ABORTED':'COMPLIANCE_'+code,'classification model result',outcome);}
}

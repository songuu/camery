import {z} from 'zod';
import {MethodError,MethodRegistry,ModelReceiptSchema,Pin,captureContext,prepareStructuredGenerationRequest,digest} from '@camery/methods';
import type {MethodPin,MethodRunner} from '@camery/methods';
import type {CallContext,Outcome,Json} from '@camery/model-modes';
import {ModelError} from '@camery/model-modes';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,ScreenplayError} from '../contracts.js';
import {validateScreenplayContext} from '../context.js';
import {createScreenplayCandidate} from './review.js';
import {continuityDigest,canonicalContinuity} from '../../continuity/node/digest.js';
import {createScreenplayMethodPack} from './method-assets.js';
import {projectScreenplayModelInput} from './model-input.js';
import {normalizeScreenplayModelOutput} from './model-output.js';
import {ScreenplayModelOutputSchema,SCREENPLAY_MODEL_INPUT_BYTES,SCREENPLAY_MODEL_OUTPUT_BYTES,SCREENPLAY_GENERATED_BYTES} from './model-contracts.js';
import {ScreenplayGeneratedCandidateSchema} from './generation-contracts.js';
import type {ScreenplayGeneratedCandidate} from './generation-contracts.js';

function refuse(path:string):never{throw new ScreenplayError('CONFLICT','screenplay generation evidence',path);}
function preflight(error:unknown):never{
  let known=false,limit=false;try{known=error instanceof ScreenplayError;limit=error instanceof MethodError&&error.code==='DATA_LIMIT';}catch{/* Opaque input exceptions cannot provide public diagnostics. */}
  if(known)throw error;throw new ScreenplayError(limit?'INPUT_LIMIT':'INVALID_INPUT','screenplay model preflight','$');
}
/** Integrity only. The actual source store must resolve adoption, human audit and present-day freshness. */
export function prepareScreenplayGeneration(scopeInput:unknown,contextInput:unknown,notes:unknown){
  try{
    const context=validateScreenplayContext(contextInput),input=projectScreenplayModelInput(scopeInput,context,notes),pack=createScreenplayMethodPack(),method=new MethodRegistry().register(pack);
    const request=prepareStructuredGenerationRequest(pack,input as unknown as Json);
    const envelope={messages:request.messages,outputSchema:request.outputSchema};
    if(Buffer.byteLength(canonicalContinuity(envelope,SCREENPLAY_CONTEXT_BYTES))>SCREENPLAY_MODEL_INPUT_BYTES)throw new ScreenplayError('INPUT_LIMIT','complete screenplay model request','request');
    return freezeScreenplay({scope:input.scope,context,input,pack,method,inputDigest:digest(envelope)});
  }catch(error){return preflight(error);}
}
function build(prepared:ReturnType<typeof prepareScreenplayGeneration>,outputInput:unknown,receiptInput:unknown):ScreenplayGeneratedCandidate{
  const output=captureScreenplay(ScreenplayModelOutputSchema,outputInput,'screenplay model output',SCREENPLAY_MODEL_OUTPUT_BYTES),model=captureScreenplay(ModelReceiptSchema,receiptInput,'screenplay model receipt',8192);
  if(model.tenantId!==prepared.scope.tenantId||model.inputDigest!==prepared.inputDigest||model.outputDigest!==digest(output))refuse('model receipt');
  const candidate=createScreenplayCandidate(prepared.scope,prepared.context,normalizeScreenplayModelOutput(output)),body={version:1 as const,status:'candidate' as const,scope:prepared.scope,contextDigest:candidate.contextDigest,method:prepared.method,output,model,candidate};
  return freezeScreenplay(captureScreenplay(ScreenplayGeneratedCandidateSchema,{...body,digest:continuityDigest(body,SCREENPLAY_GENERATED_BYTES)},'generated screenplay candidate',SCREENPLAY_GENERATED_BYTES));
}
/** Uses the original Method/Agent output receipt; this never issues a second model call. */
export function createScreenplayGeneratedCandidate(scope:unknown,context:unknown,notes:unknown,output:unknown,receipt:unknown):ScreenplayGeneratedCandidate{return build(prepareScreenplayGeneration(scope,context,notes),output,receipt);}
export function validateScreenplayGeneratedCandidate(scope:unknown,context:unknown,notes:unknown,input:unknown):ScreenplayGeneratedCandidate{
  const prepared=prepareScreenplayGeneration(scope,context,notes),raw=captureScreenplay(ScreenplayGeneratedCandidateSchema,input,'stored generated screenplay',SCREENPLAY_GENERATED_BYTES),actual=build(prepared,raw.output,raw.model);
  if(canonicalContinuity(raw,SCREENPLAY_GENERATED_BYTES)!==canonicalContinuity(actual,SCREENPLAY_GENERATED_BYTES))refuse('complete generated candidate');return actual;
}
const Execution=z.strictObject({status:z.literal('candidate'),method:Pin,output:z.unknown(),trace:z.array(z.strictObject({tool:z.literal('method.generate'),effect:z.enum(['read','paid']),network:z.boolean(),evidence:z.enum(['synthetic_replay','live_model']),status:z.literal('completed'),modelCall:ModelReceiptSchema})).length(1)});
interface GenerateOptions{readonly scope:unknown;readonly context:unknown;readonly notes:unknown;readonly method:MethodPin;readonly runner:Pick<MethodRunner,'run'>;readonly call:CallContext}
/** Single pinned call. Durable leases, actual project budgets and unknown-outcome reconciliation are host responsibilities. */
export async function generateScreenplay(options:GenerateOptions):Promise<ScreenplayGeneratedCandidate>{
  const prepared=prepareScreenplayGeneration(options.scope,options.context,options.notes),method=captureScreenplay(Pin,options.method,'screenplay method pin',2048);let call:Readonly<CallContext>;
  try{const fields:Record<string,unknown>={};for(const name of ['tenantId','connectionId','modeDigest','idempotencyKey','signal']){const descriptor=Object.getOwnPropertyDescriptor(options.call,name);if(!descriptor||!('value'in descriptor))throw new Error();fields[name]=descriptor.value;}call=captureContext(fields as unknown as CallContext,'screenplay generation');}catch{return preflight(new Error());}
  if(call.tenantId!==prepared.scope.tenantId)throw new ScreenplayError('FORBIDDEN','screenplay model tenant','call.tenantId');
  if(digest(method)!==digest(prepared.method))refuse('fixed method pin');if(call.signal.aborted)throw new MethodError('ABORTED','screenplay model preflight','not_sent');
  let run:MethodRunner['run'];try{run=options.runner.run.bind(options.runner);}catch{throw new MethodError('EXECUTION_FAILED','screenplay runner binding','not_sent');}
  let result:unknown;try{result=await run(method,prepared.input as unknown as Json,call);}catch(error){let known=false;try{known=error instanceof MethodError||error instanceof ModelError;}catch{/* Opaque provider errors cannot provide public diagnostics. */}if(known)throw error;throw new MethodError('EXECUTION_FAILED','screenplay model call','unknown');}let outcome:Outcome='unknown';
  try{
    const execution=captureScreenplay(Execution,result,'screenplay model execution',SCREENPLAY_GENERATED_BYTES),trace=execution.trace[0]!,model=trace.modelCall;
    if(digest(execution.method)!==digest(method)||model.tenantId!==call.tenantId||model.connectionId!==call.connectionId||model.modeDigest!==call.modeDigest||model.callId!==call.idempotencyKey||model.inputDigest!==prepared.inputDigest||model.evidence!==trace.evidence||trace.network!==(model.evidence==='live_model')||trace.effect!==(model.evidence==='live_model'?'paid':'read'))refuse('execution trace');
    outcome=model.evidence==='live_model'?'completed':'not_applicable';call.signal.throwIfAborted();return build(prepared,execution.output,model);
  }catch(error){let code='INVALID_OUTPUT';try{if(error instanceof ScreenplayError)code=error.code;}catch{/* Unknown dependency errors never provide error codes. */}throw new MethodError(call.signal.aborted?'ABORTED':'SCREENPLAY_'+code,'screenplay model result',outcome);}
}

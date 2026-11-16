import { z } from 'zod';
import { MethodError,MethodRegistry,ModelReceiptSchema,Pin,prepareStructuredGenerationRequest,captureContext } from '@camery/methods';
import type { MethodPin,MethodRunner } from '@camery/methods';
import type { CallContext,Json,Outcome } from '@camery/model-modes';
import { DevelopmentBriefSchema,DevelopmentError,Hash,Stage,ENVELOPE_BYTES } from './contracts.js';
import type { DevelopmentBrief,DevelopmentCandidate,DevelopmentStage,ReviewedDevelopment,OutputByStage } from './contracts.js';
import { validateBrief } from './brief.js';
import { validateFoundation } from './foundation.js';
import { validateEpisodes } from './episodes.js';
import { validateReviewedFoundation } from './reviewed.js';
import { createOriginalFoundationMethodPack,createOriginalEpisodesMethodPack } from './method-assets.js';
import { copy,freeze,hash,parse } from './data.js';

const Record=z.strictObject({version:z.literal(1),status:z.literal('candidate'),stage:Stage,brief:DevelopmentBriefSchema,upstreamDigest:Hash.nullable(),method:Pin,output:z.unknown(),model:ModelReceiptSchema,digest:Hash});
const Execution=z.strictObject({status:z.literal('candidate'),method:Pin,output:z.unknown(),trace:z.array(z.strictObject({tool:z.literal('method.generate'),effect:z.enum(['read','paid']),network:z.boolean(),evidence:z.enum(['synthetic_replay','live_model']),status:z.literal('completed'),modelCall:ModelReceiptSchema})).length(1)});

export function prepareDevelopmentStage(current:DevelopmentBrief,stage:DevelopmentStage,supplied?:ReviewedDevelopment<'foundation'>){
  const brief=validateBrief(current);let upstream:ReviewedDevelopment<'foundation'>|null=null;
  if(stage!=='foundation'&&stage!=='episodes')throw new DevelopmentError('INVALID_INPUT','development stage');
  if(stage==='episodes'){if(!supplied)throw new DevelopmentError('INCOMPLETE','foundation review required');upstream=validateReviewedFoundation(brief,supplied);}
  else if(supplied!==undefined)throw new DevelopmentError('INVALID_INPUT','foundation has no upstream');
  const pack=stage==='foundation'?createOriginalFoundationMethodPack():createOriginalEpisodesMethodPack();const method=new MethodRegistry().register(pack);
  const input=JSON.parse(JSON.stringify(upstream?{brief,foundation:upstream.output,upstreamDigest:upstream.digest}:{brief})) as Json;
  const request=prepareStructuredGenerationRequest(pack,input);const inputDigest=hash({messages:request.messages,outputSchema:request.outputSchema});
  return freeze({brief,stage,upstream,method,pack,input,inputDigest});
}

function build<S extends DevelopmentStage>(prepared:ReturnType<typeof prepareDevelopmentStage>,stage:S,outputInput:unknown,receiptInput:unknown):DevelopmentCandidate<S>{
  const output=(stage==='foundation'?validateFoundation(outputInput):validateEpisodes(prepared.brief,prepared.upstream!.output,outputInput)) as OutputByStage[S];
  const model=parse(ModelReceiptSchema,copy(receiptInput),'model receipt');
  if(model.tenantId!==prepared.brief.tenantId||model.inputDigest!==prepared.inputDigest||model.outputDigest!==hash(output))throw new DevelopmentError('INVALID_EVIDENCE','model receipt binding');
  const body={version:1 as const,status:'candidate' as const,stage,brief:prepared.brief,upstreamDigest:prepared.upstream?.digest??null,method:prepared.method,output,model};
  copy(body,ENVELOPE_BYTES);return freeze({...body,digest:hash(body)});
}
function restore<S extends DevelopmentStage>(brief:DevelopmentBrief,stage:S,input:unknown,upstream?:ReviewedDevelopment<'foundation'>):DevelopmentCandidate<S>{
  const prepared=prepareDevelopmentStage(brief,stage,upstream);const raw=parse(Record,copy(input),'development candidate');
  if(raw.stage!==stage||validateBrief(raw.brief).digest!==prepared.brief.digest||raw.upstreamDigest!==(prepared.upstream?.digest??null)||hash(raw.method)!==hash(prepared.method))throw new DevelopmentError('CONFLICT','candidate binding');
  const actual=build(prepared,stage,raw.output,raw.model);if(actual.digest!==raw.digest)throw new DevelopmentError('CONFLICT','candidate digest');return actual;
}
export const validateFoundationCandidate=(brief:DevelopmentBrief,input:unknown):DevelopmentCandidate<'foundation'>=>restore(brief,'foundation',input);
export const validateEpisodeCandidate=(brief:DevelopmentBrief,foundation:ReviewedDevelopment<'foundation'>,input:unknown):DevelopmentCandidate<'episodes'>=>restore(brief,'episodes',input,foundation);
/** The Agent path supplies its original finish-output receipt; this constructor verifies evidence without another model call. */
export function createFoundationCandidate(brief:DevelopmentBrief,output:unknown,receipt:unknown):DevelopmentCandidate<'foundation'>{return build(prepareDevelopmentStage(brief,'foundation'),'foundation',output,receipt);}
export function createEpisodeCandidate(brief:DevelopmentBrief,foundation:ReviewedDevelopment<'foundation'>,output:unknown,receipt:unknown):DevelopmentCandidate<'episodes'>{return build(prepareDevelopmentStage(brief,'episodes',foundation),'episodes',output,receipt);}
interface GenerateOptions {readonly brief:DevelopmentBrief;readonly runner:Pick<MethodRunner,'run'>;readonly method:MethodPin;readonly context:CallContext}
async function generate<S extends DevelopmentStage>(stage:S,options:GenerateOptions,upstream?:ReviewedDevelopment<'foundation'>):Promise<DevelopmentCandidate<S>>{
  const prepared=prepareDevelopmentStage(options.brief,stage,upstream);const method=parse(Pin,copy(options.method),'method pin');
  const context=captureContext(options.context,'original development context');const run=options.runner.run.bind(options.runner);
  if(context.tenantId!==prepared.brief.tenantId)throw new DevelopmentError('FORBIDDEN','model tenant');
  if(hash(method)!==hash(prepared.method))throw new DevelopmentError('CONFLICT','fixed method pin');
  if(context.signal.aborted)throw new MethodError('ABORTED','original development preflight','not_sent');
  const result=await run(method,prepared.input,context);let outcome:Outcome='unknown';
  try{
    const execution=parse(Execution,copy(result),'method execution');const trace=execution.trace[0]!;const model=trace.modelCall;
    if(hash(execution.method)!==hash(method)||model.tenantId!==context.tenantId||model.connectionId!==context.connectionId||model.modeDigest!==context.modeDigest||model.callId!==context.idempotencyKey||model.inputDigest!==prepared.inputDigest
      ||model.evidence!==trace.evidence||trace.network!==(model.evidence==='live_model')||trace.effect!==(model.evidence==='live_model'?'paid':'read'))throw new DevelopmentError('INVALID_EVIDENCE','method execution binding');
    outcome=model.evidence==='live_model'?'completed':'not_applicable';
    context.signal.throwIfAborted();return build(prepared,stage,execution.output,model);
  }catch(error){throw new MethodError(context.signal.aborted?'ABORTED':error instanceof DevelopmentError?'DEVELOPMENT_'+error.code:'DEVELOPMENT_INVALID_OUTPUT','original development result',outcome);}
}
/** One journaled/budgeted stage per call; a plain caller loop is not persistent production execution. */
export function generateFoundation(options:GenerateOptions):Promise<DevelopmentCandidate<'foundation'>>{return generate('foundation',options);}
export function generateEpisodes(options:GenerateOptions&{readonly foundation:ReviewedDevelopment<'foundation'>}):Promise<DevelopmentCandidate<'episodes'>>{return generate('episodes',options,options.foundation);}

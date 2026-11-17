import { z } from 'zod';
import { MethodError,MethodRegistry,ModelReceiptSchema,Pin,captureContext,prepareStructuredGenerationRequest } from '@camery/methods';
import type { MethodPin,MethodRunner } from '@camery/methods';
import type { CallContext,Json,Outcome } from '@camery/model-modes';
import { Hash } from '../../contracts.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OUTLINE_ENVELOPE_BYTES,OutlineBriefSchema } from '../generation-contracts.js';
import type { OutlineBrief,OutlineCandidate,OutlineSourceSnapshot } from '../generation-contracts.js';
import { captureOutlineContext,validateOutline } from '../outline.js';
import { getGenreProfile } from '../profiles.js';
import { validateOutlineBrief } from './brief.js';
import { copy,hash } from './data.js';
import { createOutlineMethodPack } from './method-assets.js';
import { validateOutlineSourceSnapshot } from './source.js';

const Candidate=z.strictObject({version:z.literal(1),status:z.literal('candidate'),brief:OutlineBriefSchema,source:z.unknown(),method:Pin,output:z.unknown(),model:ModelReceiptSchema,digest:Hash});
const Execution=z.strictObject({status:z.literal('candidate'),method:Pin,output:z.unknown(),trace:z.array(z.strictObject({tool:z.literal('method.generate'),effect:z.enum(['read','paid']),network:z.boolean(),evidence:z.enum(['synthetic_replay','live_model']),status:z.literal('completed'),modelCall:ModelReceiptSchema})).length(1)});

/** Integrity checks are not authorization: the host must resolve current stored source audits before this call. */
export function prepareOutline(briefInput:unknown,sourceInput:unknown){
  const brief=validateOutlineBrief(briefInput);const source=validateOutlineSourceSnapshot(sourceInput);
  if(source.descriptor.tenantId!==brief.tenantId||source.descriptor.projectId!==brief.projectId)throw new OutlineError('FORBIDDEN','source scope','source.descriptor');
  const context=outlineContext(brief,source);const profiles=brief.profiles.map(pin=>getGenreProfile(pin.id));
  const pack=createOutlineMethodPack();const method=new MethodRegistry().register(pack);
  const input=copy({brief,source,profiles}) as unknown as Json;
  const request=prepareStructuredGenerationRequest(pack,input);const inputDigest=hash({messages:request.messages,outputSchema:request.outputSchema});
  return deepFreeze({brief,source,context,profiles,method,pack,input,inputDigest});
}
export function outlineContext(brief:OutlineBrief,source:OutlineSourceSnapshot){
  return captureOutlineContext({episodeCount:brief.episodeCount,targetSeconds:brief.targetSeconds,paidEpisodeNumbers:brief.paidEpisodeNumbers,
    mainGenre:brief.mainGenre,auxiliaryGenres:brief.auxiliaryGenres,sourceRefIds:source.references.map(reference=>reference.id)});
}
function build(prepared:ReturnType<typeof prepareOutline>,outputInput:unknown,receipt:unknown):OutlineCandidate{
  const output=validateOutline(prepared.context,outputInput);const model=capture(ModelReceiptSchema,receipt,'model receipt');
  if(model.tenantId!==prepared.brief.tenantId||model.inputDigest!==prepared.inputDigest||model.outputDigest!==hash(output))throw new OutlineError('INVALID_EVIDENCE','model receipt binding','model');
  const body={version:1 as const,status:'candidate' as const,brief:prepared.brief,source:prepared.source,method:prepared.method,output,model};
  copy(body);return deepFreeze({...body,digest:hash(body)});
}
/** Accepts the original Agent finish-output receipt without performing another paid call. */
export function createOutlineCandidate(brief:unknown,source:unknown,output:unknown,receipt:unknown):OutlineCandidate{
  return build(prepareOutline(brief,source),output,receipt);
}
export function validateOutlineCandidate(brief:unknown,source:unknown,input:unknown):OutlineCandidate{
  const prepared=prepareOutline(brief,source);const raw=capture(Candidate,input,'candidate',OUTLINE_ENVELOPE_BYTES);
  if(validateOutlineBrief(raw.brief).digest!==prepared.brief.digest||validateOutlineSourceSnapshot(raw.source).digest!==prepared.source.digest||hash(raw.method)!==hash(prepared.method))throw new OutlineError('CONFLICT','candidate binding','candidate');
  const actual=build(prepared,raw.output,raw.model);if(actual.digest!==raw.digest)throw new OutlineError('CONFLICT','candidate digest','candidate.digest');return actual;
}
interface GenerateOutlineOptions {readonly brief:OutlineBrief;readonly source:OutlineSourceSnapshot;readonly method:MethodPin;readonly runner:Pick<MethodRunner,'run'>;readonly context:CallContext}
/** A single method call; persistent leases, source locks and budget belong to the durable host, not a caller retry loop. */
export async function generateOutline(options:GenerateOutlineOptions):Promise<OutlineCandidate>{
  const prepared=prepareOutline(options.brief,options.source);const method=capture(Pin,options.method,'method pin');
  const context=captureContext(options.context,'outline context');const run=options.runner.run.bind(options.runner);
  if(context.tenantId!==prepared.brief.tenantId)throw new OutlineError('FORBIDDEN','model tenant','context.tenantId');
  if(hash(method)!==hash(prepared.method))throw new OutlineError('CONFLICT','fixed method pin','method');
  if(context.signal.aborted)throw new MethodError('ABORTED','outline preflight','not_sent');
  const result=await run(method,prepared.input,context);let outcome:Outcome='unknown';
  try{
    const execution=capture(Execution,result,'execution',OUTLINE_ENVELOPE_BYTES);const trace=execution.trace[0]!;const model=trace.modelCall;
    if(hash(execution.method)!==hash(method)||model.tenantId!==context.tenantId||model.connectionId!==context.connectionId||model.modeDigest!==context.modeDigest||model.callId!==context.idempotencyKey||model.inputDigest!==prepared.inputDigest
      ||model.evidence!==trace.evidence||trace.network!==(model.evidence==='live_model')||trace.effect!==(model.evidence==='live_model'?'paid':'read'))throw new OutlineError('INVALID_EVIDENCE','execution binding','trace');
    outcome=model.evidence==='live_model'?'completed':'not_applicable';context.signal.throwIfAborted();return build(prepared,execution.output,model);
  }catch(error){throw new MethodError(context.signal.aborted?'ABORTED':error instanceof OutlineError?'OUTLINE_'+error.code:'OUTLINE_INVALID_OUTPUT','outline result',outcome);}
}

import {stepIdempotencyKey} from '@camery/durable';
import {DevelopmentError} from '../../contracts.js';
import {executionForEpisodes} from '../../node/contracts.js';
import {canonicalTime} from '../../reviewed.js';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CONTEXT_BYTES,ScreenplayError} from '../contracts.js';
import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import {prepareScreenplayGeneration,validateScreenplayGeneratedCandidate} from './generation.js';
import {ScreenplayGenerationKeySchema,ScreenplayGenerationRunSchema,ScreenplayGenerationProgressSchema} from './generation-contracts.js';
import type {ScreenplayGenerationKey,ScreenplayGenerationRun,ScreenplayGenerationProgress} from './generation-contracts.js';
import {SCREENPLAY_GENERATED_BYTES} from './model-contracts.js';

export const generationDigest=(input:unknown)=>continuityDigest(input,SCREENPLAY_CONTEXT_BYTES);
export const generationEqual=(left:unknown,right:unknown)=>canonicalContinuity(left,SCREENPLAY_CONTEXT_BYTES)===canonicalContinuity(right,SCREENPLAY_CONTEXT_BYTES);
function conflict(path:string):never{throw new ScreenplayError('CONFLICT','screenplay generation binding',path);}
export function screenplayExecution(input:unknown){
  try{return executionForEpisodes(input);}catch(error){let limit=false;try{limit=error instanceof DevelopmentError&&error.code==='INPUT_LIMIT';}catch{/* Opaque input diagnostics stay private. */}throw new ScreenplayError(limit?'INPUT_LIMIT':'INVALID_INPUT','screenplay execution','execution');}
}
export function screenplayGenerationTaskId(input:unknown):string{return 'screenplay-'+generationDigest(captureScreenplay(ScreenplayGenerationKeySchema,input,'screenplay task key',2048));}
export function screenplayGenerationCallId(input:unknown):string{const key=captureScreenplay(ScreenplayGenerationKeySchema,input,'screenplay call key',2048);return stepIdempotencyKey({tenantId:key.tenantId,taskId:screenplayGenerationTaskId(key)},'agent.0.decision');}
export function screenplayGenerationReference(run:ScreenplayGenerationRun){return freezeScreenplay({projectId:run.projectId,runId:run.runId,runDigest:run.digest});}
export function screenplayGenerationCommand(run:Omit<ScreenplayGenerationRun,'digest'|'requestDigest'>){return {key:{tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},candidateId:run.candidateId,target:run.source.native.target,episodeId:run.context.episode.id,expectedSnapshotRevision:run.source.native.snapshotRevision,expectedPackageDigest:run.source.native.packageDigest,rules:run.context.rules,notes:run.notes,execution:run.execution,authorId:run.authorId};}
/** Integrity only; the PostgreSQL repository resolves actual historical source rows separately. */
export function validateScreenplayGenerationRun(inputKey:unknown,input:unknown):ScreenplayGenerationRun{
  const key=captureScreenplay(ScreenplayGenerationKeySchema,inputKey,'generation key',2048),run=captureScreenplay(ScreenplayGenerationRunSchema,input,'generation run',SCREENPLAY_CONTEXT_BYTES),scope={tenantId:key.tenantId,projectId:key.projectId};
  const prepared=prepareScreenplayGeneration(scope,run.context,run.notes),execution=screenplayExecution(run.execution),{digest,...body}=run,native=run.source.native,c=run.context,p=run.previous;
  if(run.tenantId!==key.tenantId||run.projectId!==key.projectId||run.runId!==key.runId||!canonicalTime(run.createdAt)||!generationEqual(run.method,prepared.method)||!generationEqual(run.execution,execution)||generationDigest(body)!==digest||generationDigest(screenplayGenerationCommand(run))!==run.requestDigest)conflict('run');
  if(native.target.projectId!==c.projectId||native.packageId!==c.packageId||native.snapshotRevision!==c.snapshotRevision||native.episodeId!==c.episode.id||native.contextDigest!==generationDigest(c.nativeContext)||run.source.contextDigest!==generationDigest(c))conflict('source');
  if(p===null){if(c.previous!==null||native.previousDigest!==null||c.episode.number!==1)conflict('previous');}
  else if(!c.previous||!generationEqual(p.scope,scope)||!generationEqual(p.target,native.target)||p.digest!==native.previousDigest||p.digest!==c.previous.proofDigest||p.adoptedRevision!==c.previous.adoptedRevision||!generationEqual(p.snapshot,c.previous.snapshot)||!generationEqual(p.ledger,c.previous.ledger))conflict('previous');
  return freezeScreenplay(run);
}
export function validateScreenplayRunCandidate(run:ScreenplayGenerationRun,input:unknown){
  const candidate=validateScreenplayGeneratedCandidate({tenantId:run.tenantId,projectId:run.projectId},run.context,run.notes,input),model=candidate.model,e=run.execution;
  if(model.callId!==screenplayGenerationCallId({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId})||model.connectionId!==e.connectionId||model.modeDigest!==e.modeDigest||model.modelIdentity!==e.modelIdentity||model.evidence!==e.evidence)conflict('model profile');return candidate;
}
export function captureScreenplayGenerationProgress(key:ScreenplayGenerationKey,input:unknown):ScreenplayGenerationProgress{
  // The aggregate includes two independently bounded immutable records, plus its small delivery receipt.
  const raw=captureScreenplay(ScreenplayGenerationProgressSchema,input,'screenplay generation progress',SCREENPLAY_CONTEXT_BYTES+SCREENPLAY_GENERATED_BYTES+16384),run=validateScreenplayGenerationRun(key,raw.run),candidate=raw.candidate===null?null:validateScreenplayRunCandidate(run,raw.candidate),d=raw.delivery;
  if(d){const {digest,...body}=d;if(!candidate||!generationEqual(d.key,key)||d.runDigest!==run.digest||d.generatedDigest!==candidate.digest||!generationEqual(d.candidateKey,{tenantId:key.tenantId,projectId:key.projectId,candidateId:run.candidateId})||d.authorId!==run.authorId||!canonicalTime(d.at)||generationDigest(body)!==digest)conflict('delivery');}
  return freezeScreenplay({run,candidate,delivery:d});
}

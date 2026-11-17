import {z} from 'zod';
import {stepIdempotencyKey} from '@camery/durable';
import type {DurableStore,Task,TaskKey} from '@camery/durable';
import {DevelopmentError,Id,Hash,Stage,Text,Integer} from '../contracts.js';
import type {DevelopmentStage} from '../contracts.js';
import {DevelopmentRedoSchema,DevelopmentRedoOptionsSchema} from '../http.js';
import type {DevelopmentRedoOptions} from '../http.js';
import {copy,freeze,hash,parse} from '../data.js';
import {RunKeySchema,MethodPinsSchema,ExecutionSchema,StartForkSchema,validateDevelopmentRun,developmentCandidateOwner,developmentStageTaskId,developmentWorkflowVersion,DEVELOPMENT_STAGE_WORKFLOW,episodeExecutionFromFull,executionForDevelopment} from './contracts.js';
import type {DevelopmentExecution,DevelopmentProgress,DevelopmentRunKey,DevelopmentStore,DevelopmentRun} from './contracts.js';
import {enqueueNextDevelopmentTask} from './workflow.js';
export interface DevelopmentRedoPreset {readonly methods:DevelopmentRun['methods'];readonly execution:DevelopmentExecution;readonly label:string}
export interface DevelopmentRedoServices {readonly store:DevelopmentStore;readonly tasks:Pick<DurableStore,'get'|'steps'|'enqueue'>}
type Reason=NonNullable<DevelopmentRedoOptions['episodes']['reason']>;
const Preset=z.strictObject({methods:MethodPinsSchema,execution:ExecutionSchema,label:Text(200)});
const Request=z.strictObject({source:RunKeySchema,stage:Stage,command:DevelopmentRedoSchema,actorId:Id,preset:Preset});
const StepMetadata=z.strictObject({key:z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$(?![\s\S])/),position:Integer,kind:z.enum(['external','replayable','gate','timer']),status:z.enum(['running','waiting','completed','failed','unknown']),fingerprint:Hash,idempotencyKey:z.string().min(1).max(256)});
function captured(options:DevelopmentRedoServices){
  return {store:options.store,tasks:options.tasks,read:options.store.read.bind(options.store),current:options.store.isCurrent.bind(options.store),fork:options.store.fork.bind(options.store),get:options.tasks.get.bind(options.tasks),steps:options.tasks.steps.bind(options.tasks)};
}
type Services=ReturnType<typeof captured>;
async function progress(service:Services,key:DevelopmentRunKey):Promise<DevelopmentProgress>{
  const value=copy(await service.read(key),524288);validateDevelopmentRun(key,value.run);return freeze(value);
}
/** A cancelled external step may still be unknown. Only known physical outcomes permit an explicit replacement. */
async function physical(service:Services,p:DevelopmentProgress,stage:DevelopmentStage,required:boolean,task:Task|null):Promise<Reason|null>{
  const run=p.run;const key={tenantId:run.tenantId,projectId:run.projectId,runId:run.runId};const taskKey:TaskKey={tenantId:run.tenantId,taskId:developmentStageTaskId(key,stage)};
  if(!task)return required?'STAGE_NOT_FINISHED':null;
  try{
    const upstream=stage==='foundation'?null:p.foundation.review?.status==='reviewed'?p.foundation.review.digest:undefined;
    if(upstream===undefined||task.tenantId!==taskKey.tenantId||task.taskId!==taskKey.taskId||task.workflow!==DEVELOPMENT_STAGE_WORKFLOW||task.version!==developmentWorkflowVersion(run)
      ||hash(task.input)!==hash({projectId:run.projectId,runId:run.runId,stage,runDigest:run.digest,upstreamDigest:upstream})||!['queued','running','waiting','reconciling','succeeded','failed','cancelled'].includes(task.status))throw new Error();
    const records=await service.steps(taskKey);if(!Array.isArray(records)||records.length>64)throw new Error();
    const steps=records.map(step=>StepMetadata.parse(copy({key:step.key,position:step.position,kind:step.kind,status:step.status,fingerprint:step.fingerprint,idempotencyKey:step.idempotencyKey})));
    if(new Set(steps.map(step=>step.key)).size!==steps.length||steps.some(step=>step.idempotencyKey!==stepIdempotencyKey(taskKey,step.key)))throw new Error();
    if(task.status==='reconciling'||steps.some(step=>step.kind==='external'&&step.status==='unknown'))return 'UNKNOWN_RESULT';
    if(['queued','running','waiting'].includes(task.status))return 'RUN_IN_PROGRESS';
    if(steps.some(step=>step.kind==='external'&&step.status==='running'))return 'UNKNOWN_RESULT';
    return null;
  }catch{throw new DevelopmentError('STORAGE_FAILED','redo physical evidence');}
}
async function eligibility(service:Services,p:DevelopmentProgress):Promise<{foundation:Reason|null;episodes:Reason|null}>{
  const key={tenantId:p.run.tenantId,projectId:p.run.projectId,runId:p.run.runId};const owner=developmentCandidateOwner(p.run,'foundation');
  // A new episodes Task implies an already committed review. Read headers before the append-only audit to avoid pairing it with an older snapshot.
  const [foundationTask,episodesTask]=await Promise.all([service.get({tenantId:owner.key.tenantId,taskId:developmentStageTaskId(owner.key,'foundation')}),service.get({tenantId:key.tenantId,taskId:developmentStageTaskId(key,'episodes')})]);
  const fresh=await progress(service,key);if(hash(fresh.run)!==hash(p.run))throw new DevelopmentError('STORAGE_FAILED','redo immutable run');
  const source=owner.key.runId===key.runId?fresh:await progress(service,owner.key);
  const foundation=await physical(service,source,'foundation',true,foundationTask);
  const episodes=await physical(service,fresh,'episodes',!!fresh.run.origin?.foundation||fresh.foundation.review?.status==='reviewed',episodesTask);
  const requiredEpisodes=episodes??(episodesTask?null:'STAGE_NOT_FINISHED');
  const current=await service.current(key);if(typeof current!=='boolean')throw new DevelopmentError('STORAGE_FAILED','redo freshness');
  const first=foundation??episodes??(!current?'BRIEF_CHANGED':null);
  return {foundation:first,episodes:first??(fresh.foundation.review?.status==='reviewed'?requiredEpisodes:'UPSTREAM_NOT_REVIEWED')};
}
/** Read-only eligibility; data/Task stores are trusted host capabilities, never supplied by an HTTP caller. */
export async function inspectDevelopmentRedo(options:DevelopmentRedoServices,input:DevelopmentRunKey,supplied:DevelopmentRedoPreset|null):Promise<DevelopmentRedoOptions>{
  const key=freeze(parse(RunKeySchema,copy(input),'redo source scope'));const preset=supplied===null?null:freeze(parse(Preset,copy(supplied),'redo preset'));const service=captured(options);const p=await progress(service,key);const reasons=await eligibility(service,p);
  const full=preset?executionForDevelopment(preset.execution):null;const single=full?episodeExecutionFromFull(full):null;
  const option=(reason:Reason|null,execution:DevelopmentExecution|null)=>({canRedo:reason===null&&execution!==null,reason:reason??(execution?null:'MODEL_UNAVAILABLE'),budget:execution?{currency:execution.currency,tokens:execution.limits.tokens,costMicros:execution.limits.costMicros}:null});
  return freeze(DevelopmentRedoOptionsSchema.parse({runId:p.run.runId,runDigest:p.run.digest,briefDigest:p.run.brief.digest,modelLabel:preset?.label??null,foundation:option(reasons.foundation,full),episodes:option(reasons.episodes,single)}));
}
/** Explicit redo creates a new branch. Retrying an existing branch only drains its original journal. */
export async function startDevelopmentRedo(options:DevelopmentRedoServices,input:z.infer<typeof Request>):Promise<DevelopmentRun>{
  const request=freeze(parse(Request,copy(input),'redo request'));const service=captured(options);const source=await progress(service,request.source);
  if(request.command.runId===request.source.runId)throw new DevelopmentError('INVALID_INPUT','redo identity');
  if(request.command.expectedSourceRunDigest!==source.run.digest||request.command.expectedBriefDigest!==source.run.brief.digest||request.command.expectedFoundationReviewDigest!==(request.stage==='episodes'&&source.foundation.review?.status==='reviewed'?source.foundation.review.digest:null))throw new DevelopmentError('CONFLICT','redo source binding');
  const execution=request.stage==='episodes'?episodeExecutionFromFull(request.preset.execution):executionForDevelopment(request.preset.execution);
  const child={tenantId:request.source.tenantId,projectId:request.source.projectId,runId:request.command.runId};
  const command=parse(StartForkSchema,{...child,sourceRunId:request.source.runId,stage:request.stage,expectedSourceRunDigest:source.run.digest,expectedRevision:source.run.brief.revision,expectedBriefDigest:source.run.brief.digest,expectedFoundationReviewDigest:request.command.expectedFoundationReviewDigest,actorId:request.actorId,methods:request.preset.methods,execution},'redo command');
  let exists=false;try{await progress(service,child);exists=true;}catch(error){if(!(error instanceof DevelopmentError&&error.code==='NOT_FOUND'))throw error;}
  if(!exists){const reasons=await eligibility(service,source);if(reasons[request.stage]!==null)throw new DevelopmentError('CONFLICT','redo '+reasons[request.stage]);}
  const run=validateDevelopmentRun(child,await service.fork(command));
  if(run.origin?.sourceRunId!==request.source.runId||run.origin.sourceRunDigest!==source.run.digest||run.origin.stage!==request.stage||run.origin.actorId!==request.actorId)throw new DevelopmentError('STORAGE_FAILED','redo persisted origin');
  await enqueueNextDevelopmentTask(service.store,service.tasks,child);return run;
}

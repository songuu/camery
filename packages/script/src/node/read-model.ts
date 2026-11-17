import type {Task} from '@camery/durable';
import {DevelopmentError} from '../contracts.js';
import type {DevelopmentStage} from '../contracts.js';
import {DevelopmentBriefSchemaPublic,DevelopmentBriefViewSchema,DevelopmentRunViewSchema,DevelopmentStatusSchema,DevelopmentTaskViewSchema} from '../http.js';
import type {DevelopmentStatus,DevelopmentTaskView} from '../http.js';
import {copy,freeze,hash} from '../data.js';
import {DEVELOPMENT_STAGE_WORKFLOW,DEVELOPMENT_STAGE_WORKFLOW_VERSION,developmentStageTaskId,validateDevelopmentRun} from './contracts.js';
import type {DevelopmentProgress,StoredDevelopmentBrief} from './contracts.js';
export interface DevelopmentTasks {readonly foundation:Task|null;readonly episodes:Task|null}
function publicBrief(brief:DevelopmentProgress['run']['brief']){
  const {tenantId:_tenant,projectId:_project,...value}=brief;return DevelopmentBriefSchemaPublic.parse(value);
}
export function projectDevelopmentBrief(input:StoredDevelopmentBrief){
  try{const stored=copy(input);return freeze(DevelopmentBriefViewSchema.parse({brief:publicBrief(stored.brief),actorId:stored.actorId,createdAt:stored.createdAt}));}
  catch{throw new DevelopmentError('STORAGE_FAILED','brief projection');}
}
function taskView(progress:DevelopmentProgress,stage:DevelopmentStage,task:Task|null):DevelopmentTaskView|null{
  if(!task)return null;const {run}=progress;const key={tenantId:run.tenantId,projectId:run.projectId,runId:run.runId};
  const upstream=stage==='foundation'?null:progress.foundation.review?.status==='reviewed'?progress.foundation.review.digest:undefined;
  if(upstream===undefined||task.tenantId!==run.tenantId||task.taskId!==developmentStageTaskId(key,stage)||task.workflow!==DEVELOPMENT_STAGE_WORKFLOW||task.version!==DEVELOPMENT_STAGE_WORKFLOW_VERSION
    ||hash(task.input)!==hash({projectId:run.projectId,runId:run.runId,stage,runDigest:run.digest,upstreamDigest:upstream}))throw new Error('Task binding');
  const output=task.output&&typeof task.output==='object'&&!Array.isArray(task.output)?task.output:null;
  const resultState=output?.['state']==='candidate'||output?.['state']==='blocked'?output['state']:null;
  const reason=typeof output?.['reason']==='string'&&/^[A-Z_]{1,64}$(?![\s\S])/.test(output['reason'])?output['reason']:null;
  return DevelopmentTaskViewSchema.parse({stage,status:task.status,resultState,reason});
}
/** Inputs must come from DevelopmentStore.read, which reconstructs original candidates and human audits. This is no approval boundary. */
export function projectDevelopmentStatus(input:DevelopmentProgress,current:boolean,tasks:DevelopmentTasks):DevelopmentStatus{
  try{
    const p=copy(input,524288);const {run}=p;validateDevelopmentRun({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId},run);
    if(typeof current!=='boolean')throw new Error('Freshness result');
    const foundation=taskView(p,'foundation',tasks.foundation);const episodes=taskView(p,'episodes',tasks.episodes);
    const active=[foundation,episodes].find(task=>task&&['queued','running','waiting','reconciling'].includes(task.status));
    let stage:DevelopmentStage=p.foundation.review?.status==='reviewed'?'episodes':'foundation';let state:DevelopmentStatus['state'];let task=stage==='foundation'?foundation:episodes;
    // A saved business result does not prove its physical journal has drained. Observe the same original task first.
    if(active){stage=active.stage;task=active;state=active.status as 'queued'|'running'|'waiting'|'reconciling';}
    else if(p.foundation.review?.status==='rejected')state='rejected';
    else if(p.episodes.review)state=p.episodes.review.status;
    else if(!current)state='stale';
    else if(p[stage].candidate)state='awaiting_review';
    else if(task?.resultState==='blocked')state='blocked';
    else if(task?.status==='failed'||task?.status==='cancelled')state=task.status;
    else if(task?.status==='succeeded')throw new Error('Missing committed candidate');
    else state='queued';
    return freeze(DevelopmentStatusSchema.parse({runId:run.runId,briefId:run.brief.briefId,briefRevision:run.brief.revision,createdAt:run.createdAt,sourceChanged:!current,
      foundationCandidateDigest:p.foundation.candidate?.digest??null,foundationReviewStatus:p.foundation.review?.status??null,
      episodesCandidateDigest:p.episodes.candidate?.digest??null,episodesReviewStatus:p.episodes.review?.status??null,stage,state,task}));
  }catch{throw new DevelopmentError('STORAGE_FAILED','status projection');}
}
export function projectDevelopmentRun(input:DevelopmentProgress,current:boolean,tasks:DevelopmentTasks){
  try{
    const p=copy(input,524288);const status=projectDevelopmentStatus(p,current,tasks);
    const stage=(value:DevelopmentProgress['foundation']|DevelopmentProgress['episodes'])=>({candidate:value.candidate?{digest:value.candidate.digest,output:value.candidate.output}:null,
      review:value.review?{status:value.review.status,digest:value.review.digest,actorId:value.review.actorId,at:value.review.at,...(value.review.status==='reviewed'?{output:value.review.output}:{reason:value.review.reason})}:null});
    return freeze(DevelopmentRunViewSchema.parse({...status,brief:publicBrief(p.run.brief),budget:{currency:p.run.execution.currency,tokens:p.run.execution.limits.tokens,costMicros:p.run.execution.limits.costMicros},foundation:stage(p.foundation),episodes:stage(p.episodes)}));
  }catch{throw new DevelopmentError('STORAGE_FAILED','run projection');}
}

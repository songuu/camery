import { z } from 'zod';
import type { Task } from '@camery/durable';
import { Hash,Id,Integer } from '../../contracts.js';
import { deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OUTLINE_ENVELOPE_BYTES } from '../generation-contracts.js';
import { OutlineBriefSchemaPublic,OutlineBriefViewSchema,OutlineRunViewSchema,OutlineStatusSchema,OutlineTaskViewSchema } from '../http.js';
import type { OutlineStatus,OutlineTaskView } from '../http.js';
import { reviewOutlineCraft } from '../outline.js';
import { validateOutlineBrief } from './brief.js';
import { copy,hash } from './data.js';
import { outlineContext } from './generation.js';
import { OutlineKeySchema,OutlineTaskReferenceSchema,OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION,outlineTaskId,outlineTaskReference } from './persistence-contracts.js';
import type { OutlineProgress,StoredOutlineBrief } from './persistence-contracts.js';
import { captureOutlineProgress } from './state.js';

const Status=z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled']);
const Binding=z.strictObject({tenantId:Id,taskId:Id,workflow:z.string(),version:Integer.min(1),input:OutlineTaskReferenceSchema,status:Status,output:z.json()});
const CandidateResult=z.strictObject({state:z.literal('candidate'),runDigest:Hash,candidateDigest:Hash});
const BlockedResult=z.strictObject({state:z.literal('blocked'),runDigest:Hash,reason:z.string().max(1024).nullable(),charged:z.strictObject({tokens:Integer,costMicros:Integer}),usageUnknown:z.boolean()});
// Only stable host codes reach the UI. Arbitrary task diagnostics, including uppercase credentials, remain private.
const reasons=new Set(['ABORTED','OUTLINE_SOURCE_CHANGED','OUTLINE_SOURCE_UNAVAILABLE','OUTLINE_SESSION_UNAVAILABLE','OUTLINE_MODEL_BINDING','OUTLINE_CALL_BINDING','OUTLINE_REFERENCE_BINDING','BUDGET_EXCEEDED','TOKEN_BUDGET_EXCEEDED','COST_BUDGET_EXCEEDED','MODEL_FAILED','METHOD_FAILED','INVALID_MODEL_OUTPUT']);
const fields=['tenantId','taskId','workflow','version','input','status','output'] as const;
function dataField(input:unknown,key:string):unknown{
  const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!('value' in d))throw new Error('Stored data field');return d.value;
}
function progress(input:OutlineProgress):OutlineProgress{
  const raw=dataField(input,'run');
  const key=OutlineKeySchema.parse(copy({tenantId:dataField(raw,'tenantId'),projectId:dataField(raw,'projectId'),runId:dataField(raw,'runId')},2048));
  // The shared validator performs the full bounded snapshot; avoid copying all three envelopes a second time.
  return captureOutlineProgress(key,input);
}
function publicBrief(brief:OutlineProgress['run']['brief']){
  const {tenantId:_tenant,projectId:_project,...value}=brief;return OutlineBriefSchemaPublic.parse(value);
}
function taskView(p:OutlineProgress,task:Task|null):OutlineTaskView|null{
  if(task===null)return null;
  const selected:Record<string,unknown>={};
  for(const field of fields)selected[field]=dataField(task,field);
  const stored=Binding.parse(copy(selected,16384)),run=p.run;
  if(stored.tenantId!==run.tenantId||stored.taskId!==outlineTaskId({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId})||stored.workflow!==OUTLINE_WORKFLOW||stored.version!==OUTLINE_WORKFLOW_VERSION||hash(stored.input)!==hash(outlineTaskReference(run)))throw new Error('Task binding');
  let resultState:OutlineTaskView['resultState']=null,reason:string|null=null;
  if(stored.output!==null){
    if(stored.status!=='succeeded')throw new Error('Unfinished task result');
    if(typeof stored.output!=='object'||Array.isArray(stored.output))throw new Error('Task result');
    if(stored.output['state']==='candidate'){
      const result=CandidateResult.parse(stored.output);
      if(result.runDigest!==run.digest||result.candidateDigest!==p.candidate?.digest)throw new Error('Candidate result binding');resultState='candidate';
    }else{
      const result=BlockedResult.parse(stored.output);
      if(result.runDigest!==run.digest||p.candidate)throw new Error('Blocked result binding');resultState='blocked';reason=result.reason!==null&&reasons.has(result.reason)?result.reason:null;
    }
  }
  return OutlineTaskViewSchema.parse({status:stored.status,resultState,reason});
}
function statusOf(p:OutlineProgress,current:boolean,original:Task|null):OutlineStatus{
  if(typeof current!=='boolean')throw new Error('Freshness result');
  const task=taskView(p,original);let state:OutlineStatus['state'];
  // Candidate COMMIT and human review can precede Worker finish. Expose the original physical journal first.
  if(task&&['queued','running','waiting','reconciling'].includes(task.status))state=task.status as 'queued'|'running'|'waiting'|'reconciling';
  else if(p.review)state=p.review.status;
  else if(!p.candidate&&task?.resultState==='blocked')state='blocked';
  else if(!p.candidate&&(task?.status==='failed'||task?.status==='cancelled'))state=task.status;
  else if(!p.candidate&&task?.status==='succeeded')throw new Error('Missing candidate');
  else if(!current)state='stale';
  else state=p.candidate?'awaiting_review':'not_dispatched';
  const {run}=p;return OutlineStatusSchema.parse({runId:run.runId,runDigest:run.digest,briefId:run.brief.briefId,briefRevision:run.brief.revision,createdAt:run.createdAt,
    candidateDigest:p.candidate?.digest??null,reviewStatus:p.review?.status??null,sourceChanged:!current,state,task});
}
/** Trusted store projections only: integrity replay is neither caller authentication nor human approval. */
export function projectOutlineBrief(input:StoredOutlineBrief){
  try{const stored=copy(input,OUTLINE_ENVELOPE_BYTES),brief=validateOutlineBrief(stored.brief);return deepFreeze(OutlineBriefViewSchema.parse({brief:publicBrief(brief),actorId:stored.actorId,createdAt:stored.createdAt}));}
  catch{throw new OutlineError('STORAGE_FAILED','brief projection','storage');}
}
export function projectOutlineStatus(input:OutlineProgress,current:boolean,task:Task|null):OutlineStatus{
  try{return deepFreeze(statusOf(progress(input),current,task));}
  catch{throw new OutlineError('STORAGE_FAILED','status projection','storage');}
}
export function projectOutlineRun(input:OutlineProgress,current:boolean,task:Task|null){
  try{
    const p=progress(input),status=statusOf(p,current,task),{tenantId:_tenant,projectId:_project,...descriptor}=p.run.source.descriptor;
    const source={...p.run.source,descriptor},candidate=p.candidate?{digest:p.candidate.digest,output:p.candidate.output,report:reviewOutlineCraft(outlineContext(p.run.brief,p.run.source),p.candidate.output,p.run.brief.thresholds)}:null;
    const review=p.review?{status:p.review.status,digest:p.review.digest,candidateDigest:p.review.candidateDigest,actorId:p.review.actorId,at:p.review.at,
      ...(p.review.status==='reviewed'?{output:p.review.output,report:p.review.report,ablations:p.review.ablations,waivers:p.review.waivers}:{reason:p.review.reason})}:null;
    return deepFreeze(OutlineRunViewSchema.parse({...status,brief:publicBrief(p.run.brief),source,candidate,review}));
  }catch{throw new OutlineError('STORAGE_FAILED','run projection','storage');}
}

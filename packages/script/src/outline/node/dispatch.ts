import { z } from 'zod';
import type { DurableStore,Task } from '@camery/durable';
import { Id } from '../../contracts.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { hash } from './data.js';
import { OutlineKeySchema,OutlineTaskReferenceSchema,OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION,outlineTaskId,outlineTaskReference } from './persistence-contracts.js';
import type { OutlineRunKey,OutlineStore } from './persistence-contracts.js';
import { captureOutlineProgress } from './state.js';

export type OutlineDispatch={state:'task';task:Task}|{state:'awaiting_review';candidateDigest:string}|{state:'reviewed';status:'reviewed'|'rejected'}|{state:'stale'};
const Binding=z.strictObject({tenantId:Id,taskId:Id,workflow:z.string(),version:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),input:OutlineTaskReferenceSchema,
  status:z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled'])});
const taskFields=['tenantId','taskId','workflow','version','input','status'] as const;

/** Reference dispatch never replaces a terminal/unknown task or skips an unfinished persistence journal tail. */
export async function enqueueOutlineTask(store:Pick<OutlineStore,'read'|'isCurrent'>,durable:Pick<DurableStore,'get'|'enqueue'>,input:OutlineRunKey):Promise<OutlineDispatch>{
  const key=deepFreeze(capture(OutlineKeySchema,input,'dispatch key',2048));
  const read=store.read.bind(store),current=store.isCurrent.bind(store),get=durable.get.bind(durable),enqueue=durable.enqueue.bind(durable);
  const progress=captureOutlineProgress(key,await read(key)),taskId=outlineTaskId(key),reference=outlineTaskReference(progress.run);
  function checked(task:Task):{task:Task;status:Task['status']}{
    try{
      const fields:Record<string,unknown>={};
      for(const field of taskFields){const descriptor=Object.getOwnPropertyDescriptor(task,field);if(!descriptor||!('value' in descriptor))throw new Error();fields[field]=descriptor.value;}
      const binding=capture(Binding,fields,'stored task',8192);
      if(binding.tenantId!==key.tenantId||binding.taskId!==taskId||binding.workflow!==OUTLINE_WORKFLOW||binding.version!==OUTLINE_WORKFLOW_VERSION||hash(binding.input)!==hash(reference))throw new Error();
      return {task,status:binding.status};
    }catch{throw new OutlineError('STORAGE_FAILED','dispatched task binding','task');}
  }
  const existing=await get(deepFreeze({tenantId:key.tenantId,taskId}));
  if(existing!==null){
    const checkedTask=checked(existing);
    // A saved candidate may precede task finish; drain the original journal before exposing business completion.
    if(['queued','running','waiting','reconciling'].includes(checkedTask.status)||!progress.candidate)return {state:'task',task:checkedTask.task};
  }
  if(progress.review)return {state:'reviewed',status:progress.review.status};
  if(await current(key)!==true)return {state:'stale'};
  if(progress.candidate)return {state:'awaiting_review',candidateDigest:progress.candidate.digest};
  const task=await enqueue({tenantId:key.tenantId,taskId,workflow:OUTLINE_WORKFLOW,version:OUTLINE_WORKFLOW_VERSION,input:reference,maxAttempts:3,availableAt:new Date(progress.run.createdAt)});
  return {state:'task',task:checked(task).task};
}

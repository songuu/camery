import {z} from 'zod';
import type {DurableStore,Task} from '@camery/durable';
import {ComplianceError,Id} from '../contracts.js';
import {capture,freeze} from '../boundary.js';
import {authorizeHost,captureHost} from './host.js';
import {equal} from './data.js';
import {ScanKeySchema,BatchTaskReferenceSchema,CLASSIFICATION_WORKFLOW,CLASSIFICATION_WORKFLOW_VERSION,captureScanBatchProgress,batchTaskId,batchReference,MAX_BATCHES} from './state.js';
import {Integer} from '../contracts.js';
import type {PostgresPrecheckStore} from './store.js';
const Binding=z.strictObject({tenantId:Id,taskId:Id,workflow:z.string(),version:z.number().int().min(1),input:BatchTaskReferenceSchema,status:z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled'])});
export type PrecheckDispatch={state:'task';task:Task}|{state:'advisory_available';runDigest:string;index:number;resultDigest:string}|{state:'stale'};
/** One immutable task per planned batch. No replacement task is manufactured for blocked or unknown provider work. */
export async function enqueuePrecheckBatch(store:Pick<PostgresPrecheckStore,'readBatch'|'isCurrent'>,durable:Pick<DurableStore,'get'|'enqueue'>,keyInput:unknown,indexInput:unknown,hostInput:unknown):Promise<PrecheckDispatch>{
  const key=freeze(capture(ScanKeySchema,keyInput,'precheck dispatch key',2048)),index=capture(Integer.max(MAX_BATCHES-1),indexInput,'precheck dispatch index',32),host=captureHost(hostInput),read=store.readBatch.bind(store),current=store.isCurrent.bind(store),get=durable.get.bind(durable),enqueue=durable.enqueue.bind(durable),progress=captureScanBatchProgress(key,index,await read(key,index,host)),run=progress.run,reference=batchReference(run,index),result=progress.result,taskId=batchTaskId(key,index);
  function checked(task:Task){try{const values:Record<string,unknown>={};for(const name of ['tenantId','taskId','workflow','version','input','status']){const d=Object.getOwnPropertyDescriptor(task,name);if(!d||!('value'in d))throw new Error();values[name]=d.value;}const b=capture(Binding,values,'stored precheck task',8192);if(b.tenantId!==key.tenantId||b.taskId!==taskId||b.workflow!==CLASSIFICATION_WORKFLOW||b.version!==CLASSIFICATION_WORKFLOW_VERSION||!equal(b.input,reference))throw new Error();return {task,status:b.status};}catch{throw new ComplianceError('STORAGE_FAILED','precheck task binding','task');}}
  const prior=await get(freeze({tenantId:key.tenantId,taskId}));if(prior!==null){const actual=checked(prior);if(['queued','running','waiting','reconciling'].includes(actual.status)||!result)return {state:'task',task:actual.task};}
  if(await current(key,host)!==true)return {state:'stale'};if(result)return {state:'advisory_available',runDigest:run.digest,index,resultDigest:result.digest};
  const allowed=authorizeHost(host,'compliance:scan',{tenantId:key.tenantId,projectId:key.projectId});if(allowed.actor.id!==run.authorId)throw new ComplianceError('FORBIDDEN','precheck dispatch author','host.actor');
  const task=await enqueue({tenantId:key.tenantId,taskId,workflow:CLASSIFICATION_WORKFLOW,version:CLASSIFICATION_WORKFLOW_VERSION,input:reference,maxAttempts:3,availableAt:new Date(run.createdAt)});return {state:'task',task:checked(task).task};
}

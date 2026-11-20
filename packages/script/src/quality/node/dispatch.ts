import {z} from 'zod';
import type {DurableStore,Task} from '@camery/durable';
import {Id} from '../../contracts.js';
import {QualityError} from '../contracts.js';
import {captureQuality,freezeQuality} from '../boundary.js';
import {authorizeQualityHost,captureQualityHost} from './host.js';
import {equalQualityData} from './data.js';
import {QualityKeySchema,QualityBatchAddressSchema,QualityBatchReferenceSchema,QUALITY_WORKFLOW,QUALITY_WORKFLOW_VERSION,qualityBatchTaskId,qualityBatchReference} from './state.js';
import {captureQualityBatchProgress} from './progress.js';
import type {PostgresQualityStore} from './store.js';
const Binding=z.strictObject({tenantId:Id,taskId:Id,workflow:z.string(),version:z.number().int().min(1),input:QualityBatchReferenceSchema,status:z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled'])});
export type QualityDispatch={state:'task';task:Task}|{state:'review_available'|'saved_historical';runDigest:string;cycle:1|2;phase:'story'|'continuity'|'production';index:number;resultDigest:string}|{state:'stale_or_out_of_order'};
/** Existing active/unknown tasks retain their original identity even when the source or review stage advances. */
export async function enqueueQualityBatch(store:Pick<PostgresQualityStore,'readBatch'|'isRunnable'|'isCurrent'>,durable:Pick<DurableStore,'get'|'enqueue'>,keyInput:unknown,addressInput:unknown,hostInput:unknown):Promise<QualityDispatch>{
  const key=freezeQuality(captureQuality(QualityKeySchema,keyInput,'quality dispatch key',2048)),address=freezeQuality(captureQuality(QualityBatchAddressSchema,addressInput,'quality dispatch address',256)),host=captureQualityHost(hostInput),read=store.readBatch.bind(store),runnable=store.isRunnable.bind(store),current=store.isCurrent.bind(store),get=durable.get.bind(durable),enqueue=durable.enqueue.bind(durable),progress=captureQualityBatchProgress(key,address,await read(key,address,host)),run=progress.run,reference=qualityBatchReference(run,progress.material.record,address),result=progress.result,taskId=qualityBatchTaskId(key,address.cycle,address.phase,address.index);
  function checked(task:Task){try{const values:Record<string,unknown>={};for(const name of ['tenantId','taskId','workflow','version','input','status']){const descriptor=Object.getOwnPropertyDescriptor(task,name);if(!descriptor||!('value'in descriptor))throw new Error();values[name]=descriptor.value;}const binding=captureQuality(Binding,values,'stored quality task',8192);if(binding.tenantId!==key.tenantId||binding.taskId!==taskId||binding.workflow!==QUALITY_WORKFLOW||binding.version!==QUALITY_WORKFLOW_VERSION||!equalQualityData(binding.input,reference))throw new Error();return {task,status:binding.status};}catch{throw new QualityError('STORAGE_FAILED','quality task binding','task');}}
  const prior=await get(freezeQuality({tenantId:key.tenantId,taskId}));if(prior!==null){const actual=checked(prior);if(['queued','running','waiting','reconciling'].includes(actual.status)||!result)return {state:'task',task:actual.task};}
  if(result)return {state:await current(key,address.cycle,host)===true?'review_available':'saved_historical',runDigest:run.digest,...address,resultDigest:result.digest};
  if(await runnable(key,address,host)!==true)return {state:'stale_or_out_of_order'};const allowed=authorizeQualityHost(host,'quality:run',{tenantId:key.tenantId,projectId:key.projectId});if(allowed.actor.id!==run.authorId)throw new QualityError('FORBIDDEN','quality dispatch author','actor');
  const task=await enqueue({tenantId:key.tenantId,taskId,workflow:QUALITY_WORKFLOW,version:QUALITY_WORKFLOW_VERSION,input:reference,maxAttempts:3,availableAt:new Date(progress.material.record.at)});return {state:'task',task:checked(task).task};
}

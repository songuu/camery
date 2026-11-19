import {z} from 'zod';
import type {DurableStore,Task} from '@camery/durable';
import {Id} from '../../contracts.js';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {ScreenplayError} from '../contracts.js';
import {ScreenplayGenerationKeySchema,ScreenplayGenerationTaskReferenceSchema,SCREENPLAY_GENERATION_WORKFLOW,SCREENPLAY_GENERATION_WORKFLOW_VERSION} from './generation-contracts.js';
import {captureScreenplayGenerationProgress,generationEqual,screenplayGenerationTaskId,screenplayGenerationReference} from './generation-state.js';
import type {PostgresScreenplayGenerationStore} from './generation-store.js';
import {captureScreenplayHost,authorizeScreenplayHost} from './host.js';
const Binding=z.strictObject({tenantId:Id,taskId:Id,workflow:z.string(),version:z.number().int().min(1),input:ScreenplayGenerationTaskReferenceSchema,status:z.enum(['queued','running','waiting','reconciling','succeeded','failed','cancelled'])});
export type ScreenplayGenerationDispatch={state:'task';task:Task}|{state:'awaiting_review';candidateId:string;preparationDigest:string}|{state:'stale'};
/** The original task remains authoritative, including unknown paid outcomes and unfinished delivery tails. */
export async function enqueueScreenplayTask(store:Pick<PostgresScreenplayGenerationStore,'read'|'isCurrent'>,durable:Pick<DurableStore,'get'|'enqueue'>,input:unknown,hostInput:unknown):Promise<ScreenplayGenerationDispatch>{
  const key=freezeScreenplay(captureScreenplay(ScreenplayGenerationKeySchema,input,'screenplay dispatch key',2048)),host=captureScreenplayHost(hostInput),read=store.read.bind(store),current=store.isCurrent.bind(store),get=durable.get.bind(durable),enqueue=durable.enqueue.bind(durable),progress=captureScreenplayGenerationProgress(key,await read(key,host)),taskId=screenplayGenerationTaskId(key),reference=screenplayGenerationReference(progress.run);
  function checked(task:Task){try{const fields:Record<string,unknown>={};for(const field of ['tenantId','taskId','workflow','version','input','status']){const descriptor=Object.getOwnPropertyDescriptor(task,field);if(!descriptor||!('value'in descriptor))throw new Error();fields[field]=descriptor.value;}const actual=captureScreenplay(Binding,fields,'stored screenplay task',8192);if(actual.tenantId!==key.tenantId||actual.taskId!==taskId||actual.workflow!==SCREENPLAY_GENERATION_WORKFLOW||actual.version!==SCREENPLAY_GENERATION_WORKFLOW_VERSION||!generationEqual(actual.input,reference))throw new Error();return {task,status:actual.status};}catch{throw new ScreenplayError('STORAGE_FAILED','screenplay task binding','task');}}
  const existing=await get(freezeScreenplay({tenantId:key.tenantId,taskId}));if(existing!==null){const actual=checked(existing);if(['queued','running','waiting','reconciling'].includes(actual.status)||!progress.delivery)return {state:'task',task:actual.task};}
  if(await current(key,host)!==true)return {state:'stale'};
  if(progress.delivery)return {state:'awaiting_review',candidateId:progress.run.candidateId,preparationDigest:progress.delivery.preparationDigest};
  const permitted=authorizeScreenplayHost(host,'screenplay:prepare',{tenantId:key.tenantId,projectId:key.projectId});if(permitted.actor.id!==progress.run.authorId)throw new ScreenplayError('FORBIDDEN','screenplay dispatch author','host.actor');
  const task=await enqueue({tenantId:key.tenantId,taskId,workflow:SCREENPLAY_GENERATION_WORKFLOW,version:SCREENPLAY_GENERATION_WORKFLOW_VERSION,input:reference,maxAttempts:3,availableAt:new Date(progress.run.createdAt)});return {state:'task',task:checked(task).task};
}

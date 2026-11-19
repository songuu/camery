import {vi} from 'vitest';
import type {EnqueueTask,Task,TaskKey} from '@camery/durable';
import type {ClassifiedBatch} from '../src/node/generation.js';
import {generateClassification} from '../src/node/generation.js';
import {CLASSIFICATION_WORKFLOW,CLASSIFICATION_WORKFLOW_VERSION,batchCallId,batchReference,batchTaskId} from '../src/node/state.js';
import {scanFixture} from './scan-support.js';

/** Reference dispatch protocol only: immutable source integrity is synthetic; actual authority and durability belong to PG tests. */
export function dispatchFixture(){
  const f=scanFixture(),state={result:null as ClassifiedBatch|null,current:true,task:null as Task|null},host={scope:{...f.scope},actor:{kind:'human' as const,id:'editor'},at:f.run.createdAt,authorize:vi.fn((_request:{action:string})=>true)},store={readBatch:vi.fn(async(_key:unknown,_index:unknown,_host:unknown)=>({run:f.run,result:state.result,review:null})),isCurrent:vi.fn(async(_key:unknown,_host:unknown)=>state.current)};
  const task=(status:Task['status']='queued'):Task=>({tenantId:f.key.tenantId,taskId:batchTaskId(f.key,0),workflow:CLASSIFICATION_WORKFLOW,version:CLASSIFICATION_WORKFLOW_VERSION,input:batchReference(f.run,0),status,maxAttempts:3,availableAt:new Date(f.run.createdAt),attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null}),durable={get:vi.fn(async(_key:TaskKey)=>state.task),enqueue:vi.fn(async(input:EnqueueTask)=>{state.task={...task(),...input};return state.task;})};
  async function result(){f.call.idempotencyKey=batchCallId(f.key,0);state.result=await generateClassification(f);return state.result;}
  return {...f,state,host,store,durable,task,result};
}

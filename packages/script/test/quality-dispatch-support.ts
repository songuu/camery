import {vi} from 'vitest';
import {MethodRegistry,MethodRunner,createStructuredGenerationExecutor} from '@camery/methods';
import type {EnqueueTask,Task,TaskKey} from '@camery/durable';
import {QUALITY_WORKFLOW,QUALITY_WORKFLOW_VERSION,qualityBatchCallId} from '../src/quality/node/state.js';
import type {QualityBatchAddress} from '../src/quality/node/state.js';
import {generateQualityReview} from '../src/quality/node/generation.js';
import {qualityWorkflowFixture} from './quality-workflow-support.js';

/** Dispatch/task protocol only. Actual SQL visibility, authority and Durable task leases require PostgreSQL integration. */
export async function qualityDispatchFixture(address?:QualityBatchAddress){
  const f=await qualityWorkflowFixture(address),state=Object.assign(f.state,{task:null as Task|null}),task=(status:Task['status']='queued'):Task=>({tenantId:f.key.tenantId,taskId:f.task.taskId,workflow:QUALITY_WORKFLOW,version:QUALITY_WORKFLOW_VERSION,input:f.reference,status,maxAttempts:3,availableAt:new Date(f.material.record.at),attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null}),durable={get:vi.fn(async(_key:TaskKey)=>state.task),enqueue:vi.fn(async(input:EnqueueTask)=>{state.task={...task(),...input};return state.task;})};
  async function result(){const registry=new MethodRegistry();registry.register(f.prepared.plan.phases[f.address.phase].pack);state.result=await generateQualityReview({prepared:f.prepared,method:f.prepared.method,runner:new MethodRunner(registry,[createStructuredGenerationExecutor(f.session)]),call:{tenantId:f.key.tenantId,connectionId:f.session.profile.connectionId,modeDigest:f.session.profile.modeDigest,idempotencyKey:qualityBatchCallId(f.key,f.address.cycle,f.address.phase,f.address.index),signal:new AbortController().signal}});return state.result;}
  return {...f,state,durable,storedTask:task,result};
}

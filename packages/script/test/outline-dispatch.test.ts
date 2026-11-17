import { describe,expect,it,vi } from 'vitest';
import type { EnqueueTask,Task } from '@camery/durable';
import { generateOutline } from '../src/outline/node/generation.js';
import { reviewOutline,rejectOutline } from '../src/outline/node/review.js';
import { enqueueOutlineTask } from '../src/outline/node/dispatch.js';
import { OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION,outlineCallId,outlineTaskId,outlineTaskReference } from '../src/outline/node/persistence-contracts.js';
import type { OutlineProgress } from '../src/outline/node/persistence-contracts.js';
import { outlineModelFixture } from './outline-model-support.js';
import { outlineMemory } from './outline-store-memory.js';

async function fixture(){
  const f=await outlineModelFixture(),db=outlineMemory(f.source);const {version:_v,digest:_d,profiles:_p,revision:_r,...fields}=f.brief;
  const brief=(await db.store.putBrief({...fields,expectedRevision:0,actorId:f.host.actor.id})).brief;
  const key={tenantId:brief.tenantId,projectId:brief.projectId,runId:'dispatch-outline'};
  const run=await db.store.start({...key,briefId:brief.briefId,expectedRevision:brief.revision,expectedBriefDigest:brief.digest,source:f.source.descriptor,execution:{connectionId:f.session.profile.connectionId,modeDigest:f.session.profile.modeDigest,modelIdentity:f.session.profile.modelIdentity,evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:300,costMicros:0},limits:{steps:1,tokens:300,costMicros:0}}});
  const state={progress:{run,candidate:null,review:null} as OutlineProgress,current:true,task:null as Task|null};
  const store={read:vi.fn(async()=>state.progress),isCurrent:vi.fn(async()=>state.current)};
  const task=(status:Task['status']='queued'):Task=>({tenantId:key.tenantId,taskId:outlineTaskId(key),workflow:OUTLINE_WORKFLOW,version:OUTLINE_WORKFLOW_VERSION,input:outlineTaskReference(run),maxAttempts:3,availableAt:new Date(run.createdAt),status,attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null});
  const durable={get:vi.fn(async()=>state.task),enqueue:vi.fn(async(input:EnqueueTask)=>{state.task={...task(),...input};return state.task;})};
  async function candidate(){const proposed=await generateOutline({...f,brief:run.brief,source:run.source,context:{...f.context,idempotencyKey:outlineCallId(key)}});state.progress={run,candidate:proposed,review:null};return proposed;}
  async function reviewed(status:'reviewed'|'rejected'='reviewed'){
    const proposed=state.progress.candidate??await candidate();
    const review=status==='reviewed'?reviewOutline(run.brief,run.source,proposed,{candidateDigest:proposed.digest,output:proposed.output,ablations:[{genre:'suspense',judgment:'participates',reason:'人工核对查证改变反击条件。'}],waivers:[]},f.host):rejectOutline(run.brief,run.source,proposed,'明确拒绝此稿。',f.host);
    state.progress={run,candidate:proposed,review};return review;
  }
  return {...f,key,run,state,store,task,durable,candidate,reviewed};
}

describe('reference-only outline task dispatch',()=>{
  it('enqueues exactly the fixed task identity and a small immutable run reference',async()=>{
    const f=await fixture();const result=await enqueueOutlineTask(f.store,f.durable,f.key);
    expect(result).toEqual({state:'task',task:f.state.task});expect(f.store.read).toHaveBeenCalledWith(f.key);expect(f.durable.get).toHaveBeenCalledWith({tenantId:f.key.tenantId,taskId:outlineTaskId(f.key)});
    expect(f.durable.enqueue).toHaveBeenCalledWith({tenantId:f.key.tenantId,taskId:outlineTaskId(f.key),workflow:OUTLINE_WORKFLOW,version:OUTLINE_WORKFLOW_VERSION,input:outlineTaskReference(f.run),maxAttempts:3,availableAt:new Date(f.run.createdAt)});
    expect(f.durable.enqueue.mock.calls[0]![0].input).not.toHaveProperty('source');expect(f.exchange).not.toHaveBeenCalled();
    expect(await enqueueOutlineTask(f.store,f.durable,f.key)).toEqual(result);expect(f.durable.enqueue).toHaveBeenCalledOnce();
  });
  it.each(['queued','running','waiting','reconciling'] as const)('drains the original %s task before reviewed or stale business state',async status=>{
    const f=await fixture();await f.reviewed();f.state.task=f.task(status);f.state.current=false;
    expect(await enqueueOutlineTask(f.store,f.durable,f.key)).toEqual({state:'task',task:f.state.task});expect(f.store.isCurrent).not.toHaveBeenCalled();expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it.each(['succeeded','failed','cancelled'] as const)('keeps terminal %s without a candidate authoritative instead of manufacturing a retry',async status=>{
    const f=await fixture();f.state.task=f.task(status);f.state.current=false;
    expect(await enqueueOutlineTask(f.store,f.durable,f.key)).toEqual({state:'task',task:f.state.task});expect(f.store.isCurrent).not.toHaveBeenCalled();expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it.each(['succeeded','failed','cancelled'] as const)('exposes the saved candidate after terminal %s without enqueueing again',async status=>{
    const f=await fixture();const proposed=await f.candidate();f.state.task=f.task(status);
    expect(await enqueueOutlineTask(f.store,f.durable,f.key)).toEqual({state:'awaiting_review',candidateDigest:proposed.digest});expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it.each(['reviewed','rejected'] as const)('returns the stored %s decision before stale state',async status=>{
    const f=await fixture();await f.reviewed(status);f.state.task=f.task('succeeded');f.state.current=false;
    expect(await enqueueOutlineTask(f.store,f.durable,f.key)).toEqual({state:'reviewed',status});expect(f.store.isCurrent).not.toHaveBeenCalled();expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it('does not start a new model task for stale inputs',async()=>{
    const f=await fixture();f.state.current=false;expect(await enqueueOutlineTask(f.store,f.durable,f.key)).toEqual({state:'stale'});expect(f.durable.enqueue).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
  });
  it('keeps a stale unreviewed candidate out of first-review readiness while preserving its original task',async()=>{
    const f=await fixture();await f.candidate();f.state.task=f.task('succeeded');f.state.current=false;
    expect(await enqueueOutlineTask(f.store,f.durable,f.key)).toEqual({state:'stale'});expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it('never treats invalid stored progress as authority, even when a live task exists',async()=>{
    const f=await fixture();f.state.task=f.task();f.state.progress={...f.state.progress,run:{...f.run,digest:'b'.repeat(64)}};
    await expect(enqueueOutlineTask(f.store,f.durable,f.key)).rejects.toMatchObject({code:'CONFLICT'});expect(f.durable.get).not.toHaveBeenCalled();expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it.each(['tenant','task','workflow','version','input-project','input-run','input-digest','input-extra','status'] as const)('rejects a mismatched stored task %s',async field=>{
    const f=await fixture();const task=f.task();
    if(field==='tenant')task.tenantId='foreign';if(field==='task')task.taskId='foreign';if(field==='workflow')task.workflow='foreign';if(field==='version')task.version=2;
    if(field.startsWith('input-'))task.input={...outlineTaskReference(f.run),...(field==='input-project'?{projectId:'foreign'}:field==='input-run'?{runId:'foreign'}:field==='input-digest'?{runDigest:'b'.repeat(64)}:{extra:true})};
    if(field==='status')task.status='unknown' as never;f.state.task=task;
    await expect(enqueueOutlineTask(f.store,f.durable,f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it('checks the enqueue response as rigorously as an existing task',async()=>{
    const f=await fixture();f.durable.enqueue.mockResolvedValue({...f.task(),tenantId:'foreign'});
    await expect(enqueueOutlineTask(f.store,f.durable,f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  });
  it.each([undefined,false,0])('refuses malformed falsy get results rather than interpreting them as a missing task %#',async task=>{
    const f=await fixture();f.durable.get.mockResolvedValue(task as unknown as Task);
    await expect(enqueueOutlineTask(f.store,f.durable,f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it('refuses a stored task accessor without executing its body',async()=>{
    const f=await fixture();let called=false;f.state.task=Object.defineProperty(f.task(),'status',{enumerable:true,get(){called=true;throw new Error('secret');}});
    await expect(enqueueOutlineTask(f.store,f.durable,f.key)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(called).toBe(false);expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it('captures key and protocol methods before awaiting the store',async()=>{
    const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.store.read.mockImplementation(async()=>{await gate;return f.state.progress;});
    const key={...f.key};const pending=enqueueOutlineTask(f.store,f.durable,key);key.tenantId='foreign';key.runId='foreign';
    const current=f.store.isCurrent;f.store.isCurrent=vi.fn(async()=>false);const enqueue=f.durable.enqueue;f.durable.enqueue=vi.fn<(input:EnqueueTask)=>Promise<Task>>(async()=>{throw new Error('replaced');});release();
    expect((await pending).state).toBe('task');expect(current).toHaveBeenCalledWith(f.key);expect(enqueue).toHaveBeenCalledOnce();expect(f.durable.enqueue).not.toHaveBeenCalled();
  });
  it('rejects malformed/accessor keys before any store work and does not execute the accessor',async()=>{
    const f=await fixture();let called=false;const key=Object.defineProperty({...f.key},'tenantId',{enumerable:true,get(){called=true;throw new Error('secret');}});
    await expect(enqueueOutlineTask(f.store,f.durable,key)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(called).toBe(false);expect(f.store.read).not.toHaveBeenCalled();
    await expect(enqueueOutlineTask(f.store,f.durable,{...f.key,unexpected:true} as typeof f.key)).rejects.toMatchObject({code:'INVALID_INPUT'});
  });
});

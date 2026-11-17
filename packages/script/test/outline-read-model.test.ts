import { expect,it,vi } from 'vitest';
import type { Task } from '@camery/durable';
import { projectOutlineBrief,projectOutlineRun,projectOutlineStatus } from '../src/outline/node/read-model.js';
import { OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION,outlineTaskReference } from '../src/outline/node/persistence-contracts.js';
import { createOutlineWorkflow } from '../src/outline/node/workflow.js';
import { outlineWorkflowFixture } from './outline-workflow-support.js';
import { workflowJournal } from './workflow-support.js';

type Fixture=Awaited<ReturnType<typeof outlineWorkflowFixture>>;
function task(f:Fixture,status:Task['status']='queued'):Task{
  return {...f.task,workflow:OUTLINE_WORKFLOW,version:OUTLINE_WORKFLOW_VERSION,input:outlineTaskReference(f.run),status,maxAttempts:3,availableAt:null,attempts:1,fence:1,owner:'private-worker',leaseUntil:null,output:null,error:'private provider credential'};
}
async function generated(){const f=await outlineWorkflowFixture();const journal=workflowJournal(f.task);const result=await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context());return {...f,journal,result};}
it('projects a saved brief and pending run without execution, receipt, scope or task diagnostics',async()=>{
  const f=await outlineWorkflowFixture(),progress=await f.progress();
  const view=projectOutlineRun(progress,true,task(f));expect(view.state).toBe('queued');expect(view.source.descriptor).not.toHaveProperty('tenantId');
  expect(view.brief).not.toHaveProperty('tenantId');expect(view.brief).not.toHaveProperty('projectId');expect(view).not.toHaveProperty('execution');
  expect(view.source.references).toEqual(f.source.references);expect(view.source.material).toEqual(f.source.material);
  expect(view.task).toEqual({status:'queued',resultState:null,reason:null});expect(JSON.stringify(view)).not.toContain('private provider credential');
  const brief=projectOutlineBrief({brief:f.brief,actorId:'editor',createdAt:f.run.createdAt});expect(brief.brief.digest).toBe(f.brief.digest);expect(brief.actorId).toBe('editor');
  expect(Object.isFrozen(view)).toBe(true);expect(Object.isFrozen(view.source)).toBe(true);
});
it.each(['queued','running','waiting','reconciling'] as const)('prioritizes the original %s journal even when source changed and a candidate was saved',async status=>{
  const f=await generated();expect(projectOutlineStatus(await f.progress(),false,task(f,status))).toMatchObject({state:status,sourceChanged:true,candidateDigest:expect.any(String)});
});
it('keeps human edits and original candidate separate, replays report and preserves historical review when stale',async()=>{
  const f=await generated(),candidate=(await f.progress()).candidate!,edited=structuredClone(candidate.output);edited.adaptation.title='人工修订的停钟之夜';
  await f.store.review(f.key,{candidateDigest:candidate.digest,output:edited,ablations:[{genre:'suspense',judgment:'participates',reason:'明确人工核对查证参与反击。'}],waivers:[]},f.host);
  const view=projectOutlineRun(await f.progress(),false,{...task(f,'succeeded'),output:f.result});expect(view.state).toBe('reviewed');expect(view.sourceChanged).toBe(true);
  expect(view.candidate?.output).toEqual(candidate.output);expect(view.candidate).not.toHaveProperty('model');expect(view.candidate?.report.kind).toBe('craft_review');
  expect(view.review).toMatchObject({status:'reviewed',actorId:f.host.actor.id,at:f.host.at,candidateDigest:candidate.digest,output:{adaptation:{title:edited.adaptation.title}},ablations:[{judgment:'participates'}],waivers:[]});
  expect(view.review).not.toHaveProperty('source');expect(view).not.toHaveProperty('budget');
  expect(projectOutlineStatus(await f.progress(),false,task(f,'running')).state).toBe('running');
});
it('shows rejection without implying approval or replacing the immutable candidate',async()=>{
  const f=await generated();await f.store.reject(f.key,'重做主线。',f.host);const p=await f.progress();
  expect(projectOutlineRun(p,false,null).review).toMatchObject({status:'rejected',reason:'重做主线。',candidateDigest:p.candidate!.digest});expect(projectOutlineStatus(p,false,null).state).toBe('rejected');
});
it('distinguishes no dispatch, business blocked, failed, cancelled and stale without inventing queued work',async()=>{
  const f=await outlineWorkflowFixture(),p=await f.progress();
  expect(projectOutlineStatus(p,true,null).state).toBe('not_dispatched');expect(projectOutlineStatus(p,false,null).state).toBe('stale');
  for(const status of ['failed','cancelled'] as const)expect(projectOutlineStatus(p,false,task(f,status)).state).toBe(status);
  const blocked={...task(f,'succeeded'),output:{state:'blocked',runDigest:f.run.digest,reason:'OUTLINE_SOURCE_CHANGED',charged:{tokens:0,costMicros:0},usageUnknown:false}} as Task;
  expect(projectOutlineStatus(p,false,blocked)).toMatchObject({state:'blocked',task:{reason:'OUTLINE_SOURCE_CHANGED'}});
  for(const reason of ['private credential: secret','UPPERCASE_SECRET_TOKEN'])expect(projectOutlineStatus(p,true,{...blocked,output:{...(blocked.output as object),reason}} as Task).task?.reason).toBeNull();
  expect(()=>projectOutlineStatus(p,true,task(f,'succeeded'))).toThrow('STORAGE_FAILED');
});
it('refuses foreign task/run/output bindings and malformed freshness or progress with redacted errors',async()=>{
  const f=await generated(),p=await f.progress(),t={...task(f,'succeeded'),output:f.result};
  for(const change of [{tenantId:'foreign'},{taskId:'foreign'},{workflow:'foreign'},{version:2},{input:{...outlineTaskReference(f.run),runDigest:'a'.repeat(64)}},
    {output:{state:'candidate',runDigest:f.run.digest,candidateDigest:'a'.repeat(64)}}])expect(()=>projectOutlineRun(p,true,{...t,...change} as Task)).toThrow('STORAGE_FAILED');
  for(const value of [undefined,null,'true',1])expect(()=>projectOutlineStatus(p,value as never,null)).toThrow('STORAGE_FAILED');
  expect(()=>projectOutlineStatus({...p,candidate:null},true,t)).toThrow('STORAGE_FAILED');
  expect(()=>projectOutlineBrief({brief:f.brief,actorId:'bad actor',createdAt:'bad'})).toThrow('STORAGE_FAILED');
});
it('never evaluates accessors on stored progress, selected task fields or unrelated task internals',async()=>{
  const f=await outlineWorkflowFixture(),p=await f.progress(),access=vi.fn(()=>{throw new Error('private secret');});
  expect(()=>projectOutlineRun(Object.defineProperty({...p},'run',{enumerable:true,get:access}),true,null)).toThrow('STORAGE_FAILED');
  expect(()=>projectOutlineRun({...p,run:Object.defineProperty({...p.run},'tenantId',{enumerable:true,get:access})},true,null)).toThrow('STORAGE_FAILED');
  expect(()=>projectOutlineStatus(p,true,Object.defineProperty(task(f),'input',{enumerable:true,get:access}))).toThrow('STORAGE_FAILED');
  expect(access).not.toHaveBeenCalled();
  const internal=Object.defineProperty(task(f),'error',{enumerable:true,get:access});expect(projectOutlineStatus(p,true,internal).state).toBe('queued');expect(access).not.toHaveBeenCalled();
});

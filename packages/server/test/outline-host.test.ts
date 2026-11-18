import { expect,it,vi } from 'vitest';
import type { Task,DurableStore,DurableWorker } from '@camery/durable';
import type { OutlineRun,OutlineCatalogReader } from '@camery/script/outline/node';
import { OUTLINE_WORKFLOW,OUTLINE_WORKFLOW_VERSION,outlineTaskId,outlineTaskReference,createOutlineWorkflow } from '@camery/script/outline/node';
import { OutlineError } from '@camery/script/outline/contracts';
import { outlineWorkflowFixture } from '../../script/test/outline-workflow-support.js';
import { workflowJournal } from '../../script/test/workflow-support.js';
import { createOutlineHost } from '../src/outline-host.js';

function task(run:OutlineRun,status:Task['status']='queued'):Task{
  return {tenantId:run.tenantId,taskId:outlineTaskId({tenantId:run.tenantId,projectId:run.projectId,runId:run.runId}),workflow:OUTLINE_WORKFLOW,version:OUTLINE_WORKFLOW_VERSION,
    input:outlineTaskReference(run),status,maxAttempts:3,availableAt:null,attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null};
}
function summary(run:OutlineRun){return {runId:run.runId,runDigest:run.digest,briefId:run.brief.briefId,briefRevision:run.brief.revision,createdAt:run.createdAt,candidateDigest:null,reviewStatus:null};}
async function fixture(){
  const f=await outlineWorkflowFixture(),scope={tenantId:f.key.tenantId,projectId:f.key.projectId},tasks=new Map([[f.task.taskId,task(f.run)]]);
  const catalog={list:vi.fn<OutlineCatalogReader['list']>(async()=>({items:[summary(f.run)],nextCursor:null})),summary:vi.fn<OutlineCatalogReader['summary']>()};
  const durable={get:vi.fn<DurableStore['get']>(async key=>tasks.get(key.taskId)??null),enqueue:vi.fn<DurableStore['enqueue']>(async input=>{
    const saved:Task={...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null};tasks.set(saved.taskId,saved);return saved;
  })};
  const worker={hasWorkflow:vi.fn((_name:string,_version:number)=>true),runTask:vi.fn<DurableWorker['runTask']>(async()=>null)};
  return {...f,scope,tasks,catalog,durable,worker,options:{scope,workerId:'outline-worker-fixture',store:f.store,catalog,durable,worker,pollMs:50,runsPerRound:1}};
}
it('scans the configured scope and runs only the original deterministic task without provider configuration',async()=>{
  const f=await fixture();expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:0,errors:0});
  expect(f.catalog.list).toHaveBeenCalledExactlyOnceWith(f.scope);expect(f.worker.hasWorkflow).toHaveBeenCalledExactlyOnceWith(OUTLINE_WORKFLOW,1);
  expect(f.worker.runTask).toHaveBeenCalledExactlyOnceWith(f.task,'outline-worker-fixture');expect(f.durable.enqueue).not.toHaveBeenCalled();expect(f.sessionFor).not.toHaveBeenCalled();
});
it.each(['queued','running','waiting'] as const)('delegates actual lease eligibility for %s and counts only a claimed task',async status=>{
  const f=await fixture();f.tasks.set(f.task.taskId,task(f.run,status));f.worker.runTask.mockResolvedValue(task(f.run,'succeeded'));
  expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:1,errors:0});
});
it.each(['reconciling','failed','cancelled','succeeded'] as const)('never executes or replaces the original %s task',async status=>{
  const f=await fixture();f.tasks.set(f.task.taskId,task(f.run,status));
  expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:0,errors:0});expect(f.worker.runTask).not.toHaveBeenCalled();expect(f.durable.enqueue).not.toHaveBeenCalled();
});
it('drains an original queued tail after real candidate persistence, human review and source staleness',async()=>{
  const f=await fixture(),journal=workflowJournal(f.task);await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context());const candidate=(await f.progress()).candidate!;
  await f.store.review(f.key,{candidateDigest:candidate.digest,output:candidate.output,ablations:[{genre:'suspense',judgment:'participates',reason:'明确测试宿主人审核对。'}],waivers:[]},f.host);
  f.db.state.current=false;f.catalog.list.mockResolvedValue({items:[{...summary(f.run),candidateDigest:candidate.digest,reviewStatus:'reviewed'}],nextCursor:null});
  f.worker.runTask.mockResolvedValue(task(f.run,'succeeded'));expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:1,errors:0});
  expect(f.catalog.list.mock.calls[0]![0]).not.toHaveProperty('pendingOnly');expect(f.durable.enqueue).not.toHaveBeenCalled();expect(f.exchange).toHaveBeenCalledOnce();
});
it('carries remaining rows and keyset pages fairly across bounded rounds and resets after a complete scan',async()=>{
  const f=await fixture(),runs=await Promise.all(['run-a','run-b','run-c'].map(runId=>f.store.start({...f.command,runId})));
  f.catalog.list.mockImplementation(async query=>query.cursor==='next'?{items:[summary(runs[2]!)],nextCursor:null}:{items:runs.slice(0,2).map(summary),nextCursor:'next'});
  const host=createOutlineHost(f.options);await host.round();await host.round();expect(f.catalog.list).toHaveBeenCalledTimes(1);await host.round();
  expect(f.catalog.list.mock.calls[1]![0]).toEqual({...f.scope,cursor:'next'});await host.round();await host.round();expect(f.catalog.list.mock.calls[2]![0]).toEqual(f.scope);
  expect(f.worker.runTask.mock.calls.slice(0,3).map(call=>call[0])).toEqual(runs.map(run=>({tenantId:run.tenantId,taskId:task(run).taskId})));
});
it('uses bounded defaults and continues after one run error without leaking its diagnostics',async()=>{
  const f=await fixture(),second=await f.store.start({...f.command,runId:'second'});f.catalog.list.mockResolvedValue({items:[summary(f.run),summary(second)],nextCursor:null});
  f.durable.get.mockRejectedValueOnce(new Error('private database password'));
  const {pollMs:_poll,runsPerRound:_runs,...defaults}=f.options;expect(await createOutlineHost(defaults).round()).toEqual({visited:2,executed:0,errors:1});expect(f.worker.runTask).toHaveBeenCalledOnce();
});
it('visits fresh candidate or stale business outcomes without scheduling another task',async()=>{
  const f=await fixture();f.tasks.clear();f.db.state.current=false;
  expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:0,errors:0});expect(f.durable.enqueue).not.toHaveBeenCalled();expect(f.worker.runTask).not.toHaveBeenCalled();
  f.db.state.current=true;await createOutlineWorkflow(f).run(outlineTaskReference(f.run),workflowJournal(f.task).context());
  expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:0,errors:0});expect(f.durable.enqueue).not.toHaveBeenCalled();
  const candidate=(await f.progress()).candidate!;await f.store.review(f.key,{candidateDigest:candidate.digest,output:candidate.output,ablations:[{genre:'suspense',judgment:'participates',reason:'已核对查证影响主线。'}],waivers:[]},f.host);
  expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:0,errors:0});expect(f.worker.runTask).not.toHaveBeenCalled();
});
it('rejects a foreign dispatcher task and continues without executing or replacing it',async()=>{
  const f=await fixture();f.tasks.set(f.task.taskId,{...task(f.run),tenantId:'other'});
  expect(await createOutlineHost(f.options).round()).toEqual({visited:1,executed:0,errors:1});expect(f.worker.runTask).not.toHaveBeenCalled();expect(f.durable.enqueue).not.toHaveBeenCalled();
});
it('waits for the active attempt before returning on stop and starts no next task',async()=>{
  const f=await fixture(),stop=new AbortController();let enter!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{enter=done;}),active=new Promise<void>(done=>{release=done;});
  f.worker.runTask.mockImplementation(async()=>{enter();await active;return task(f.run,'succeeded');});let finished=false;
  const pending=createOutlineHost(f.options).run(stop.signal).then(value=>{finished=true;return value;});await started;stop.abort();await Promise.resolve();expect(finished).toBe(false);release();
  expect(await pending).toEqual({reason:'stopped',rounds:1,errors:0});expect(f.worker.runTask).toHaveBeenCalledOnce();
});
it('does not dispatch if stopped while reading a page, or enqueue if stopped during source reading',async()=>{
  const f=await fixture(),stop=new AbortController();f.catalog.list.mockImplementation(async()=>{stop.abort();return {items:[summary(f.run)],nextCursor:null};});
  expect(await createOutlineHost(f.options).round(stop.signal)).toEqual({visited:0,executed:0,errors:0});expect(f.durable.get).not.toHaveBeenCalled();
  const second=await fixture(),halt=new AbortController();second.tasks.clear();const read=second.store.read.bind(second.store);
  vi.spyOn(second.store,'read').mockImplementation(async key=>{const result=await read(key);halt.abort();return result;});
  expect(await createOutlineHost(second.options).round(halt.signal)).toEqual({visited:1,executed:0,errors:0});expect(second.durable.enqueue).not.toHaveBeenCalled();expect(second.worker.runTask).not.toHaveBeenCalled();
});
it('handles idle, pre-aborted and timed polling without busy loops',async()=>{
  const f=await fixture(),stop=new AbortController();f.catalog.list.mockResolvedValue({items:[],nextCursor:null});
  const pending=createOutlineHost(f.options).run(stop.signal);await new Promise(done=>setTimeout(done,5));stop.abort();expect(await pending).toEqual({reason:'stopped',rounds:1,errors:0});
  expect(await createOutlineHost(f.options).run(stop.signal)).toEqual({reason:'stopped',rounds:0,errors:0});expect(await createOutlineHost(f.options).round(stop.signal)).toEqual({visited:0,executed:0,errors:0});
  const second=await fixture(),natural=new AbortController();let reads=0;second.catalog.list.mockImplementation(async()=>{if(++reads===2)natural.abort();return {items:[],nextCursor:null};});
  expect(await createOutlineHost(second.options).run(natural.signal)).toEqual({reason:'stopped',rounds:2,errors:0});
});
it('rejects concurrent rounds, malformed or empty continued pages and unavailable workflow registration',async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(done=>{release=done;});f.catalog.list.mockImplementation(async()=>{await gate;return {items:[],nextCursor:null};});
  const host=createOutlineHost(f.options),pending=host.round();await expect(host.round()).rejects.toMatchObject({code:'CONFLICT'});release();await pending;
  f.catalog.list.mockResolvedValue({items:[],nextCursor:'private'});await expect(host.round()).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.catalog.list.mockResolvedValue({items:[{...summary(f.run),runDigest:'bad'}],nextCursor:null});await expect(host.round()).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.worker.hasWorkflow.mockReturnValue(false);expect(()=>createOutlineHost(f.options)).toThrow('workflow unavailable');
});
it('redacts catalog failures and refuses a repeated continuation cursor',async()=>{
  const f=await fixture();f.catalog.list.mockRejectedValue(new Error('private database credential'));await expect(createOutlineHost(f.options).round()).rejects.toThrow('catalog');
  f.catalog.list.mockResolvedValue({items:[summary(f.run)],nextCursor:'same'});const host=createOutlineHost(f.options);await host.round();await expect(host.round()).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('captures host methods before awaits, including class prototype methods',async()=>{
  const f=await fixture();let release!:()=>void;const wait=new Promise<void>(done=>{release=done;});f.catalog.list.mockImplementation(async()=>{await wait;return {items:[summary(f.run)],nextCursor:null};});
  const runTask=f.worker.runTask,read=f.store.read.bind(f.store),get=f.durable.get;
  class Worker{hasWorkflow(){return true;}runTask=runTask;}
  const worker=new Worker(),host=createOutlineHost({...f.options,worker}),pending=host.round();
  worker.runTask=vi.fn<DurableWorker['runTask']>(async()=>{throw new Error('replacement worker');});f.store.read=async()=>{throw new Error('replacement read');};f.durable.get=vi.fn<DurableStore['get']>(async()=>{throw new Error('replacement get');});release();
  expect(await pending).toEqual({visited:1,executed:0,errors:0});expect(runTask).toHaveBeenCalledOnce();expect(get).toHaveBeenCalledOnce();f.store.read=read;
});
it('captures scope, catalog, currentness and enqueue before the first polling await',async()=>{
  const f=await fixture();f.tasks.clear();const original={...f.scope},host=createOutlineHost(f.options),enqueue=f.durable.enqueue,list=f.catalog.list;
  f.options.scope.tenantId='changed';f.catalog.list=vi.fn<OutlineCatalogReader['list']>(async()=>{throw new Error('replacement catalog');});
  f.store.isCurrent=async()=>false;f.durable.enqueue=vi.fn<DurableStore['enqueue']>(async()=>{throw new Error('replacement enqueue');});
  expect(await host.round()).toEqual({visited:1,executed:0,errors:0});expect(list).toHaveBeenCalledExactlyOnceWith(original);expect(enqueue).toHaveBeenCalledOnce();expect(f.worker.runTask).toHaveBeenCalledExactlyOnceWith(f.task,'outline-worker-fixture');
});
it('accepts only literal synchronous workflow registration and redacts forged callback errors',async()=>{
  const f=await fixture();
  for(const value of [undefined,null,1,'true',Promise.resolve(true)]){f.worker.hasWorkflow.mockReturnValue(value as never);expect(()=>createOutlineHost(f.options)).toThrow('workflow unavailable');}
  f.worker.hasWorkflow.mockImplementation(()=>{throw new OutlineError('STORAGE_FAILED','private secret','password');});
  expect(()=>createOutlineHost(f.options)).toThrow('outline host configuration');expect(()=>createOutlineHost(f.options)).not.toThrow('private secret');
});
it('rejects missing or nonfunction capabilities before polling without invoking inherited accessors',async()=>{
  const f=await fixture(),access=vi.fn(()=>{throw new Error('private capability');});
  const inherited=Object.create(Object.defineProperty({},'hasWorkflow',{get:access}));Object.assign(inherited,{runTask:f.worker.runTask});
  for(const change of [{store:{}},{catalog:{list:0}},{durable:{get:f.durable.get,enqueue:null}},{worker:inherited},{scope:{...f.scope,extra:true}}])expect(()=>createOutlineHost({...f.options,...change} as never)).toThrow('INVALID_INPUT');
  expect(access).not.toHaveBeenCalled();expect(f.catalog.list).not.toHaveBeenCalled();
});
it('aggregates only failed run counts over polling rounds and does not publish exception text',async()=>{
  const f=await fixture(),stop=new AbortController();f.options.runsPerRound=20;const read=f.store.read.bind(f.store);
  vi.spyOn(f.store,'read').mockRejectedValueOnce(new Error('private connection string')).mockImplementation(read);
  f.worker.runTask.mockImplementation(async()=>{stop.abort();return null;});
  expect(await createOutlineHost(f.options).run(stop.signal)).toEqual({reason:'stopped',rounds:2,errors:1});
});
it('does not evaluate scope, setting, method or page accessors and rejects invalid settings',async()=>{
  const f=await fixture(),getter=vi.fn(()=>{throw new Error('private');});
  for(const input of [Object.defineProperty({...f.options},'scope',{enumerable:true,get:getter}),{...f.options,scope:Object.defineProperty({...f.scope},'tenantId',{enumerable:true,get:getter})},
    Object.defineProperty({...f.options},'pollMs',{enumerable:true,get:getter}),{...f.options,worker:Object.defineProperty({...f.worker},'runTask',{enumerable:true,get:getter})}])expect(()=>createOutlineHost(input)).toThrow('INVALID_INPUT');
  expect(getter).not.toHaveBeenCalled();
  for(const change of [{pollMs:49},{pollMs:60001},{pollMs:null},{runsPerRound:null},{runsPerRound:0},{runsPerRound:51},{workerId:'bad id'},{scope:{...f.scope,tenantId:'bad tenant'}}])expect(()=>createOutlineHost({...f.options,...change} as never)).toThrow('INVALID_INPUT');
  f.catalog.list.mockResolvedValue(Object.defineProperty({items:[],nextCursor:null},'items',{enumerable:true,get:getter}));await expect(createOutlineHost(f.options).round()).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(getter).not.toHaveBeenCalled();
});

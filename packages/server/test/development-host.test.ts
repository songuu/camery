import { expect,it,vi,beforeEach } from 'vitest';
import type { DevelopmentCatalogReader,DevelopmentStore } from '@camery/script/node';
import type { DurableStore,Task,TaskStatus } from '@camery/durable';
const dispatch=vi.hoisted(()=>vi.fn());
vi.mock('@camery/script/node',async importOriginal=>({...await importOriginal<typeof import('@camery/script/node')>(),enqueueNextDevelopmentTask:dispatch}));
import { createDevelopmentHost } from '../src/development-host.js';

const scope={tenantId:'tenant-a',projectId:'project-a'};
function fixture(){
  const summary=(runId:string)=>({runId,briefId:'idea',briefRevision:1,createdAt:'2026-11-16T10:00:00.000Z',sourceChanged:false,
    foundationCandidateDigest:null,foundationReviewStatus:null,episodesCandidateDigest:null,episodesReviewStatus:null});
  const catalog={list:vi.fn<DevelopmentCatalogReader['list']>(async()=>({items:[summary('run-a')],nextCursor:null})),summary:vi.fn()};
  const store:DevelopmentStore={putBrief:vi.fn(),getBrief:vi.fn(),start:vi.fn(),fork:vi.fn(),read:vi.fn(),isCurrent:vi.fn(),saveCandidate:vi.fn(),review:vi.fn(),reject:vi.fn()};
  const durable={enqueue:vi.fn<DurableStore['enqueue']>(),get:vi.fn<DurableStore['get']>()};
  const worker={hasWorkflow:vi.fn((_name:string,_version:number)=>true),runTask:vi.fn(async():Promise<Task|null>=>null)};
  return {summary,options:{scope,workerId:'worker-a',catalog,store,durable,worker,pollMs:50,runsPerRound:1}};
}
beforeEach(()=>{dispatch.mockReset();dispatch.mockResolvedValue({state:'task',stage:'foundation',task:{tenantId:scope.tenantId,taskId:'original-fixture',status:'queued'}});});
it('scans all scoped runs and executes only the exact deterministic dispatcher task',async()=>{
  const f=fixture();expect(await createDevelopmentHost(f.options).round()).toEqual({visited:1,executed:0,errors:0});
  expect(f.options.catalog.list).toHaveBeenCalledExactlyOnceWith(scope);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(f.options.store,f.options.durable,{...scope,runId:'run-a'});
  expect(f.options.worker.runTask).toHaveBeenCalledExactlyOnceWith({tenantId:scope.tenantId,taskId:'original-fixture'},'worker-a');
});
it('requires both historical and redo workflow versions before polling any run',()=>{
  const f=fixture();createDevelopmentHost(f.options);expect(f.options.worker.hasWorkflow.mock.calls).toEqual([['original.development-stage',1],['original.development-stage',2]]);
  f.options.worker.hasWorkflow.mockImplementation((_name:string,version:number)=>version===1);expect(()=>createDevelopmentHost(f.options)).toThrow('development host workflow unavailable');expect(f.options.catalog.list).not.toHaveBeenCalled();
});
it('uses bounded defaults and carries rows and keyset pages fairly across rounds',async()=>{
  const f=fixture();f.options.catalog.list.mockImplementation(async input=>input.cursor==='second'?{items:[f.summary('run-c')],nextCursor:null}:{items:[f.summary('run-a'),f.summary('run-b')],nextCursor:'second'});
  const host=createDevelopmentHost(f.options);await host.round();await host.round();expect(f.options.catalog.list).toHaveBeenCalledTimes(1);
  await host.round();expect(f.options.catalog.list.mock.calls[1]![0]).toEqual({...scope,cursor:'second'});await host.round();await host.round();
  expect(f.options.catalog.list.mock.calls[2]![0]).toEqual(scope);
  const {pollMs:_poll,runsPerRound:_runs,...defaults}=fixture().options;expect(await createDevelopmentHost(defaults).round()).toMatchObject({visited:1});
});
it.each(['queued','running','waiting'] as TaskStatus[])('delegates lease eligibility for %s tasks and counts actual claims only',async status=>{
  const f=fixture();dispatch.mockResolvedValue({state:'task',stage:'episodes',task:{tenantId:scope.tenantId,taskId:'original-fixture',status}});
  f.options.worker.runTask.mockResolvedValue({status:'succeeded'} as Task);expect(await createDevelopmentHost(f.options).round()).toEqual({visited:1,executed:1,errors:0});
});
it.each(['reconciling','succeeded','failed','cancelled'] as TaskStatus[])('never executes or replaces unknown/terminal %s work',async status=>{
  const f=fixture();dispatch.mockResolvedValue({state:'task',stage:'foundation',task:{tenantId:scope.tenantId,taskId:'original-fixture',status}});
  expect(await createDevelopmentHost(f.options).round()).toEqual({visited:1,executed:0,errors:0});expect(f.options.worker.runTask).not.toHaveBeenCalled();expect(f.options.durable.enqueue).not.toHaveBeenCalled();
});
it('visits reviewed or stale summaries so the dispatcher can drain already paid task tails',async()=>{
  const f=fixture();f.options.catalog.list.mockResolvedValue({items:[{...f.summary('run-a'),sourceChanged:true,foundationReviewStatus:'reviewed',episodesReviewStatus:'reviewed'}],nextCursor:null});
  f.options.worker.runTask.mockResolvedValue({status:'succeeded'} as Task);expect(await createDevelopmentHost(f.options).round()).toEqual({visited:1,executed:1,errors:0});
  expect(dispatch).toHaveBeenCalledOnce();expect(f.options.catalog.list.mock.calls[0]![0]).not.toHaveProperty('pendingOnly');
});
it('continues after a failed run and does not execute business waiting/reviewed/stale outcomes',async()=>{
  const f=fixture();f.options.runsPerRound=4;f.options.catalog.list.mockResolvedValue({items:['a','b','c','d'].map(f.summary),nextCursor:null});
  dispatch.mockRejectedValueOnce(new Error('private')).mockResolvedValueOnce({state:'awaiting_review'}).mockResolvedValueOnce({state:'reviewed'}).mockResolvedValueOnce({state:'stale'});
  expect(await createDevelopmentHost(f.options).round()).toEqual({visited:4,executed:0,errors:1});expect(f.options.worker.runTask).not.toHaveBeenCalled();
});
it('waits for its active attempt before stopping and starts no further task after abort',async()=>{
  const f=fixture();const controller=new AbortController();let entered!:()=>void;let release!:()=>void;const started=new Promise<void>(done=>{entered=done;});const active=new Promise<void>(done=>{release=done;});
  f.options.worker.runTask.mockImplementation(async()=>{entered();await active;return {status:'succeeded'} as Task;});let finished=false;
  const pending=createDevelopmentHost(f.options).run(controller.signal).then(value=>{finished=true;return value;});await started;controller.abort();await Promise.resolve();expect(finished).toBe(false);release();
  expect(await pending).toEqual({reason:'stopped',rounds:1,errors:0});expect(f.options.worker.runTask).toHaveBeenCalledOnce();
  const second=fixture();const halt=new AbortController();dispatch.mockImplementation(async()=>{halt.abort();return {state:'task',stage:'foundation',task:{status:'queued'}};});
  await createDevelopmentHost(second.options).round(halt.signal);expect(second.options.worker.runTask).not.toHaveBeenCalled();
});
it('handles idle, natural and pre-aborted polling without a busy loop',async()=>{
  const f=fixture();const controller=new AbortController();let reads=0;f.options.catalog.list.mockImplementation(async()=>{if(++reads===2)controller.abort();return {items:[],nextCursor:null};});
  expect(await createDevelopmentHost(f.options).run(controller.signal)).toEqual({reason:'stopped',rounds:2,errors:0});expect(await createDevelopmentHost(f.options).run(controller.signal)).toEqual({reason:'stopped',rounds:0,errors:0});
  expect(await createDevelopmentHost(f.options).round(controller.signal)).toEqual({visited:0,executed:0,errors:0});
  const second=fixture();const idle=new AbortController();second.options.catalog.list.mockResolvedValue({items:[],nextCursor:null});const pending=createDevelopmentHost(second.options).run(idle.signal);await new Promise(done=>setTimeout(done,5));idle.abort();await pending;
});
it('rejects concurrent rounds, malformed metadata, and missing workflow registration',async()=>{
  const f=fixture();let release!:()=>void;const wait=new Promise<void>(done=>{release=done;});f.options.catalog.list.mockImplementation(async()=>{await wait;return {items:[],nextCursor:null};});
  const host=createDevelopmentHost(f.options);const pending=host.round();await expect(host.round()).rejects.toMatchObject({code:'CONFLICT'});release();await pending;
  f.options.catalog.list.mockResolvedValue({items:[],nextCursor:'bad'});await expect(host.round()).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.options.worker.hasWorkflow.mockReturnValue(false);expect(()=>createDevelopmentHost(f.options)).toThrow('development host workflow unavailable');
});

import {expect,it,vi} from 'vitest';
import type {Task,Step} from '@camery/durable';
import {stepIdempotencyKey} from '@camery/durable';
import {generateFoundation,generateEpisodes,createEpisodeCandidate} from '../src/development.js';
import {reviewFoundation} from '../src/review.js';
import {DevelopmentError} from '../src/contracts.js';
import {developmentRunDigest,developmentStageTaskId,developmentStageCallId,StartForkSchema} from '../src/node/contracts.js';
import type {DevelopmentProgress} from '../src/node/contracts.js';
import {inspectDevelopmentRedo,startDevelopmentRedo} from '../src/node/redo.js';
import {workflowFixture} from './workflow-support.js';
async function fixture(){
  const f=workflowFixture();const candidate=await generateFoundation({...f,method:f.foundationMethod,context:f.context(stepIdempotencyKey({tenantId:f.key.tenantId,taskId:developmentStageTaskId(f.key,'foundation')},'agent.0.decision'))});
  const review=reviewFoundation(f.brief,candidate,{candidateDigest:candidate.digest,output:candidate.output},f.host);Object.assign(f.progress.foundation,{candidate,review});
  const episodes=await generateEpisodes({...f,foundation:review,method:f.episodeMethod,context:f.context(stepIdempotencyKey({tenantId:f.key.tenantId,taskId:developmentStageTaskId(f.key,'episodes')},'agent.0.decision'))});Object.assign(f.progress.episodes,{candidate:episodes});
  const rows=new Map<string,Task>();for(const stage of ['foundation','episodes'] as const){const taskId=developmentStageTaskId(f.key,stage);rows.set(taskId,{tenantId:f.key.tenantId,taskId,workflow:'original.development-stage',version:1,input:{projectId:f.key.projectId,runId:f.key.runId,stage,runDigest:f.run.digest,upstreamDigest:stage==='foundation'?null:review.digest},maxAttempts:3,availableAt:null,status:'succeeded',attempts:1,fence:1,owner:null,leaseUntil:null,output:null,error:null});}
  const steps:Step[]=[{key:'agent.0.decision',position:2,kind:'external',status:'completed',fingerprint:'a'.repeat(64),idempotencyKey:'fixture-key',input:null,output:null,error:null,dueAt:null}];
  const tasks={get:vi.fn(async(key:{tenantId:string;taskId:string})=>rows.get(key.taskId)??null),steps:vi.fn(async(key:{tenantId:string;taskId:string})=>steps.map(step=>({...step,idempotencyKey:stepIdempotencyKey(key,step.key)}))),enqueue:vi.fn(async(input)=>{const task={...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null} as Task;rows.set(task.taskId,task);return task;})};
  let child:DevelopmentProgress|undefined;vi.mocked(f.store.read).mockImplementation(async key=>{if(key.runId===f.run.runId)return f.progress;if(child&&key.runId===child.run.runId)return child;throw new DevelopmentError('NOT_FOUND','fixture child');});
  vi.mocked(f.store.fork).mockImplementation(async input=>{const command=StartForkSchema.parse(input);if(child)return child.run;const origin={version:1 as const,stage:'episodes' as const,sourceRunId:f.run.runId,sourceRunDigest:f.run.digest,actorId:command.actorId,foundation:{runId:f.run.runId,runDigest:f.run.digest,candidateDigest:candidate.digest,reviewDigest:review.digest,execution:f.run.execution}};const raw={...f.run,runId:command.runId,origin,execution:command.execution};const run={...raw,digest:developmentRunDigest(raw)};child={run,foundation:{candidate,review},episodes:{candidate:null,review:null}};return run;});
  const preset={methods:f.run.methods,execution:f.run.execution,label:'当前文本模型'};const command={runId:'child',expectedSourceRunDigest:f.run.digest,expectedBriefDigest:f.brief.digest,expectedFoundationReviewDigest:review.digest};
  return {...f,tasks,rows,steps,preset,command,options:{store:f.store,tasks},child:()=>child};
}
it('exposes full vs one-stage budgets and creates only the new episodes task from a trusted source',async()=>{
  const f=await fixture();const options=await inspectDevelopmentRedo(f.options,f.key,f.preset);expect(options.foundation.budget?.tokens).toBe(200);expect(options.episodes.budget?.tokens).toBe(100);expect(options.episodes.canRedo).toBe(true);
  const run=await startDevelopmentRedo(f.options,{source:f.key,stage:'episodes',command:f.command,actorId:'human',preset:f.preset});expect(run.runId).toBe('child');expect(f.store.fork).toHaveBeenCalledOnce();expect(f.tasks.enqueue).toHaveBeenCalledOnce();
  expect(f.tasks.enqueue.mock.calls[0]![0]).toMatchObject({version:2,input:{stage:'episodes'}});expect(run.execution.limits.tokens).toBe(100);expect(f.child()!.foundation.review).toEqual(f.progress.foundation.review);
});
it.each(['running','waiting','reconciling','cancelled-unknown'] as const)('refuses %s original effects instead of hiding them behind a new run',async state=>{
  const f=await fixture();const original=f.rows.get(developmentStageTaskId(f.key,'episodes'))!;original.status=state==='cancelled-unknown'?'cancelled':state;if(state==='cancelled-unknown')f.steps[0]!.status='unknown';
  const view=await inspectDevelopmentRedo(f.options,f.key,f.preset);expect(view.episodes.canRedo).toBe(false);expect(view.episodes.reason).toBe(state==='reconciling'||state==='cancelled-unknown'?'UNKNOWN_RESULT':'RUN_IN_PROGRESS');
  await expect(startDevelopmentRedo(f.options,{source:f.key,stage:'episodes',command:f.command,actorId:'human',preset:f.preset})).rejects.toMatchObject({code:'CONFLICT'});expect(f.store.fork).not.toHaveBeenCalled();expect(f.tasks.enqueue).not.toHaveBeenCalled();
});
it('recovers an existing semantic branch before freshness/unknown gates and preserves its original task',async()=>{
  const f=await fixture();const input={source:f.key,stage:'episodes' as const,command:f.command,actorId:'human',preset:f.preset};const first=await startDevelopmentRedo(f.options,input);
  vi.mocked(f.store.isCurrent).mockResolvedValue(false);f.rows.get(developmentStageTaskId(f.key,'episodes'))!.status='reconciling';const second=await startDevelopmentRedo(f.options,input);expect(second).toEqual(first);expect(f.tasks.enqueue).toHaveBeenCalledOnce();
});
it('exposes disabled budgets without a model while retaining physical and freshness reasons',async()=>{
  const f=await fixture();const absent=await inspectDevelopmentRedo(f.options,f.key,null);expect(absent).toMatchObject({modelLabel:null,foundation:{canRedo:false,reason:'MODEL_UNAVAILABLE',budget:null},episodes:{canRedo:false,reason:'MODEL_UNAVAILABLE',budget:null}});
  vi.mocked(f.store.isCurrent).mockResolvedValue(false);expect((await inspectDevelopmentRedo(f.options,f.key,f.preset)).episodes.reason).toBe('BRIEF_CHANGED');
  await expect(startDevelopmentRedo(f.options,{source:f.key,stage:'episodes',command:f.command,actorId:'human',preset:f.preset})).rejects.toMatchObject({code:'CONFLICT'});expect(f.store.fork).not.toHaveBeenCalled();
});
it('keeps incomplete physical stages distinct from an unreviewed foundation',async()=>{
  const f=await fixture();const foundationTask=developmentStageTaskId(f.key,'foundation');const episodesTask=developmentStageTaskId(f.key,'episodes');
  const original=f.rows.get(foundationTask)!;f.rows.delete(foundationTask);expect((await inspectDevelopmentRedo(f.options,f.key,f.preset)).foundation.reason).toBe('STAGE_NOT_FINISHED');f.rows.set(foundationTask,original);
  f.rows.delete(episodesTask);expect((await inspectDevelopmentRedo(f.options,f.key,f.preset)).foundation.reason).toBe('STAGE_NOT_FINISHED');
  Object.assign(f.progress.foundation,{review:null});Object.assign(f.progress.episodes,{candidate:null});const view=await inspectDevelopmentRedo(f.options,f.key,f.preset);expect(view.foundation.canRedo).toBe(true);expect(view.episodes.reason).toBe('UPSTREAM_NOT_REVIEWED');
});
it.each(['tenant','id','workflow','version','input','status','upstream'] as const)('rejects corrupt physical %s bindings before creating a branch',async kind=>{
  const f=await fixture();const task=f.rows.get(developmentStageTaskId(f.key,'episodes'))!;
  if(kind==='tenant')task.tenantId='other';if(kind==='id')task.taskId='other';if(kind==='workflow')task.workflow='other';if(kind==='version')task.version=2;if(kind==='input')task.input={foreign:true};if(kind==='status')Object.assign(task,{status:'foreign'});if(kind==='upstream')Object.assign(f.progress.foundation,{review:null});
  await expect(inspectDevelopmentRedo(f.options,f.key,f.preset)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.store.fork).not.toHaveBeenCalled();
});
it.each(['duplicate','wrong-idempotency','invalid-kind','oversized','not-array'] as const)('rejects corrupt %s step evidence without enabling a replacement',async kind=>{
  const f=await fixture();const original=f.tasks.steps.getMockImplementation()!;
  f.tasks.steps.mockImplementation(async key=>{const records=await original(key);if(kind==='duplicate')return [...records,...records];if(kind==='wrong-idempotency')return records.map(step=>({...step,idempotencyKey:'foreign'}));if(kind==='invalid-kind')return records.map(step=>({...step,kind:'foreign'})) as never;if(kind==='oversized')return Array.from({length:65},()=>records[0]!);return {} as never;});
  await expect(inspectDevelopmentRedo(f.options,f.key,f.preset)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.store.fork).not.toHaveBeenCalled();
});
it('blocks terminal tasks whose external effect is still running',async()=>{
  const f=await fixture();f.rows.get(developmentStageTaskId(f.key,'episodes'))!.status='cancelled';f.steps[0]!.status='running';expect((await inspectDevelopmentRedo(f.options,f.key,f.preset)).episodes.reason).toBe('UNKNOWN_RESULT');
});
it('captures command identity before asynchronous source reads and rejects mismatched source references',async()=>{
  const f=await fixture();const request={source:f.key,stage:'episodes' as const,command:{...f.command},actorId:'human',preset:f.preset};
  const started=startDevelopmentRedo(f.options,request);request.command.runId='late-mutation';request.actorId='other';const result=await started;expect(result.runId).toBe('child');expect(result.origin?.actorId).toBe('human');
  for(const command of [{...f.command,runId:f.key.runId},{...f.command,expectedSourceRunDigest:'b'.repeat(64)},{...f.command,expectedBriefDigest:'b'.repeat(64)},{...f.command,expectedFoundationReviewDigest:null}])await expect(startDevelopmentRedo(f.options,{source:f.key,stage:'episodes',command,actorId:'human',preset:f.preset})).rejects.toMatchObject({code:command.runId===f.key.runId?'INVALID_INPUT':'CONFLICT'});
});
it('refuses nonboolean freshness, unavailable child storage and substituted fork lineage',async()=>{
  const f=await fixture();vi.mocked(f.store.isCurrent).mockResolvedValue('true' as never);await expect(inspectDevelopmentRedo(f.options,f.key,f.preset)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const original=vi.mocked(f.store.read).getMockImplementation()!;vi.mocked(f.store.read).mockImplementation(async key=>{if(key.runId==='child')throw new DevelopmentError('STORAGE_FAILED','private child failure');return original(key);});
  await expect(startDevelopmentRedo(f.options,{source:f.key,stage:'episodes',command:f.command,actorId:'human',preset:f.preset})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.store.fork).not.toHaveBeenCalled();
  vi.mocked(f.store.read).mockImplementation(original);vi.mocked(f.store.isCurrent).mockResolvedValue(true);const fork=vi.mocked(f.store.fork).getMockImplementation()!;vi.mocked(f.store.fork).mockImplementation(async input=>{const run=await fork(input);const origin={...run.origin!,actorId:'substituted'};const fields={...run,origin};return {...fields,digest:developmentRunDigest(fields)};});
  await expect(startDevelopmentRedo(f.options,{source:f.key,stage:'episodes',command:f.command,actorId:'human',preset:f.preset})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.tasks.enqueue).not.toHaveBeenCalled();
});
it('inspects a repeated episodes branch using the original foundation Task and its own newer episodes Task',async()=>{
  const f=await fixture();const run=await startDevelopmentRedo(f.options,{source:f.key,stage:'episodes',command:f.command,actorId:'human',preset:f.preset});const key={...f.key,runId:run.runId};const child=f.child()!;
  expect((await inspectDevelopmentRedo(f.options,key,f.preset)).episodes.reason).toBe('RUN_IN_PROGRESS');
  f.rows.get(developmentStageTaskId(key,'episodes'))!.status='succeeded';Object.assign(child.episodes,{candidate:createEpisodeCandidate(run.brief,child.foundation.review as Parameters<typeof createEpisodeCandidate>[1],f.progress.episodes.candidate!.output,{...f.progress.episodes.candidate!.model,callId:developmentStageCallId(key,'episodes')})});
  f.tasks.get.mockClear();expect((await inspectDevelopmentRedo(f.options,key,f.preset)).episodes.canRedo).toBe(true);expect(f.tasks.get).toHaveBeenCalledWith({tenantId:f.key.tenantId,taskId:developmentStageTaskId(f.key,'foundation')});expect(f.tasks.get).not.toHaveBeenCalledWith({tenantId:f.key.tenantId,taskId:developmentStageTaskId(key,'foundation')});
});

import {expect,it,vi} from 'vitest';
import type {DurableStore,Task} from '@camery/durable';
import {ModelSession} from '@camery/methods';
import {OpenAiCompatibleLlm} from '@camery/model-modes';
import {developmentRunDigest,developmentStageTaskId,episodeExecutionFromFull} from '../src/node/contracts.js';
import {createDevelopmentStageWorkflow,createDevelopmentRedoWorkflow,enqueueNextDevelopmentTask} from '../src/node/workflow.js';
import {workflowFixture,workflowJournal} from './workflow-support.js';

function queue(){
  const rows=new Map<string,Task>();return {rows,get:vi.fn<DurableStore['get']>(async key=>rows.get(key.taskId)??null),enqueue:vi.fn<DurableStore['enqueue']>(async input=>{
    const task:Task={...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null};rows.set(task.taskId,task);return task;
  })};
}
async function fixture(stage:'foundation'|'episodes'='episodes'){
  const f=workflowFixture();const sourceQueue=queue();const first=await enqueueNextDevelopmentTask(f.store,sourceQueue,f.key);if(first.state!=='task')throw new Error('Expected source task');
  await createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(first.task.input,workflowJournal(first.task).context());
  await f.store.review(f.key,'foundation',{candidateDigest:f.progress.foundation.candidate!.digest,output:{...f.progress.foundation.candidate!.output,title:'保留原审核标题'}},f.host);
  const source=structuredClone(f.progress);const full={...source.run.execution,connectionId:'replacement',modeDigest:'b'.repeat(64),modelIdentity:'replacement-model'};
  const origin=stage==='episodes'?{version:1 as const,stage,sourceRunId:source.run.runId,sourceRunDigest:source.run.digest,actorId:'redo-human',foundation:{runId:source.run.runId,runDigest:source.run.digest,candidateDigest:source.foundation.candidate!.digest,reviewDigest:source.foundation.review!.digest,execution:source.run.execution}}:
    {version:1 as const,stage,sourceRunId:source.run.runId,sourceRunDigest:source.run.digest,actorId:'redo-human',foundation:null};
  const fields={...source.run,runId:'redo',origin,execution:stage==='episodes'?episodeExecutionFromFull(full):full};Object.assign(f.run,{...fields,digest:developmentRunDigest(fields)});
  if(stage==='foundation')Object.assign(f.progress.foundation,{candidate:null,review:null});
  const key={...f.key,runId:f.run.runId};const durable=queue();f.exchange.mockClear();f.allocate.mockClear();f.sessionFor.mockClear();
  const sessionFor=vi.fn(async()=>new ModelSession(new OpenAiCompatibleLlm({exchange:f.exchange},{model:'replacement-model',structuredOutput:'json_schema'}),{
    tenantId:key.tenantId,connectionId:full.connectionId,modeDigest:full.modeDigest,modelIdentity:full.modelIdentity,evidence:full.evidence,maxCalls:1,timeoutMs:1000,
  }));
  return {...f,key,source,durable,sessionFor,workflow:createDevelopmentRedoWorkflow({store:f.store,ledger:f.ledger,sessionFor})};
}
it('runs only new episodes with the new profile while preserving the real foundation receipt and edited review',async()=>{
  const f=await fixture();const next=await enqueueNextDevelopmentTask(f.store,f.durable,f.key);if(next.state!=='task')throw new Error('Expected redo task');
  expect(next.task).toMatchObject({version:2,input:{stage:'episodes',upstreamDigest:f.source.foundation.review!.digest}});expect(f.durable.rows.has(developmentStageTaskId(f.key,'foundation'))).toBe(false);
  expect(await f.workflow.run(next.task.input,workflowJournal(next.task).context())).toMatchObject({state:'candidate',stage:'episodes'});
  expect(f.exchange).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();expect(f.allocate.mock.calls[0]![0].budget).toMatchObject({maxSteps:1,maxTokens:100});
  expect(f.progress.foundation).toEqual(f.source.foundation);expect(f.progress.episodes.candidate!.model).toMatchObject({connectionId:'replacement',modelIdentity:'replacement-model'});
  const messages=(f.exchange.mock.calls[0]![0].body as {messages:{content:string}[]}).messages;expect(JSON.parse(messages.at(-1)!.content).untrustedSource.foundation.title).toBe('保留原审核标题');
});
it('replays the same v2 paid decision and persistence tail after a lost commit acknowledgement and a changed brief',async()=>{
  const f=await fixture();const next=await enqueueNextDevelopmentTask(f.store,f.durable,f.key);if(next.state!=='task')throw new Error();const journal=workflowJournal(next.task);
  const save=vi.mocked(f.store.saveCandidate).getMockImplementation()!;vi.mocked(f.store.saveCandidate).mockImplementationOnce(async(...args)=>{await save(...args);throw new Error('committed acknowledgement lost');});
  await expect(f.workflow.run(next.task.input,journal.context())).rejects.toThrow('acknowledgement');vi.mocked(f.store.isCurrent).mockResolvedValue(false);f.sessionFor.mockRejectedValue(new Error('old credentials removed'));
  expect(await enqueueNextDevelopmentTask(f.store,f.durable,f.key)).toMatchObject({state:'task',task:{taskId:next.task.taskId}});
  expect(await f.workflow.run(next.task.input,journal.context())).toMatchObject({state:'candidate'});expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect(journal.cache.has('original.persist-stage')).toBe(true);
});
it('uses v2 foundation redo as a fresh two-stage plan without inheriting a review',async()=>{
  const f=await fixture('foundation');const next=await enqueueNextDevelopmentTask(f.store,f.durable,f.key);if(next.state!=='task')throw new Error();expect(next.task).toMatchObject({version:2,input:{stage:'foundation',upstreamDigest:null}});
  await f.workflow.run(next.task.input,workflowJournal(next.task).context());expect(f.progress.foundation.review).toBeNull();expect(f.exchange).toHaveBeenCalledOnce();Object.assign(next.task,{status:'succeeded'});
  expect(await enqueueNextDevelopmentTask(f.store,f.durable,f.key)).toMatchObject({state:'awaiting_review',stage:'foundation'});expect(f.durable.enqueue).toHaveBeenCalledOnce();
});
it('rejects routing a v2 run through the v1 workflow before any allocation or model call',async()=>{
  const f=await fixture();const next=await enqueueNextDevelopmentTask(f.store,f.durable,f.key);if(next.state!=='task')throw new Error();
  await expect(createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(next.task.input,workflowJournal(next.task).context())).rejects.toThrow('stage workflow version');expect(f.allocate).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
});
it('refuses either a fabricated inherited foundation task or an attempt to execute one',async()=>{
  const f=await fixture();const taskId=developmentStageTaskId(f.key,'foundation');const input={projectId:f.key.projectId,runId:f.key.runId,stage:'foundation',runDigest:f.run.digest,upstreamDigest:null};
  const task:Task={tenantId:f.key.tenantId,taskId,workflow:f.workflow.name,version:2,input,maxAttempts:3,availableAt:null,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null};f.durable.rows.set(taskId,task);
  await expect(enqueueNextDevelopmentTask(f.store,f.durable,f.key)).rejects.toThrow('inherited foundation task');await expect(f.workflow.run(input,workflowJournal(task).context())).rejects.toThrow('inherited foundation execution');expect(f.allocate).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
});

import { expect, it, vi } from 'vitest';
import type { Task, DurableStore } from '@camery/durable';
import { ModelError } from '@camery/model-modes';
import { createBibleChunkWorkflow, enqueueNextBibleTask, bibleChunkTaskId } from '../src/node/workflow.js';
import { executionForChunks } from '../src/node/contracts.js';
import { hash } from '../src/data.js';
import { workflowFixture, workflowJournal } from './workflow-support.js';
const dispatcher=()=>({enqueue:vi.fn<DurableStore['enqueue']>(async input=>({...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null}))});
it('uses one pinned model decision, budget share and durable identity per chunk and replays without a second call',async()=>{
  const x=workflowFixture();const durable=dispatcher();const queued=await enqueueNextBibleTask(x.store,durable,x.key);expect(queued.state).toBe('task');
  if(queued.state!=='task')throw new Error('Expected task');
  expect(Buffer.byteLength(JSON.stringify(queued.task.input))).toBeLessThan(1024);expect(JSON.stringify(queued.task.input)).not.toContain(x.source.document.text);
  expect(queued.task.taskId).toBe(bibleChunkTaskId(x.key,x.run.plan.chunks[0]!.id));
  const journal=workflowJournal(queued.task); const workflow=createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:x.sessionFor});
  const result=await workflow.run(queued.task.input,journal.context);expect(result).toMatchObject({state:'candidate',chunkId:x.run.plan.chunks[0]!.id});
  expect(x.exchange).toHaveBeenCalledOnce();expect(x.allocate).toHaveBeenCalledOnce();expect(x.allocate.mock.calls[0]![0].budget).toEqual({maxSteps:1,maxTokens:100,maxCostMicros:0,currency:'CNY'});
  expect(x.progress.records[0]!.model.usage).toEqual({inputTokens:15,outputTokens:8});
  vi.mocked(x.store.isCurrent).mockResolvedValue(false);
  expect(await workflow.run(queued.task.input,journal.context)).toEqual(result);expect(x.exchange).toHaveBeenCalledOnce();expect(x.allocate).toHaveBeenCalledOnce();
  vi.mocked(x.store.isCurrent).mockResolvedValue(true);
  const second=await enqueueNextBibleTask(x.store,durable,x.key);expect(second.state).toBe('task');if(second.state!=='task')throw new Error('Expected next');
  expect(second.task.taskId).not.toBe(queued.task.taskId);
  await workflow.run(second.task.input,workflowJournal(second.task).context);expect(x.exchange).toHaveBeenCalledTimes(2);
  const ready=await enqueueNextBibleTask(x.store,durable,x.key);expect(ready).toMatchObject({state:'ready',candidateDigest:x.progress.candidate!.digest});
});
it('does not queue work for a reviewed or stale run',async()=>{
  const x=workflowFixture();const durable=dispatcher();vi.mocked(x.store.isCurrent).mockResolvedValue(false);
  expect((await enqueueNextBibleTask(x.store,durable,x.key)).state).toBe('stale');expect(durable.enqueue).not.toHaveBeenCalled();
  Object.assign(x.progress,{review:{status:'rejected'}});expect((await enqueueNextBibleTask(x.store,durable,x.key)).state).toBe('reviewed');expect(durable.enqueue).not.toHaveBeenCalled();
});
it('keeps the same task when an earlier chunk has not saved a record',async()=>{
  const x=workflowFixture();const durable=dispatcher();const first=await enqueueNextBibleTask(x.store,durable,x.key);const next=await enqueueNextBibleTask(x.store,durable,x.key);
  expect(next).toEqual(first);expect(durable.enqueue.mock.calls[0]).toEqual(durable.enqueue.mock.calls[1]);
});
it('recovers a saved record acknowledgement loss without repeating the provider or allocation',async()=>{
  const x=workflowFixture();const queued=await enqueueNextBibleTask(x.store,dispatcher(),x.key);if(queued.state!=='task')throw new Error('Expected task');
  let first=true;vi.mocked(x.store.saveChunk).mockImplementation(async(_key,record)=>{
    if(!x.progress.records.length)Object.assign(x.progress,{records:[record]});if(first){first=false;throw new Error('synthetic after commit');}return record;});
  const workflow=createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:x.sessionFor});const journal=workflowJournal(queued.task);
  await expect(workflow.run(queued.task.input,journal.context)).rejects.toThrow('synthetic');expect(x.progress.records).toHaveLength(1);
  expect(await workflow.run(queued.task.input,journal.context)).toMatchObject({state:'candidate'});expect(x.exchange).toHaveBeenCalledOnce();expect(x.allocate).toHaveBeenCalledOnce();
});
it('does not resend unknown provider work and never treats a blocked result as an extracted chunk',async()=>{
  const x=workflowFixture();Object.assign(x.run.execution,{evidence:'live_model'});x.run.execution.reservation.costMicros=10;x.run.execution.limits.costMicros=x.run.plan.chunks.length*10;
  // Recompute the trusted configuration fingerprint after preparing this separate live-protocol fixture.
  const {bibleRunDigest}=await import('../src/node/contracts.js');Object.assign(x.run,{digest:bibleRunDigest(x.run.plan,x.run.method,x.run.execution)});
  x.exchange.mockRejectedValue(new ModelError('NETWORK_FAILED','fixture','unknown'));
  const queued=await enqueueNextBibleTask(x.store,dispatcher(),x.key);if(queued.state!=='task')throw new Error('Expected task');
  const workflow=createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:x.sessionFor});await expect(workflow.run(queued.task.input,workflowJournal(queued.task).context)).rejects.toMatchObject({code:'AGENT_EXTERNAL_UNKNOWN'});
  expect(x.exchange).toHaveBeenCalledOnce();expect(x.progress.records).toEqual([]);
});
it.each(['stale','unavailable','quote'] as const)('blocks %s before producing a record',async kind=>{
  const x=workflowFixture();const queued=await enqueueNextBibleTask(x.store,dispatcher(),x.key);if(queued.state!=='task')throw new Error('Expected task');
  if(kind==='stale')vi.mocked(x.store.isCurrent).mockResolvedValue(false);if(kind==='unavailable')vi.mocked(x.store.isCurrent).mockRejectedValue(new Error('private DSN'));
  if(kind==='quote')x.exchange.mockImplementation(async()=>({status:200,contentType:'application/json',body:{kind:'json',value:{id:'overquote',choices:[{finish_reason:'stop',message:{role:'assistant',content:'{"entities":[],"relations":[],"claims":[]}'}}],usage:{prompt_tokens:101,completion_tokens:1}}}}));
  const result=await createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:x.sessionFor}).run(queued.task.input,workflowJournal(queued.task).context);
  expect(result).toMatchObject({state:'blocked'});expect(x.progress.records).toEqual([]);expect(x.exchange).toHaveBeenCalledTimes(kind==='quote'?1:0);
});
it.each(['task','digest','source','tier','session'] as const)('rejects mismatched %s bindings without provider calls',async kind=>{
  const x=workflowFixture();const queued=await enqueueNextBibleTask(x.store,dispatcher(),x.key);if(queued.state!=='task')throw new Error('Expected task');
  const context=workflowJournal(queued.task).context;const input=structuredClone(queued.task.input);
  if(kind==='task')Object.assign(context.task,{taskId:'wrong'});if(kind==='digest')Object.assign(input!,{runDigest:hash('other')});
  if(kind==='source')Object.assign(x.run,{projectId:'other'});if(kind==='tier')Object.assign(x.run.execution,{modelTier:'quality'});
  if(kind==='session')x.sessionFor.mockImplementation(async()=>{throw new Error('session unavailable');});
  await expect(createBibleChunkWorkflow({store:x.store,ledger:x.ledger,sessionFor:x.sessionFor}).run(input,context)).rejects.toThrow();expect(x.exchange).not.toHaveBeenCalled();
});
it('rejects a dispatcher returning another task scope',async()=>{
  const x=workflowFixture();const durable=dispatcher();durable.enqueue.mockImplementation(async input=>({...input,tenantId:'other',status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null}) as Task);
  await expect(enqueueNextBibleTask(x.store,durable,x.key)).rejects.toThrow();
});
it.each([0,4097,NaN,1.5])('rejects invalid chunk budget count %s',count=>{const x=workflowFixture();expect(()=>executionForChunks(x.run.execution,count)).toThrow();});
it('enforces total run shares and positive unknown-price live reservations without numeric overflow',()=>{
  const x=workflowFixture();expect(executionForChunks(x.run.execution,x.run.plan.chunks.length)).toEqual(x.run.execution);
  expect(()=>executionForChunks({...x.run.execution,limits:{steps:1,tokens:1,costMicros:0}},2)).toThrow();
  expect(()=>executionForChunks({...x.run.execution,evidence:'live_model'},1)).toThrow();
  expect(executionForChunks({...x.run.execution,evidence:'live_model',pricing:{inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0}},1)).toBeTruthy();
  expect(()=>executionForChunks({...x.run.execution,reservation:{tokens:Number.MAX_SAFE_INTEGER,costMicros:0}},4096)).toThrow();
});

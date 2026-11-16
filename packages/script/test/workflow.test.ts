import { expect,it,vi } from 'vitest';
import type { DurableStore,Task } from '@camery/durable';
import { ModelError } from '@camery/model-modes';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import { ModelSession } from '@camery/methods';
import { AgentRuntime } from '@camery/agents';
import { hash } from '../src/data.js';
import { developmentStageTaskId,developmentRunDigest } from '../src/node/contracts.js';
import { createDevelopmentStageWorkflow,enqueueNextDevelopmentTask } from '../src/node/workflow.js';
import { workflowFixture,workflowJournal } from './workflow-support.js';

const dispatcher=()=>{
  const tasks=new Map<string,Task>();return {
    get:vi.fn<DurableStore['get']>(async key=>tasks.get(key.taskId)??null),
    enqueue:vi.fn<DurableStore['enqueue']>(async input=>{const prior=tasks.get(input.taskId);if(prior)return prior;const task:Task={...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null};tasks.set(task.taskId,task);return task;}),
    complete(task:Task){Object.assign(tasks.get(task.taskId)!,{status:'succeeded'});},
  };
};
it('uses independent phase tasks, exact references and one budget/model call each, then replays paid results without a new call',async()=>{
  const f=workflowFixture();const durable=dispatcher();const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);expect(first.state).toBe('task');if(first.state!=='task')throw new Error('Expected task');
  expect(first.task.taskId).toBe(developmentStageTaskId(f.key,'foundation'));expect(Buffer.byteLength(JSON.stringify(first.task.input))).toBeLessThan(1024);expect(JSON.stringify(first.task.input)).not.toContain(f.brief.idea);
  const journal=workflowJournal(first.task);const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});
  const foundationResult=await workflow.run(first.task.input,journal.context());expect(foundationResult).toMatchObject({state:'candidate',stage:'foundation',candidateDigest:f.progress.foundation.candidate!.digest});expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
  vi.mocked(f.store.isCurrent).mockResolvedValue(false);expect(await workflow.run(first.task.input,journal.context())).toEqual(foundationResult);expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
  vi.mocked(f.store.isCurrent).mockResolvedValue(true);durable.complete(first.task);expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toMatchObject({state:'awaiting_review',stage:'foundation'});
  const candidate=f.progress.foundation.candidate!;await f.store.review(f.key,'foundation',{candidateDigest:candidate.digest,output:{...candidate.output,title:'用户修改设定'}},f.host);
  const next=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(next.state!=='task')throw new Error('Expected episode task');expect(next.task.taskId).not.toBe(first.task.taskId);expect(next.task.input).toMatchObject({stage:'episodes',upstreamDigest:f.progress.foundation.review!.digest});
  await workflow.run(next.task.input,workflowJournal(next.task).context());expect(f.exchange).toHaveBeenCalledTimes(2);expect(f.allocate).toHaveBeenCalledTimes(2);expect(f.allocate.mock.calls.every(([input])=>input.budget.maxSteps===1&&input.budget.maxTokens===100)).toBe(true);
  const messages=(f.exchange.mock.calls[1]![0].body as {messages:{content:string}[]}).messages;expect(JSON.parse(messages.at(-1)!.content).untrustedSource.foundation.title).toBe('用户修改设定');
  durable.complete(next.task);expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toMatchObject({state:'awaiting_review',stage:'episodes'});
});
it('blocks stale, unavailable and overquote execution without saving a candidate',async()=>{
  for(const kind of ['stale','unavailable','quote'] as const){const f=workflowFixture();const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();
    if(kind==='stale')vi.mocked(f.store.isCurrent).mockResolvedValue(false);if(kind==='unavailable')vi.mocked(f.store.isCurrent).mockRejectedValue(new Error('private DSN'));
    if(kind==='quote'){const reply=f.exchange.getMockImplementation()!;f.exchange.mockImplementation(async(input,context)=>{const response=await reply(input,context);const body=response.body as {kind:'json';value:{usage:unknown}};body.value.usage={prompt_tokens:101,completion_tokens:1};return response;});}
    const output=await createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(dispatched.task.input,workflowJournal(dispatched.task).context());
    expect(output).toMatchObject({state:'blocked',reason:kind==='stale'?'BRIEF_CHANGED':kind==='unavailable'?'BRIEF_UNAVAILABLE':'QUOTE_EXCEEDED'});expect(f.progress.foundation.candidate).toBeNull();expect(f.exchange).toHaveBeenCalledTimes(kind==='quote'?1:0);
  }
});
it('preserves unknown calls and does not advance the stage',async()=>{
  const f=workflowFixture('live_model');f.exchange.mockRejectedValue(new ModelError('NETWORK_FAILED','fixture','unknown'));const durable=dispatcher();const dispatched=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(dispatched.state!=='task')throw new Error();
  await expect(createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(dispatched.task.input,workflowJournal(dispatched.task).context())).rejects.toMatchObject({code:'AGENT_EXTERNAL_UNKNOWN'});expect(f.exchange).toHaveBeenCalledOnce();expect(f.progress.foundation.candidate).toBeNull();expect((await enqueueNextDevelopmentTask(f.store,durable,f.key))).toEqual(dispatched);
});
it('revisits cached durable steps after a candidate commit acknowledgement is lost',async()=>{
  const f=workflowFixture();const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();const original=vi.mocked(f.store.saveCandidate).getMockImplementation()!;let first=true;
  vi.mocked(f.store.saveCandidate).mockImplementation(async(key,candidate)=>{const saved=await original(key,candidate);if(first){first=false;throw new Error('synthetic committed ack loss');}return saved;});
  const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});const journal=workflowJournal(dispatched.task);
  await expect(workflow.run(dispatched.task.input,journal.context())).rejects.toThrow('synthetic');expect(f.progress.foundation.candidate).toBeTruthy();
  expect(await workflow.run(dispatched.task.input,journal.context())).toMatchObject({state:'candidate'});expect(journal.cache.has('original.persist-stage')).toBe(true);expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it('returns reviewed terminal state and stale state without dispatching, and preserves deterministic pending identities',async()=>{
  const f=workflowFixture();const durable=dispatcher();vi.mocked(f.store.isCurrent).mockResolvedValue(false);expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual({state:'stale'});expect(durable.enqueue).not.toHaveBeenCalled();vi.mocked(f.store.isCurrent).mockResolvedValue(true);
  const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual(first);expect(durable.enqueue).toHaveBeenCalledOnce();expect(durable.get).toHaveBeenCalled();
});
it.each(['queued','running','waiting','reconciling'] as const)('returns an existing %s task before stale detection without a new enqueue',async status=>{
  const f=workflowFixture();const durable=dispatcher();const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(first.state!=='task')throw new Error();Object.assign(first.task,{status});vi.mocked(f.store.isCurrent).mockResolvedValue(false).mockClear();
  expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual(first);expect(f.store.isCurrent).not.toHaveBeenCalled();expect(durable.enqueue).toHaveBeenCalledOnce();expect(f.exchange).not.toHaveBeenCalled();
});
it.each(['succeeded','failed','cancelled'] as const)('keeps an existing %s task without a candidate authoritative',async status=>{
  const f=workflowFixture();const durable=dispatcher();const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(first.state!=='task')throw new Error();Object.assign(first.task,{status});vi.mocked(f.store.isCurrent).mockResolvedValue(false).mockClear();
  expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual(first);expect(f.store.isCurrent).not.toHaveBeenCalled();expect(durable.enqueue).toHaveBeenCalledOnce();
});
it('drains the original foundation tail before rejection and stale state',async()=>{
  const f=workflowFixture();const durable=dispatcher();const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(first.state!=='task')throw new Error();await createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(first.task.input,workflowJournal(first.task).context());await f.store.reject(f.key,'foundation','候选已审阅但任务确认丢失',f.host);vi.mocked(f.store.isCurrent).mockResolvedValue(false);
  expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual(first);durable.complete(first.task);expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual({state:'reviewed',stage:'foundation',status:'rejected'});expect(f.exchange).toHaveBeenCalledOnce();expect(durable.enqueue).toHaveBeenCalledOnce();
});
it.each(['tenantId','taskId','workflow','version','input','status'] as const)('validates existing task %s before returning a recovery route',async field=>{
  const f=workflowFixture();const durable=dispatcher();const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(first.state!=='task')throw new Error();const task=structuredClone(first.task);Object.assign(task,{[field]:field==='version'?2:field==='input'?{foreign:true}:'foreign'});durable.get.mockResolvedValue(task);vi.mocked(f.store.isCurrent).mockResolvedValue(false).mockClear();
  await expect(enqueueNextDevelopmentTask(f.store,durable,f.key)).rejects.toThrow('dispatched task binding');expect(f.store.isCurrent).not.toHaveBeenCalled();expect(durable.enqueue).toHaveBeenCalledOnce();
});
it.each(['task','digest','upstream','scope','method','profile'] as const)('rejects wrong %s binding before calling the model',async kind=>{
  const f=workflowFixture();const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();const input=structuredClone(dispatched.task.input);const ctx=workflowJournal(dispatched.task).context();
  if(kind==='task')Object.assign(ctx.task,{taskId:'wrong'});if(kind==='digest')Object.assign(input!,{runDigest:'b'.repeat(64)});if(kind==='upstream')Object.assign(input!,{upstreamDigest:'b'.repeat(64)});if(kind==='scope')Object.assign(f.run,{projectId:'other'});if(kind==='method')Object.assign(f.run.methods,{foundation:{...f.run.methods.foundation,digest:'b'.repeat(64)}});if(kind==='profile')f.sessionFor.mockImplementation(async()=>{throw new Error('profile unavailable');});
  await expect(createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(input,ctx)).rejects.toThrow();expect(f.exchange).not.toHaveBeenCalled();
});
it('rejects a dispatcher substituting another tenant or task',async()=>{const f=workflowFixture();const durable=dispatcher();durable.enqueue.mockImplementation(async input=>({...input,tenantId:'other',status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null}) as Task);await expect(enqueueNextDevelopmentTask(f.store,durable,f.key)).rejects.toThrow();});
it('returns each terminal audit without new work and rejects inconsistent stored audit identity',async()=>{
  const f=workflowFixture();const durable=dispatcher();const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(first.state!=='task')throw new Error();const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});await workflow.run(first.task.input,workflowJournal(first.task).context());
  durable.complete(first.task);await f.store.reject(f.key,'foundation','不采用这份设定',f.host);vi.mocked(f.store.isCurrent).mockResolvedValue(false);
  expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual({state:'reviewed',stage:'foundation',status:'rejected'});expect(f.exchange).toHaveBeenCalledOnce();
  const other=workflowFixture();const queue=dispatcher();const initial=await enqueueNextDevelopmentTask(other.store,queue,other.key);if(initial.state!=='task')throw new Error();const otherWorkflow=createDevelopmentStageWorkflow({store:other.store,ledger:other.ledger,sessionFor:other.sessionFor});await otherWorkflow.run(initial.task.input,workflowJournal(initial.task).context());
  queue.complete(initial.task);await other.store.review(other.key,'foundation',{candidateDigest:other.progress.foundation.candidate!.digest,output:other.foundation},other.host);const second=await enqueueNextDevelopmentTask(other.store,queue,other.key);if(second.state!=='task')throw new Error();await otherWorkflow.run(second.task.input,workflowJournal(second.task).context());queue.complete(second.task);
  await other.store.review(other.key,'episodes',{candidateDigest:other.progress.episodes.candidate!.digest,output:other.output},other.host);expect(await enqueueNextDevelopmentTask(other.store,queue,other.key)).toEqual({state:'reviewed',stage:'episodes',status:'reviewed'});
  const {digest:_digest,...audit}=other.progress.episodes.review!;const forged={...audit,candidateDigest:'b'.repeat(64)};Object.assign(other.progress.episodes,{review:{...forged,digest:hash(forged)}});await expect(enqueueNextDevelopmentTask(other.store,queue,other.key)).rejects.toThrow('episode review candidate');
});
it('replays a completed paid decision with no saved candidate after the brief changed',async()=>{
  const f=workflowFixture('live_model');const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();const save=vi.mocked(f.store.saveCandidate).getMockImplementation()!;vi.mocked(f.store.saveCandidate).mockRejectedValueOnce(new Error('before candidate commit'));
  const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});const journal=workflowJournal(dispatched.task);await expect(workflow.run(dispatched.task.input,journal.context())).rejects.toThrow('before candidate');
  expect(f.progress.foundation.candidate).toBeNull();vi.mocked(f.store.isCurrent).mockResolvedValue(false);vi.mocked(f.store.saveCandidate).mockImplementation(save);
  expect(await workflow.run(dispatched.task.input,journal.context())).toMatchObject({state:'candidate'});expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();expect(f.progress.foundation.candidate?.model.evidence).toBe('live_model');
});
it('uses the stored output and exact original receipt without resolving a session if the journal must be rebuilt',async()=>{
  const f=workflowFixture('live_model');const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});const result=await workflow.run(dispatched.task.input,workflowJournal(dispatched.task).context());const receipt=f.progress.foundation.candidate!.model;
  f.sessionFor.mockRejectedValue(new Error('No replacement credentials'));vi.mocked(f.store.isCurrent).mockResolvedValue(false);
  expect(await workflow.run(dispatched.task.input,workflowJournal(dispatched.task).context())).toEqual(result);expect(f.exchange).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.progress.foundation.candidate!.model).toEqual(receipt);
  expect(f.allocate).toHaveBeenCalledTimes(2);expect(f.allocate.mock.calls[0]).toEqual(f.allocate.mock.calls[1]);
});
it('retains the fixed known pricing profile through the actual stage decision',async()=>{
  const f=workflowFixture('live_model');Object.assign(f.run.execution,{pricing:{inputMicrosPerMillionTokens:1000,outputMicrosPerMillionTokens:1000}});Object.assign(f.run,{digest:developmentRunDigest(f.run)});
  const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();expect(await createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(dispatched.task.input,workflowJournal(dispatched.task).context())).toMatchObject({state:'candidate'});expect(f.progress.foundation.candidate?.model.usage).toEqual({inputTokens:50,outputTokens:30});expect(f.exchange).toHaveBeenCalledOnce();
});
it.each(['missing','wrong-call','tool','multiple'] as const)('refuses a corrupt runtime %s span instead of storing unsupported model evidence',async kind=>{
  const f=workflowFixture();const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();
  const original=AgentRuntime.prototype.run;
  const spy=vi.spyOn(AgentRuntime.prototype,'run').mockImplementationOnce(async function(this:AgentRuntime,...args:Parameters<AgentRuntime['run']>){
    const report=structuredClone(await original.apply(this,args));if(kind==='missing')report.spans=[];if(kind==='wrong-call')Object.assign(report.spans[0]!.modelCall!,{callId:'foreign'});if(kind==='tool')report.spans[0]!.kind='tool';if(kind==='multiple')report.spans.push(structuredClone(report.spans[0]!));return report;
  });
  try{await expect(createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(dispatched.task.input,workflowJournal(dispatched.task).context())).rejects.toThrow('stage model span');expect(f.progress.foundation.candidate).toBeNull();expect(f.exchange).toHaveBeenCalledOnce();}
  finally{spy.mockRestore();}
});
it('refuses an incorrect saved candidate or a tampered persistence journal',async()=>{
  const f=workflowFixture();const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();const save=vi.mocked(f.store.saveCandidate).getMockImplementation()!;
  vi.mocked(f.store.saveCandidate).mockImplementation(async(key,candidate)=>({...await save(key,candidate),digest:'b'.repeat(64)}));const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});const journal=workflowJournal(dispatched.task);
  await expect(workflow.run(dispatched.task.input,journal.context())).rejects.toThrow('saved stage binding');vi.mocked(f.store.saveCandidate).mockImplementation(save);await workflow.run(dispatched.task.input,journal.context());
  const persisted=journal.cache.get('original.persist-stage')!;Object.assign(persisted.output!,{candidateDigest:'b'.repeat(64)});await expect(workflow.run(dispatched.task.input,journal.context())).rejects.toThrow('stage persistence journal');expect(f.exchange).toHaveBeenCalledOnce();
});
it.each(['foundation-review','episode-without-upstream','model','rejection'] as const)('rejects inconsistent %s from the trusted-store protocol',async kind=>{
  const f=workflowFixture();const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});await workflow.run(dispatched.task.input,workflowJournal(dispatched.task).context());
  if(kind==='foundation-review'){await f.store.review(f.key,'foundation',{candidateDigest:f.progress.foundation.candidate!.digest,output:f.foundation},f.host);Object.assign(f.progress.foundation,{review:{...f.progress.foundation.review!,candidateDigest:'b'.repeat(64)}});}
  if(kind==='episode-without-upstream')Object.assign(f.progress.episodes,{candidate:f.progress.foundation.candidate});
  if(kind==='model')Object.assign(f.progress.foundation,{candidate:{...f.progress.foundation.candidate!,model:{...f.progress.foundation.candidate!.model,connectionId:'foreign'}}});
  if(kind==='rejection'){await f.store.reject(f.key,'foundation','不采用',f.host);Object.assign(f.progress.foundation,{review:{...f.progress.foundation.review!,reason:'tampered'}});}
  await expect(enqueueNextDevelopmentTask(f.store,dispatcher(),f.key)).rejects.toThrow();expect(f.exchange).toHaveBeenCalledOnce();
});
it.each(['callId','connectionId','modeDigest','modelIdentity','evidence'] as const)('rejects a self-consistent stored candidate from the wrong %s profile',async field=>{
  const f=workflowFixture();const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();await createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(dispatched.task.input,workflowJournal(dispatched.task).context());
  const candidate=structuredClone(f.progress.foundation.candidate!);
  if(field==='modeDigest')candidate.model.modeDigest='b'.repeat(64);else if(field==='evidence')candidate.model.evidence='live_model';else candidate.model[field]='foreign';
  const {digest:_digest,...body}=candidate;Object.assign(candidate,{digest:hash(body)});Object.assign(f.progress.foundation,{candidate});
  await expect(enqueueNextDevelopmentTask(f.store,dispatcher(),f.key)).rejects.toThrow('stored stage model binding');expect(f.exchange).toHaveBeenCalledOnce();
});
it('rejects a different actual session profile before allocating or invoking the provider',async()=>{
  const f=workflowFixture();f.sessionFor.mockImplementation(async()=>new ModelSession(new OpenAiCompatibleLlm({exchange:f.exchange},{model:'fixture-original',structuredOutput:'json_schema'}),{...f.session.profile,modelIdentity:'replacement/model',maxCalls:1,timeoutMs:1000}));
  const dispatched=await enqueueNextDevelopmentTask(f.store,dispatcher(),f.key);if(dispatched.state!=='task')throw new Error();await expect(createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor}).run(dispatched.task.input,workflowJournal(dispatched.task).context())).rejects.toThrow('stage model binding');expect(f.exchange).not.toHaveBeenCalled();expect(f.allocate).not.toHaveBeenCalled();
});
it.each(['taskId','workflow','version','input'] as const)('refuses dispatcher substitution of %s',async field=>{
  const f=workflowFixture();const durable=dispatcher();const original=durable.enqueue.getMockImplementation()!;durable.enqueue.mockImplementation(async input=>{const task=await original(input);if(field==='taskId')task.taskId='foreign';if(field==='workflow')task.workflow='foreign.workflow';if(field==='version')task.version=2;if(field==='input')task.input={foreign:true};return task;});
  await expect(enqueueNextDevelopmentTask(f.store,durable,f.key)).rejects.toThrow('dispatched task binding');expect(f.exchange).not.toHaveBeenCalled();
});
it('rejects missing candidate/audit dependencies and an audit pointing at a different candidate even with its own valid digest',async()=>{
  const f=workflowFixture();const durable=dispatcher();const first=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(first.state!=='task')throw new Error();const workflow=createDevelopmentStageWorkflow({store:f.store,ledger:f.ledger,sessionFor:f.sessionFor});await workflow.run(first.task.input,workflowJournal(first.task).context());await f.store.review(f.key,'foundation',{candidateDigest:f.progress.foundation.candidate!.digest,output:f.foundation},f.host);
  durable.complete(first.task);const normal=structuredClone(f.progress);const missingFoundation=structuredClone(normal);Object.assign(missingFoundation.foundation,{candidate:null});vi.mocked(f.store.read).mockResolvedValue(missingFoundation);await expect(enqueueNextDevelopmentTask(f.store,durable,f.key)).rejects.toThrow('foundation candidate missing');
  const wrongAudit=structuredClone(normal);const review=wrongAudit.foundation.review!;const {digest:_digest,...body}=review;Object.assign(wrongAudit.foundation,{review:{...body,candidateDigest:'b'.repeat(64),digest:hash({...body,candidateDigest:'b'.repeat(64)})}});vi.mocked(f.store.read).mockResolvedValue(wrongAudit);await expect(enqueueNextDevelopmentTask(f.store,durable,f.key)).rejects.toThrow('foundation review candidate');
  vi.mocked(f.store.read).mockResolvedValue(f.progress);const second=await enqueueNextDevelopmentTask(f.store,durable,f.key);if(second.state!=='task')throw new Error();await workflow.run(second.task.input,workflowJournal(second.task).context());await f.store.reject(f.key,'episodes','分集重做',f.host);
  durable.complete(second.task);expect(await enqueueNextDevelopmentTask(f.store,durable,f.key)).toEqual({state:'reviewed',stage:'episodes',status:'rejected'});
  const episodeSnapshot=structuredClone(f.progress);const missingEpisodes=structuredClone(episodeSnapshot);Object.assign(missingEpisodes.episodes,{candidate:null});vi.mocked(f.store.read).mockResolvedValue(missingEpisodes);await expect(enqueueNextDevelopmentTask(f.store,durable,f.key)).rejects.toThrow('episode candidate missing');
  const wrongEpisode=structuredClone(episodeSnapshot);const rejected=wrongEpisode.episodes.review!;const {digest:_audit,...auditBody}=rejected;Object.assign(wrongEpisode.episodes,{review:{...auditBody,candidateDigest:'b'.repeat(64),digest:hash({...auditBody,candidateDigest:'b'.repeat(64)})}});vi.mocked(f.store.read).mockResolvedValue(wrongEpisode);await expect(enqueueNextDevelopmentTask(f.store,durable,f.key)).rejects.toThrow();
});

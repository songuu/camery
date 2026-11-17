import { expect,it,vi } from 'vitest';
import { AgentRuntime,BudgetLedgerError } from '@camery/agents';
import type { DurableStore,Task } from '@camery/durable';
import { ModelSession } from '@camery/methods';
import { ModelError,OpenAiCompatibleLlm } from '@camery/model-modes';
import { OutlineError } from '../src/outline/contracts.js';
import { createOutlineWorkflow } from '../src/outline/node/workflow.js';
import { enqueueOutlineTask } from '../src/outline/node/dispatch.js';
import { outlineTaskReference } from '../src/outline/node/persistence-contracts.js';
import { outlineWorkflowFixture } from './outline-workflow-support.js';
import { workflowJournal } from './workflow-support.js';

function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function dispatcher(){
  let task:Task|null=null;return {
    get:vi.fn<DurableStore['get']>(async()=>task),
    enqueue:vi.fn<DurableStore['enqueue']>(async input=>task??={...input,status:'queued',attempts:0,fence:0,owner:null,leaseUntil:null,output:null,error:null}),
  };
}

it.each(['task','tenant','project','run','digest','unknown-field','accessor'] as const)('rejects malformed %s identity before allocating or constructing a session',async kind=>{
  const f=await outlineWorkflowFixture(),input={...outlineTaskReference(f.run)},journal=workflowJournal(f.task),context=journal.context();let getterCalled=false;
  if(kind==='task')Object.assign(context.task,{taskId:'foreign'});
  if(kind==='tenant')Object.assign(context.task,{tenantId:'foreign'});
  if(kind==='project')input.projectId='foreign';if(kind==='run')input.runId='foreign';if(kind==='digest')input.runDigest='b'.repeat(64);
  if(kind==='unknown-field')Object.assign(input,{approved:true});
  if(kind==='accessor')Object.defineProperty(input,'runDigest',{enumerable:true,get(){getterCalled=true;throw new Error('private input');}});
  await expect(createOutlineWorkflow(f).run(input,context)).rejects.toBeInstanceOf(OutlineError);
  expect(getterCalled).toBe(false);expect(f.allocate).not.toHaveBeenCalled();expect(f.sessionFor).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();expect(journal.cache.size).toBe(0);
});

it('stops a rejected budget allocation before any session or provider call',async()=>{
  const f=await outlineWorkflowFixture();f.allocate.mockRejectedValue(new BudgetLedgerError('BUDGET_EXCEEDED'));const journal=workflowJournal(f.task);
  await expect(createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context())).rejects.toMatchObject({code:'BUDGET_EXCEEDED'});
  expect(f.allocate).toHaveBeenCalledOnce();expect(f.sessionFor).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();expect(journal.cache.size).toBe(0);
});
it.each(['tenantId','projectId','taskId','allocationId','agent','budget','state','confirmation'] as const)('refuses a mismatched held allocation %s before calling the provider',async field=>{
  const f=await outlineWorkflowFixture(),allocate=f.allocate.getMockImplementation()!;
  f.allocate.mockImplementation(async request=>{const allocation=await allocate(request);
    if(field==='agent')Object.assign(allocation,{agent:{...allocation.agent,digest:'b'.repeat(64)}});
    else if(field==='budget')Object.assign(allocation,{budget:{...allocation.budget,maxTokens:301}});
    else if(field==='state')Object.assign(allocation,{state:'settled',confirmation:{actorId:'host',receiptId:'receipt',reference:'reference',actual:{steps:0,tokens:0,costMicros:0}}});
    else if(field==='confirmation')Object.assign(allocation,{confirmation:{actorId:'host',receiptId:'receipt',reference:'reference',actual:{steps:0,tokens:0,costMicros:0}}});
    else Object.assign(allocation,{[field]:'foreign'});return allocation;
  });
  await expect(createOutlineWorkflow(f).run(outlineTaskReference(f.run),workflowJournal(f.task).context())).rejects.toBeInstanceOf(BudgetLedgerError);
  expect(f.sessionFor).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();expect((await f.progress()).candidate).toBeNull();
});

it.each(['stale','unavailable'] as const)('journals a %s source as not-sent without resolving credentials',async kind=>{
  const f=await outlineWorkflowFixture(),current=vi.spyOn(f.store,'isCurrent');
  if(kind==='stale')current.mockResolvedValue(false);else current.mockRejectedValue(new Error('private source DSN'));
  const journal=workflowJournal(f.task),workflow=createOutlineWorkflow(f),result=await workflow.run(outlineTaskReference(f.run),journal.context());
  expect(result).toMatchObject({state:'blocked',reason:kind==='stale'?'OUTLINE_SOURCE_CHANGED':'OUTLINE_SOURCE_UNAVAILABLE',charged:{tokens:0,costMicros:0},usageUnknown:false});
  expect(journal.cache.get('agent.0.decision')?.output).toMatchObject({kind:'error',outcome:'not_sent',usage:{tokens:0,costMicros:0}});
  expect(await workflow.run(outlineTaskReference(f.run),journal.context())).toEqual(result);expect(JSON.stringify(result)).not.toContain('private');
  expect(f.allocate).toHaveBeenCalledOnce();expect(f.sessionFor).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();expect((await f.progress()).candidate).toBeNull();
});

it('redacts a failed lazy session factory and journals its not-sent result',async()=>{
  const f=await outlineWorkflowFixture();f.sessionFor.mockRejectedValue(new Error('private credential https://user:secret@host'));
  const journal=workflowJournal(f.task),workflow=createOutlineWorkflow(f),result=await workflow.run(outlineTaskReference(f.run),journal.context());
  expect(result).toMatchObject({state:'blocked',reason:'OUTLINE_SESSION_UNAVAILABLE',charged:{tokens:0,costMicros:0},usageUnknown:false});
  expect(await workflow.run(outlineTaskReference(f.run),journal.context())).toEqual(result);expect(JSON.stringify([...journal.cache.values()])).not.toContain('private credential');
  expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();expect(f.exchange).not.toHaveBeenCalled();expect((await f.progress()).candidate).toBeNull();
});
it.each(['tenantId','connectionId','modeDigest','modelIdentity','evidence'] as const)('blocks an actual session with a foreign %s profile as not-sent',async field=>{
  const f=await outlineWorkflowFixture();const profile={...f.session.profile};Object.assign(profile,{[field]:field==='evidence'?'live_model':field==='modeDigest'?'b'.repeat(64):'foreign'});
  f.sessionFor.mockResolvedValue(new ModelSession(new OpenAiCompatibleLlm({exchange:f.exchange},{model:'fixture-outline',structuredOutput:'json_schema'}),{...profile,maxCalls:1,timeoutMs:1000}));
  const journal=workflowJournal(f.task),result=await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context());
  expect(result).toMatchObject({state:'blocked',reason:'OUTLINE_MODEL_BINDING',charged:{tokens:0,costMicros:0},usageUnknown:false});
  expect(journal.cache.get('agent.0.decision')?.output).toMatchObject({kind:'error',outcome:'not_sent'});expect(f.exchange).not.toHaveBeenCalled();expect((await f.progress()).candidate).toBeNull();
});

// live_model selects the external-effect protocol here; this synthetic transport is not real inference or billing evidence.
it('preserves an unknown external call and redispatches the same task without another allocation or call',async()=>{
  const f=await outlineWorkflowFixture('live_model'),durable=dispatcher(),dispatched=await enqueueOutlineTask(f.store,durable,f.key);
  if(dispatched.state!=='task')throw new Error('Expected original outline task');
  f.exchange.mockRejectedValue(new ModelError('NETWORK_FAILED','private provider failure','unknown'));const journal=workflowJournal(f.task);
  await expect(createOutlineWorkflow(f).run(dispatched.task.input,journal.context())).rejects.toMatchObject({code:'AGENT_EXTERNAL_UNKNOWN'});
  expect(journal.cache.has('agent.0.decision')).toBe(false);expect(journal.cache.has('outline.persist-candidate')).toBe(false);expect((await f.progress()).candidate).toBeNull();
  Object.assign(dispatched.task,{status:'reconciling'});f.db.state.current=false;
  expect(await enqueueOutlineTask(f.store,durable,f.key)).toEqual(dispatched);expect(durable.enqueue).toHaveBeenCalledOnce();expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();
});
it.each(['not_sent','completed'] as const)('retains a known provider %s error envelope across journal replay',async outcome=>{
  const f=await outlineWorkflowFixture('live_model');f.exchange.mockRejectedValue(new ModelError('NETWORK_FAILED','private provider URL',outcome));
  const journal=workflowJournal(f.task),workflow=createOutlineWorkflow(f),result=await workflow.run(outlineTaskReference(f.run),journal.context());
  expect(result).toMatchObject({state:'blocked',charged:outcome==='not_sent'?{tokens:0,costMicros:0}:{tokens:300,costMicros:10},usageUnknown:outcome!=='not_sent'});
  expect(journal.cache.get('agent.0.decision')?.output).toMatchObject({kind:'error',outcome,usage:outcome==='not_sent'?{tokens:0,costMicros:0}:{tokens:null,costMicros:null}});
  expect(JSON.stringify([...journal.cache.values()])).not.toContain('private provider URL');expect(await workflow.run(outlineTaskReference(f.run),journal.context())).toEqual(result);
  expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect((await f.progress()).candidate).toBeNull();
});

it('keeps the raw completed decision when semantic source references are invalid without saving a candidate',async()=>{
  const f=await outlineWorkflowFixture();f.output.beats[0]!.origin.sourceRefIds=['foreign-source'];
  const journal=workflowJournal(f.task),workflow=createOutlineWorkflow(f);
  await expect(workflow.run(outlineTaskReference(f.run),journal.context())).rejects.toBeInstanceOf(OutlineError);
  const raw=journal.cache.get('agent.0.decision')?.output;expect(raw).toMatchObject({kind:'result',output:{kind:'finish',output:f.output}});
  expect(JSON.stringify(raw)).toContain('foreign-source');expect(journal.cache.has('outline.persist-candidate')).toBe(false);expect((await f.progress()).candidate).toBeNull();
  await expect(workflow.run(outlineTaskReference(f.run),journal.context())).rejects.toBeInstanceOf(OutlineError);expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it('journals structurally invalid provider output as a completed error without inventing candidate evidence',async()=>{
  const f=await outlineWorkflowFixture('live_model');Object.assign(f.output.beats[0]!.origin,{kind:'approved'});const journal=workflowJournal(f.task),workflow=createOutlineWorkflow(f);
  const result=await workflow.run(outlineTaskReference(f.run),journal.context());expect(result).toMatchObject({state:'blocked',usageUnknown:true});
  expect(journal.cache.get('agent.0.decision')?.output).toMatchObject({kind:'error',outcome:'completed'});expect(journal.cache.has('outline.persist-candidate')).toBe(false);expect((await f.progress()).candidate).toBeNull();
  expect(await workflow.run(outlineTaskReference(f.run),journal.context())).toEqual(result);expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it.each(['connectionId','inputDigest','outputDigest','evidence'] as const)('retains an invalid raw decision receipt %s without manufacturing a candidate',async field=>{
  const f=await outlineWorkflowFixture(),journal=workflowJournal(f.task),context=journal.context(),step=context.step.bind(context);
  context.step=async(key,options,effect)=>{
    const output=await step(key,options,effect);
    if(key==='agent.0.decision'&&output&&typeof output==='object'&&!Array.isArray(output)){
      const receipt=output['modelCall'];if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new Error('Fixture receipt missing');
      Object.assign(receipt,{[field]:field==='evidence'?'live_model':field==='connectionId'?'foreign':'b'.repeat(64)});journal.cache.get(key)!.output=structuredClone(output);
    }
    return output;
  };
  await expect(createOutlineWorkflow(f).run(outlineTaskReference(f.run),context)).rejects.toMatchObject({code:'MODEL_RECEIPT_INVALID'});
  expect(journal.cache.get('agent.0.decision')?.output).toMatchObject({kind:'result',modelCall:{[field]:field==='evidence'?'live_model':field==='connectionId'?'foreign':'b'.repeat(64)}});
  expect(journal.cache.has('outline.persist-candidate')).toBe(false);expect((await f.progress()).candidate).toBeNull();expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it.each(['missing','wrong-call','tool','multiple'] as const)('refuses a corrupt runtime %s receipt span without persisting a candidate',async kind=>{
  const f=await outlineWorkflowFixture(),original=AgentRuntime.prototype.run,journal=workflowJournal(f.task);
  const spy=vi.spyOn(AgentRuntime.prototype,'run').mockImplementationOnce(async function(this:AgentRuntime,...args:Parameters<AgentRuntime['run']>){
    const report=structuredClone(await original.apply(this,args));if(kind==='missing')report.spans=[];if(kind==='wrong-call')Object.assign(report.spans[0]!.modelCall!,{callId:'foreign'});if(kind==='tool')report.spans[0]!.kind='tool';if(kind==='multiple')report.spans.push(structuredClone(report.spans[0]!));return report;
  });
  try{await expect(createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context())).rejects.toMatchObject({code:'INVALID_EVIDENCE'});expect((await f.progress()).candidate).toBeNull();expect(journal.cache.has('agent.0.decision')).toBe(true);expect(journal.cache.has('outline.persist-candidate')).toBe(false);expect(f.exchange).toHaveBeenCalledOnce();}
  finally{spy.mockRestore();}
});

it('recovers a failed candidate commit from the original paid decision after the source becomes stale',async()=>{
  const f=await outlineWorkflowFixture('live_model'),save=vi.spyOn(f.store,'saveCandidate').mockRejectedValueOnce(new Error('synthetic precommit failure'));
  const workflow=createOutlineWorkflow(f),journal=workflowJournal(f.task);await expect(workflow.run(outlineTaskReference(f.run),journal.context())).rejects.toThrow('precommit');
  expect((await f.progress()).candidate).toBeNull();expect(journal.cache.has('agent.0.decision')).toBe(true);expect(journal.cache.has('outline.persist-candidate')).toBe(false);
  f.db.state.current=false;f.sessionFor.mockRejectedValue(new Error('replacement credentials unavailable'));
  const result=await workflow.run(outlineTaskReference(f.run),journal.context()),candidate=(await f.progress()).candidate;
  expect(result).toMatchObject({state:'candidate',candidateDigest:candidate?.digest});expect(candidate?.model.evidence).toBe('live_model');expect(save).toHaveBeenCalledTimes(2);
  expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it('drains a lost commit acknowledgement after a real test-host review and later source change',async()=>{
  const f=await outlineWorkflowFixture('live_model'),original=f.store.saveCandidate.bind(f.store);let lost=true;
  vi.spyOn(f.store,'saveCandidate').mockImplementation(async(...args)=>{const candidate=await original(...args);if(lost){lost=false;throw new Error('synthetic committed acknowledgement lost');}return candidate;});
  const journal=workflowJournal(f.task),workflow=createOutlineWorkflow(f);await expect(workflow.run(outlineTaskReference(f.run),journal.context())).rejects.toThrow('acknowledgement');
  const candidate=(await f.progress()).candidate!;expect(candidate).not.toBeNull();
  const output=structuredClone(candidate.output);output.adaptation.title='测试宿主修改，保留原始候选';
  const reviewed=await f.store.review(f.key,{candidateDigest:candidate.digest,output,ablations:[{genre:'suspense',judgment:'participates',reason:'测试宿主核对辅轴影响主线选择。'}],waivers:[]},f.host);
  f.db.state.current=false;f.sessionFor.mockRejectedValue(new Error('no replacement credentials'));
  expect(await workflow.run(outlineTaskReference(f.run),journal.context())).toEqual({state:'candidate',runDigest:f.run.digest,candidateDigest:candidate.digest});
  const progress=await f.progress();expect(progress.review).toEqual(reviewed);expect(progress.candidate).toEqual(candidate);expect(progress.candidate!.output.adaptation.title).not.toBe(output.adaptation.title);
  expect(journal.cache.has('outline.persist-candidate')).toBe(true);expect(f.exchange).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it('rejects a substituted save result and tampered persistence reference while preserving the original decision',async()=>{
  const f=await outlineWorkflowFixture(),original=f.store.saveCandidate.bind(f.store),save=vi.spyOn(f.store,'saveCandidate').mockImplementationOnce(async(...args)=>({...await original(...args),digest:'b'.repeat(64)}));
  const workflow=createOutlineWorkflow(f),journal=workflowJournal(f.task);await expect(workflow.run(outlineTaskReference(f.run),journal.context())).rejects.toMatchObject({code:'CONFLICT'});
  expect(journal.cache.has('outline.persist-candidate')).toBe(false);save.mockImplementation(original);await workflow.run(outlineTaskReference(f.run),journal.context());
  Object.assign(journal.cache.get('outline.persist-candidate')!.output!,{candidateDigest:'b'.repeat(64)});
  await expect(workflow.run(outlineTaskReference(f.run),journal.context())).rejects.toMatchObject({code:'CONFLICT'});expect(f.exchange).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});

it('captures host callbacks, task key and progress before their asynchronous boundaries',async()=>{
  const f=await outlineWorkflowFixture(),readEntered=gate(),releaseRead=gate(),factoryEntered=gate(),releaseFactory=gate();
  const progress=structuredClone(await f.progress()),makeSession=f.sessionFor.getMockImplementation()!,read=vi.fn(async()=>{readEntered.resolve();await releaseRead.promise;return progress;});
  const current=vi.fn(f.store.isCurrent.bind(f.store)),save=vi.fn(f.store.saveCandidate.bind(f.store));
  const factory=vi.fn(async(...args:Parameters<typeof f.sessionFor>)=>{factoryEntered.resolve();await releaseFactory.promise;return makeSession(...args);});
  const options={store:{read,isCurrent:current,saveCandidate:save},ledger:{allocate:f.allocate},sessionFor:factory},workflow=createOutlineWorkflow(options),input={...outlineTaskReference(f.run)};
  const pending=workflow.run(input,workflowJournal(f.task).context());await readEntered.promise;
  options.store.read=vi.fn(async()=>{throw new Error('substituted read');});options.store.isCurrent=vi.fn(async()=>{throw new Error('substituted current');});options.store.saveCandidate=vi.fn(async()=>{throw new Error('substituted save');});
  options.ledger.allocate=vi.fn(async()=>{throw new Error('substituted allocation');});options.sessionFor=vi.fn(async()=>{throw new Error('substituted factory');});Object.assign(input,{projectId:'foreign',runId:'foreign',runDigest:'b'.repeat(64)});
  releaseRead.resolve();await factoryEntered.promise;Object.assign(progress.run.brief,{notes:'late mutation after capture'});Object.assign(progress.run.execution,{connectionId:'foreign'});releaseFactory.resolve();
  const result=await pending;expect(result).toMatchObject({state:'candidate',runDigest:f.run.digest});expect((await f.progress()).candidate?.model.connectionId).toBe(f.execution.connectionId);
  expect(read).toHaveBeenCalledWith(f.key);expect(current.mock.calls.every(([key])=>JSON.stringify(key)===JSON.stringify(f.key))).toBe(true);expect(save.mock.calls[0]![0]).toEqual(f.key);
  expect(factory).toHaveBeenCalledOnce();expect(f.sessionFor).not.toHaveBeenCalled();expect(f.allocate).toHaveBeenCalledOnce();expect(f.exchange).toHaveBeenCalledOnce();
});

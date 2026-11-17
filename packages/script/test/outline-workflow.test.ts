import { expect,it } from 'vitest';
import type { ModelSession } from '@camery/methods';
import { createOutlineWorkflow } from '../src/outline/node/workflow.js';
import { outlineTaskId,outlineTaskReference } from '../src/outline/node/persistence-contracts.js';
import { outlineWorkflowFixture } from './outline-workflow-support.js';
import { workflowJournal } from './workflow-support.js';

it('allocates a single budgeted decision, stores the original receipt and returns only an immutable reference',async()=>{
  const f=await outlineWorkflowFixture();const journal=workflowJournal({tenantId:f.key.tenantId,taskId:outlineTaskId(f.key)});
  const result=await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context());const progress=await f.store.read(f.key);
  expect(result).toMatchObject({state:'candidate',runDigest:f.run.digest,candidateDigest:progress.candidate?.digest});expect(f.exchange).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
  expect([...journal.cache.keys()]).toEqual(['budget.allocate','agent.bind','agent.0.decision','outline.persist-candidate']);expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024);
});
it('replays committed decision journals without a new provider session or budget allocation',async()=>{
  const f=await outlineWorkflowFixture();const journal=workflowJournal({tenantId:f.key.tenantId,taskId:outlineTaskId(f.key)});const workflow=createOutlineWorkflow(f);
  const first=await workflow.run(outlineTaskReference(f.run),journal.context());expect(await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context())).toEqual(first);
  expect(f.exchange).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
});
it('rechecks a source that changes while the lazy session factory is awaiting',async()=>{
  const f=await outlineWorkflowFixture();const make=f.sessionFor.getMockImplementation()!;
  f.sessionFor.mockImplementation(async(...args)=>{const session=await make(...args);f.db.state.current=false;return session;});
  const journal=workflowJournal(f.task);expect(await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context())).toMatchObject({state:'blocked',reason:'OUTLINE_SOURCE_CHANGED',charged:{tokens:0,costMicros:0},usageUnknown:false});
  expect(f.exchange).not.toHaveBeenCalled();expect((await f.store.read(f.key)).candidate).toBeNull();
});
it('fails malformed host session profiles as not-sent without executing profile accessors',async()=>{
  const f=await outlineWorkflowFixture();let invoked=false;const session=Object.defineProperty({},'profile',{enumerable:true,get(){invoked=true;throw new Error('private profile');}});
  f.sessionFor.mockResolvedValue(session as ModelSession);const journal=workflowJournal(f.task);
  expect(await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context())).toMatchObject({state:'blocked',reason:'OUTLINE_MODEL_BINDING',charged:{tokens:0,costMicros:0},usageUnknown:false});
  expect(f.exchange).not.toHaveBeenCalled();expect(invoked).toBe(false);
});

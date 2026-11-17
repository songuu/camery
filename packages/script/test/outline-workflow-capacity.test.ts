import { expect,it } from 'vitest';
import { prepareOutline } from '../src/outline/node/generation.js';
import { hash } from '../src/outline/node/data.js';
import { createOutlineWorkflow } from '../src/outline/node/workflow.js';
import { outlineTaskReference } from '../src/outline/node/persistence-contracts.js';
import { largeBibleFixture,largeBibleOutlineSource } from './outline-capacity-support.js';
import { outlineWorkflowFixture } from './outline-workflow-support.js';
import { workflowJournal } from './workflow-support.js';

const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));

function growOutput(f:Awaited<ReturnType<typeof outlineWorkflowFixture>>){
  const asset=f.output.assets[0]!,decision=f.output.adaptation.decisions[0]!;
  f.output.assets=Array.from({length:128},(_,index)=>({...structuredClone(asset),id:`asset-${index}`,description:'d'.repeat(1000),narrativeRole:'r'.repeat(1000)}));
  f.output.adaptation.decisions=Array.from({length:128},(_,index)=>({...structuredClone(decision),id:`decision-${index}`,reason:'r'.repeat(1000)}));
}

it('keeps large confirmed Bible input and complete large model output behind small journal references',async()=>{
  const template=largeBibleFixture();
  for(const record of template.candidate.records){expect(record.output.claims).toHaveLength(64);expect(bytes(record.output)).toBeLessThan(131072);}
  const source=largeBibleOutlineSource();expect(bytes(source)).toBeGreaterThan(131072);expect(bytes(source)).toBeLessThanOrEqual(524288);
  const f=await outlineWorkflowFixture('synthetic_replay',{source});growOutput(f);
  const outputBytes=bytes(f.output),prepared=prepareOutline(f.brief,f.source);expect(bytes(prepared.input)).toBeGreaterThan(131072);
  expect(outputBytes).toBeGreaterThan(262144);expect(outputBytes).toBeLessThanOrEqual(524288);
  const journal=workflowJournal(f.task);const result=await createOutlineWorkflow(f).run(outlineTaskReference(f.run),journal.context());
  const progress=await f.store.read(f.key);expect(result).toMatchObject({state:'candidate',candidateDigest:progress.candidate?.digest});
  expect(f.exchange).toHaveBeenCalledOnce();expect(f.sessionFor).toHaveBeenCalledOnce();expect(f.allocate).toHaveBeenCalledOnce();
  expect(progress.run.source).toEqual(source);expect(progress.candidate?.source).toEqual(source);expect(progress.candidate?.output).toEqual(f.output);
  expect(progress.candidate?.model).toMatchObject({inputDigest:prepared.inputDigest,outputDigest:hash(f.output),usage:{inputTokens:150,outputTokens:80},evidence:'synthetic_replay'});
  for(const entry of journal.cache.values())expect(Buffer.byteLength(entry.input)).toBeLessThan(131072);
  expect(bytes(journal.cache.get('agent.0.decision')!.output)).toBeLessThan(1048576);expect(bytes(result)).toBeLessThan(1024);
});

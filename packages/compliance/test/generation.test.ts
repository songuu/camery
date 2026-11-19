import {expect,it,vi} from 'vitest';
import {digest,MethodError} from '@camery/methods';
import * as methods from '@camery/methods';
import {prepareClassification,prepareClassificationPlan,prepareClassificationAt,validateClassifiedPrepared,generateClassification,validateClassifiedBatch} from '../src/node/generation.js';
import {generationFixture} from './generation-support.js';
import {hash} from '../src/node/data.js';
it('uses the original provider output receipt while deriving complete canonical classification coverage',async()=>{const f=generationFixture(),result=await generateClassification(f);expect(f.exchange).toHaveBeenCalledOnce();expect(result.rawOutput).toEqual(f.output);expect(result.model.outputDigest).toBe(digest(f.output));expect(result.normalized).not.toEqual(f.output);expect(result.findings).toEqual([]);expect(result.requiresHumanReview).toBe(true);expect(result.model.inputDigest).toBe(prepareClassification(f.scope,f.source,f.policy,0).inputDigest);expect(validateClassifiedBatch(f.scope,f.source,f.policy,0,result)).toEqual(result);});
it.each(['scope','pin','index','abort'] as const)('refuses bad %s before contacting the provider',async mode=>{const f=generationFixture();if(mode==='scope')f.scope.tenantId='foreign';if(mode==='pin')f.method={...f.method,digest:'a'.repeat(64)};if(mode==='index')f.index=999;if(mode==='abort')f.call.signal=AbortSignal.abort();await expect(generateClassification(f)).rejects.toThrow();expect(f.exchange).not.toHaveBeenCalled();});
it('keeps a completed paid classification with missing coverage classified completed and never repair calls',async()=>{const f=generationFixture('live_model');f.output.assessments.pop();await expect(generateClassification(f)).rejects.toMatchObject({code:'COMPLIANCE_INCOMPLETE',outcome:'completed'});expect(f.exchange).toHaveBeenCalledOnce();});
it('preserves known provider unknown outcome and sanitizes unknown exceptions without retries',async()=>{for(const error of [new MethodError('TIMEOUT','fixture','unknown'),new Error('secret://private'),new Proxy({},{getPrototypeOf(){throw new Error('private prototype');}})]){const f=generationFixture(),run=vi.fn(async()=>{throw error;});await expect(generateClassification({...f,runner:{run}})).rejects.toMatchObject({outcome:'unknown',message:expect.not.stringContaining('private')});expect(run).toHaveBeenCalledOnce();expect(f.exchange).not.toHaveBeenCalled();}});
it('captures a reusable complete plan once and rejects JSON substitutes for trusted captured request objects',async()=>{const f=generationFixture(),plan=prepareClassificationPlan(f.scope,f.source,f.policy),prepared=prepareClassificationAt(plan,0);f.source.draft.title+='caller mutation';f.policy.categories[0]!.description+='caller mutation';expect(prepared.input).toEqual(prepareClassificationAt(plan,0).input);expect(()=>prepareClassificationAt({...plan},0)).toThrow();const original=generationFixture(),result=await generateClassification(original),actual=prepareClassificationAt(prepareClassificationPlan(original.scope,original.source,original.policy),0);expect(validateClassifiedPrepared(actual,result)).toEqual(result);expect(()=>validateClassifiedPrepared({...actual},result)).toThrow();});
/** Obtain a real Method envelope from the synthetic transport, then adversarially substitute one boundary value. */
async function executionFixture(evidence:'synthetic_replay'|'live_model'='live_model'){
  const f=generationFixture(evidence),prepared=prepareClassification(f.scope,f.source,f.policy,0),execution=await f.runner.run(f.method,prepared.input,f.call);
  return {...f,execution:structuredClone(execution)};
}
it.each(['method','tenant','connection','mode','call','input','evidence','network','effect'] as const)('rejects a mismatched %s trace without assigning a completed paid outcome',async mode=>{
  const f=await executionFixture(),execution=f.execution,trace=execution.trace[0]!,receipt=trace.modelCall!;
  if(mode==='method')execution.method.digest='c'.repeat(64);
  if(mode==='tenant')receipt.tenantId='another-tenant';
  if(mode==='connection')receipt.connectionId='another-connection';
  if(mode==='mode')receipt.modeDigest='c'.repeat(64);
  if(mode==='call')receipt.callId='another-call';
  if(mode==='input')receipt.inputDigest='c'.repeat(64);
  if(mode==='evidence')trace.evidence='synthetic_replay';
  if(mode==='network')trace.network=false;
  if(mode==='effect')trace.effect='read';
  const run=vi.fn(async()=>execution);await expect(generateClassification({...f,runner:{run}})).rejects.toMatchObject({code:'COMPLIANCE_CONFLICT',outcome:'unknown'});expect(run).toHaveBeenCalledOnce();expect(f.exchange).toHaveBeenCalledOnce();
});
it.each(['outputDigest','output'] as const)('retains the completed paid outcome when bound receipt %s fails output validation',async mode=>{
  const f=await executionFixture();if(mode==='outputDigest')f.execution.trace[0]!.modelCall!.outputDigest='c'.repeat(64);else f.execution.output={version:1,assessments:[]};
  const run=vi.fn(async()=>f.execution);await expect(generateClassification({...f,runner:{run}})).rejects.toMatchObject({outcome:'completed'});expect(run).toHaveBeenCalledOnce();expect(f.exchange).toHaveBeenCalledOnce();
});
it.each(['tenantId','connectionId','modeDigest','idempotencyKey','signal'] as const)('rejects a call %s accessor without invoking it or contacting the provider',async field=>{
  const f=generationFixture(),getter=vi.fn(()=>{throw new Error('secret://call');});Object.defineProperty(f.call,field,{get:getter});await expect(generateClassification(f)).rejects.toMatchObject({code:'INVALID_INPUT',message:expect.not.stringContaining('secret')});expect(getter).not.toHaveBeenCalled();expect(f.exchange).not.toHaveBeenCalled();
});
it('does not execute provider output accessors while capturing a result',async()=>{
  const f=await executionFixture(),getter=vi.fn(()=>{throw new Error('secret://output');});Object.defineProperty(f.execution,'output',{get:getter});const run=vi.fn(async()=>f.execution);await expect(generateClassification({...f,runner:{run}})).rejects.toMatchObject({outcome:'unknown',message:expect.not.stringContaining('secret')});expect(getter).not.toHaveBeenCalled();expect(run).toHaveBeenCalledOnce();
});
it('captures caller-owned source, policy, pin and call binding before the model await',async()=>{
  const f=await executionFixture(),method={...f.method},expected=await generateClassification(generationFixture('live_model')),run=vi.fn(async()=>{
    f.source.draft.title+=' changed';f.policy.categories[0]!.description+=' changed';method.digest='c'.repeat(64);f.call.connectionId='changed';f.call.idempotencyKey='changed';return f.execution;
  });const result=await generateClassification({...f,method,runner:{run}});expect(result).toEqual(expected);expect(run).toHaveBeenCalledOnce();expect(f.exchange).toHaveBeenCalledOnce();
});
it.each(['synthetic_replay','live_model'] as const)('reports cancellation after a trusted %s receipt without a replacement call',async evidence=>{
  const f=await executionFixture(evidence),controller=new AbortController(),run=vi.fn(async()=>{controller.abort();return f.execution;});await expect(generateClassification({...f,call:{...f.call,signal:controller.signal},runner:{run}})).rejects.toMatchObject({code:'ABORTED',outcome:evidence==='live_model'?'completed':'not_applicable'});expect(run).toHaveBeenCalledOnce();expect(f.exchange).toHaveBeenCalledOnce();
});
it('sanitizes runner binding failures before spending a call',async()=>{
  const f=generationFixture(),runner=Object.defineProperty({},'run',{get(){throw new Error('secret://runner');}}) as Pick<typeof f.runner,'run'>;await expect(generateClassification({...f,runner})).rejects.toMatchObject({code:'EXECUTION_FAILED',outcome:'not_sent',message:expect.not.stringContaining('secret')});expect(f.exchange).not.toHaveBeenCalled();
});
it('rejects a foreign call tenant even when the screenplay and method scope are valid',async()=>{
  const f=generationFixture();await expect(generateClassification({...f,call:{...f.call,tenantId:'foreign'}})).rejects.toMatchObject({code:'FORBIDDEN'});expect(f.exchange).not.toHaveBeenCalled();
});
it('does not trust a rehashed derived finding summary in place of the original full model matrix',async()=>{
  const f=generationFixture(),result=structuredClone(await generateClassification(f));result.normalized.assessments[0]!.reason='替换的派生解释';const {digest:_old,...body}=result;result.digest=hash(body);expect(()=>validateClassifiedBatch(f.scope,f.source,f.policy,0,result)).toThrow(expect.objectContaining({code:'CONFLICT'}));
});
it.each(['limit','opaque'] as const)('maps %s request-preparation dependency failures without invoking a model',mode=>{
  const error=mode==='limit'?new MethodError('DATA_LIMIT','complete method envelope'):new Proxy({},{getPrototypeOf(){throw new Error('secret://dependency');}}),code=mode==='limit'?'INPUT_LIMIT':'INVALID_INPUT';
  const f=generationFixture(),spy=vi.spyOn(methods,'prepareStructuredGenerationRequest').mockImplementationOnce(()=>{throw error;});try{expect(()=>prepareClassification(f.scope,f.source,f.policy,0)).toThrow(expect.objectContaining({code,message:expect.not.stringContaining('secret')}));expect(f.exchange).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});
it('counts the complete serialized model request against the host input quota before any provider call',()=>{
  const f=generationFixture(),prepared=prepareClassification(f.scope,f.source,f.policy,0),request=methods.prepareStructuredGenerationRequest(prepared.pack,prepared.input),spy=vi.spyOn(methods,'prepareStructuredGenerationRequest').mockReturnValueOnce({...request,messages:[{role:'user',content:'x'.repeat(2097152)}]});try{expect(()=>prepareClassification(f.scope,f.source,f.policy,0)).toThrow(expect.objectContaining({code:'INPUT_LIMIT'}));expect(f.exchange).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});

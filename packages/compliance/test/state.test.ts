import {expect,it} from 'vitest';
import {validateScanRun,scanExecution,batchTaskId,batchCallId,validateRunBatch,captureScanBatchProgress} from '../src/node/state.js';
import {generateClassification} from '../src/node/generation.js';

import {hash} from '../src/node/data.js';
import {scanFixture} from './scan-support.js';

it('binds complete source/rules/manifest and fixed model execution with stable task identities',async()=>{const f=scanFixture();expect(validateScanRun(f.key,f.run)).toEqual(f.run);expect(batchTaskId(f.key,0)).not.toBe(batchTaskId(f.key,1));expect(batchTaskId(f.key,0)).not.toBe(batchTaskId({...f.key,projectId:'other'},0));f.call.idempotencyKey=batchCallId(f.key,0);expect(validateRunBatch(f.run,0,await generateClassification(f))).toMatchObject({batchIndex:0,requiresHumanReview:true});});
it.each(['scope','manifest','policy','literal','method','requestDigest','author'] as const)('rejects a rehashed run with altered %s',mode=>{const f=scanFixture(),r=structuredClone(f.run);if(mode==='scope')r.projectId='foreign';if(mode==='manifest')r.manifest[0]!.segmentIds.pop();if(mode==='policy')r.policy.categories[0]!.description+='different';if(mode==='literal')r.literal.coveredSegments.pop();if(mode==='method')r.method.digest='c'.repeat(64);if(mode==='requestDigest')r.requestDigest='c'.repeat(64);if(mode==='author')r.authorId='foreign';const {digest:_old,...body}=r;r.digest=hash(body);expect(()=>validateScanRun(f.key,r)).toThrow();});
it('reserves the entire scan before per-batch execution, rejecting either underfunded dimension or insufficient steps',()=>{const f=scanFixture();for(const field of ['steps','tokens','costMicros'] as const)expect(()=>scanExecution({...f.execution,limits:{...f.execution.limits,[field]:0}},2)).toThrow();expect(()=>scanExecution(f.execution,8193)).toThrow();expect(()=>scanExecution({...f.execution,evidence:'live_model',reservation:{tokens:1,costMicros:0}},1)).toThrow();});
it('rejects a foreign but internally valid model call instead of assigning it to another batch',async()=>{const f=scanFixture(),result=await generateClassification(f);expect(()=>validateRunBatch(f.run,0,result)).toThrow();expect(()=>validateRunBatch(f.run,999,result)).toThrow();});
it('captures the run and original result independently, retaining null as the sole missing-result sentinel',async()=>{
  const f=scanFixture();f.call.idempotencyKey=batchCallId(f.key,0);const result=await generateClassification(f),input={run:f.run,result};expect(captureScanBatchProgress(f.key,0,input)).toEqual(input);expect(captureScanBatchProgress(f.key,0,{...input,result:null})).toEqual({run:f.run,result:null});expect(()=>captureScanBatchProgress(f.key,0,{...input,result:false})).toThrow();expect(()=>captureScanBatchProgress(f.key,1,input)).toThrow();expect(()=>captureScanBatchProgress({...f.key,runId:'foreign'},0,input)).toThrow();
});
it.each(['run','result'] as const)('does not invoke a progress %s accessor',field=>{
  const f=scanFixture();let reads=0;const input=Object.defineProperty({run:f.run,result:null},field,{get(){reads++;throw new Error('secret://progress');}});expect(()=>captureScanBatchProgress(f.key,0,input)).toThrow(expect.objectContaining({code:'STORAGE_FAILED',message:expect.not.stringContaining('secret')}));expect(reads).toBe(0);
});
it.each([null,{},Object.create({run:null,result:null}),new Proxy({},{ownKeys(){throw new Error('secret://keys');}}),new Proxy({},{getPrototypeOf(){throw new Error('secret://prototype');}})])('rejects malformed or opaque progress views without disclosing driver details',input=>{
  const f=scanFixture();expect(()=>captureScanBatchProgress(f.key,0,input)).toThrow(expect.objectContaining({code:'STORAGE_FAILED',message:expect.not.stringContaining('secret')}));
});
it.each(['connectionId','modeDigest','modelIdentity','evidence','callId'] as const)('refuses an internally rehashed classification with a foreign %s profile',async field=>{
  const f=scanFixture();f.call.idempotencyKey=batchCallId(f.key,0);const result=structuredClone(await generateClassification(f));if(field==='modeDigest')result.model.modeDigest='c'.repeat(64);else if(field==='evidence')result.model.evidence='live_model';else result.model[field]='foreign';const {digest:_old,...body}=result;result.digest=hash(body);expect(()=>validateRunBatch(f.run,0,result)).toThrow(expect.objectContaining({code:'CONFLICT'}));
});

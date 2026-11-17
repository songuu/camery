import { describe,expect,it } from 'vitest';
import { outlineExecution,outlineRunDigest,outlineTaskId,outlineCallId,validateOutlineRun } from '../src/outline/node/persistence-contracts.js';
import { prepareOutline } from '../src/outline/node/generation.js';
import { outlineModelFixture } from './outline-model-support.js';
import { stepIdempotencyKey } from '@camery/durable';
import { captureOutlineBrief } from '../src/outline/node/brief.js';
import { OUTLINE_ENVELOPE_BYTES } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import type { OutlineExecution,OutlineRun } from '../src/outline/node/persistence-contracts.js';

function executionInput(){return {connectionId:'fixture-outline',modeDigest:'a'.repeat(64),modelIdentity:'fixture/outline',evidence:'synthetic_replay' as const,modelTier:'balanced' as const,currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:1,tokens:100,costMicros:0}};}
async function runFixture(){
  const f=await outlineModelFixture();const profile=f.session.profile;const execution=outlineExecution({...executionInput(),connectionId:profile.connectionId,modeDigest:profile.modeDigest,modelIdentity:profile.modelIdentity,evidence:profile.evidence});
  const key={tenantId:f.brief.tenantId,projectId:f.brief.projectId,runId:'outline-one'};
  const body={version:1 as const,...key,brief:f.brief,source:f.source,method:prepareOutline(f.brief,f.source).method,execution};
  return {f,key,body,run:{...body,digest:outlineRunDigest(body),createdAt:'2026-11-17T11:05:00.000Z'}};
}
function runBody(run:OutlineRun){const {digest:_digest,createdAt:_createdAt,...body}=run;return body;}
function reseal(run:OutlineRun){return {...run,digest:outlineRunDigest(runBody(run))};}

describe('immutable outline execution identity',()=>{
  it('binds the complete brief, source, fixed method and one-call model profile',async()=>{
    const f=await outlineModelFixture();const execution=outlineExecution({connectionId:f.context.connectionId,modeDigest:f.context.modeDigest,modelIdentity:f.session.profile.modelIdentity,evidence:'synthetic_replay',modelTier:'balanced',currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:1,tokens:100,costMicros:0}});
    const key={tenantId:f.brief.tenantId,projectId:f.brief.projectId,runId:'outline-one'};const body={version:1 as const,...key,brief:f.brief,source:f.source,method:prepareOutline(f.brief,f.source).method,execution};
    const run={...body,digest:outlineRunDigest(body),createdAt:'2026-11-17T11:05:00.000Z'};
    expect(validateOutlineRun(key,run)).toEqual(run);expect(outlineTaskId(key)).toMatch(/^outline-[a-f0-9]{64}$/);expect(outlineCallId(key)).not.toBe(outlineTaskId(key));
    expect(()=>validateOutlineRun({...key,tenantId:'foreign'},run)).toThrow('CONFLICT');expect(()=>validateOutlineRun(key,{...run,digest:'b'.repeat(64)})).toThrow('CONFLICT');
  });
  it('rejects unreserved live cost, insufficient shares, invalid execution and noncanonical dates',()=>{
    const execution={connectionId:'fixture',modeDigest:'a'.repeat(64),modelIdentity:'fixture/model',evidence:'live_model',modelTier:'balanced',currency:'CNY',reservation:{tokens:100,costMicros:0},limits:{steps:1,tokens:100,costMicros:0}};
    expect(()=>outlineExecution(execution)).toThrow('INVALID_INPUT');expect(()=>outlineExecution({...execution,evidence:'synthetic_replay',limits:{steps:1,tokens:99,costMicros:0}})).toThrow('INPUT_LIMIT');expect(()=>outlineExecution({})).toThrow('INVALID_INPUT');
  });
  it('captures one-stage execution and run material before returning a deeply frozen snapshot',async()=>{
    const f=await runFixture();const input=structuredClone(f.run);const actual=validateOutlineRun(f.key,input);
    input.execution.reservation.tokens=99;input.brief.notes='later caller edit';Object.assign(input.source,{digest:'b'.repeat(64)});
    expect(actual.execution.reservation.tokens).toBe(100);expect(actual.brief.notes).toBe(f.f.brief.notes);expect(actual.source.digest).toBe(f.f.source.digest);
    for(const value of [actual,actual.brief,actual.source.material,actual.source.references,actual.execution,actual.execution.reservation,actual.method])expect(Object.isFrozen(value)).toBe(true);
    const execution=executionInput();const captured=outlineExecution(execution);execution.reservation.tokens=99;expect(captured.reservation.tokens).toBe(100);expect(Object.isFrozen(captured.limits)).toBe(true);
  });
  it.each(['tenantId','projectId','runId'] as const)('rejects a different requested run %s even with otherwise valid material',async field=>{
    const f=await runFixture();expect(()=>validateOutlineRun({...f.key,[field]:'different'},f.run)).toThrow('CONFLICT');
    const input=structuredClone(f.run);Object.assign(input,{[field]:'different'});expect(()=>validateOutlineRun(f.key,reseal(input))).toThrow('CONFLICT');
  });
  it.each(['tenantId','projectId'] as const)('rejects a valid brief belonging to a different %s',async field=>{
    const f=await runFixture();const raw=structuredClone(f.run);const {version:_version,profiles:_profiles,digest:_digest,...input}=raw.brief;
    raw.brief=captureOutlineBrief({...input,[field]:'different'});expect(()=>validateOutlineRun(f.key,reseal(raw))).toThrow('CONFLICT');
  });
  const executionChanges:readonly [string,(execution:OutlineExecution)=>void][]=[
    ['connection',value=>{value.connectionId='other-connection';}],
    ['mode digest',value=>{value.modeDigest='b'.repeat(64);}],
    ['model identity',value=>{value.modelIdentity='other/model';}],
    ['evidence and explicit free price',value=>{value.evidence='live_model';value.pricing={inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0};}],
    ['currency',value=>{value.currency='USD';}],
    ['pricing',value=>{value.pricing={inputMicrosPerMillionTokens:1,outputMicrosPerMillionTokens:2};}],
    ['reserved tokens',value=>{value.reservation.tokens=99;}],
    ['reserved cost',value=>{value.reservation.costMicros=1;value.limits.costMicros=1;}],
    ['step budget',value=>{value.limits.steps=2;}],
    ['token budget',value=>{value.limits.tokens=101;}],
    ['cost budget',value=>{value.limits.costMicros=1;}],
  ];
  it.each(executionChanges)('binds %s to the original run digest',async(_name,change)=>{
    const f=await runFixture();const changed=structuredClone(f.run);change(changed.execution);
    expect(()=>outlineExecution(changed.execution)).not.toThrow();
    expect(outlineRunDigest(runBody(changed))).not.toBe(f.run.digest);expect(()=>validateOutlineRun(f.key,changed)).toThrow('CONFLICT');
  });
  it.each(['id','version','digest'] as const)('rejects a different fixed method %s even after recalculating run identity',async field=>{
    const f=await runFixture();const changed=structuredClone(f.run);Object.assign(changed.method,{[field]:field==='id'?'different-method':field==='version'?'1.0.1':'b'.repeat(64)});
    expect(()=>validateOutlineRun(f.key,reseal(changed))).toThrow('CONFLICT');
  });
  it.each(['brief revision','source material','source review','profile pin','source citation'] as const)('rejects changed %s without accepting self-reported replacement evidence',async kind=>{
    const f=await runFixture();const changed=structuredClone(f.run);
    if(kind==='brief revision')changed.brief.revision++;
    if(kind==='profile pin')changed.brief.profiles[0]!.digest='b'.repeat(64);
    if(kind==='source material')Object.assign(changed.source.material as object,{unreviewed:'replacement'});
    if(kind==='source review')Object.assign(changed.source.descriptor,{foundationReviewDigest:'b'.repeat(64)});
    if(kind==='source citation')Object.assign(changed.source.references[0]!,{id:'source:replacement'});
    expect(()=>validateOutlineRun(f.key,reseal(changed))).toThrow();
  });
  it.each([
    {createdAt:'2026-11-17',code:'CONFLICT'},{createdAt:'2026-11-17T11:05:00Z',code:'CONFLICT'},
    {createdAt:'2026-11-17T19:05:00.000+08:00',code:'INVALID_INPUT'},{createdAt:'2026-02-30T11:05:00.000Z',code:'CONFLICT'},
    {createdAt:'2026-11-17T11:05:00.000Z\n',code:'INVALID_INPUT'},{createdAt:'not-a-date',code:'CONFLICT'},
  ])('rejects noncanonical createdAt $createdAt',async({createdAt,code})=>{
    const f=await runFixture();expect(()=>validateOutlineRun(f.key,{...f.run,createdAt})).toThrow(code);
  });
  it('requires run identity fields and rejects unversioned or unknown record metadata',async()=>{
    const f=await runFixture();for(const field of ['version','tenantId','projectId','runId','brief','source','method','execution','digest','createdAt']){
      const input:Record<string,unknown>={...f.run};delete input[field];expect(()=>validateOutlineRun(f.key,input)).toThrow('INVALID_INPUT');
    }
    expect(()=>validateOutlineRun(f.key,{...f.run,version:2})).toThrow('INVALID_INPUT');
    expect(()=>validateOutlineRun(f.key,{...f.run,approved:true})).toThrow('INVALID_INPUT');
    expect(()=>outlineRunDigest({...f.body,digest:f.run.digest})).toThrow('INVALID_INPUT');
    expect(()=>outlineRunDigest({...f.body,createdAt:f.run.createdAt})).toThrow('INVALID_INPUT');
  });
  it('rejects oversized runs and hostile accessors before schema traversal without exposing their contents',async()=>{
    const f=await runFixture();expect(()=>validateOutlineRun(f.key,{...f.run,source:{text:'x'.repeat(OUTLINE_ENVELOPE_BYTES)}})).toThrow('INPUT_LIMIT');
    expect(()=>outlineRunDigest({...f.body,brief:'x'.repeat(OUTLINE_ENVELOPE_BYTES)})).toThrow('INPUT_LIMIT');
    let called=false;const input=Object.defineProperty({...f.run},'execution',{enumerable:true,get(){called=true;throw new Error('secret');}});
    expect(()=>validateOutlineRun(f.key,input)).toThrow('INVALID_INPUT');expect(called).toBe(false);
    expect(()=>validateOutlineRun(f.key,new Proxy({},{ownKeys(){throw new Error('secret');}}))).not.toThrow('secret');
    expect(()=>outlineRunDigest({...f.body,digest:hash('untrusted')})).toThrow('INVALID_INPUT');
  });
});

describe('one-stage outline budget contract',()=>{
  it('accepts one step, a synthetic replay without price and explicitly free live planning without claiming a call occurred',()=>{
    const synthetic=outlineExecution(executionInput());expect(synthetic).toMatchObject({evidence:'synthetic_replay',limits:{steps:1,tokens:100,costMicros:0}});expect(synthetic).not.toHaveProperty('pricing');
    const live=outlineExecution({...executionInput(),evidence:'live_model',pricing:{inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0}});
    expect(live).toMatchObject({evidence:'live_model',pricing:{inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0}});
    const reserved=outlineExecution({...executionInput(),evidence:'live_model',reservation:{tokens:100,costMicros:1},limits:{steps:1,tokens:100,costMicros:1}});
    expect(reserved.reservation.costMicros).toBe(1);expect(reserved).not.toHaveProperty('usage');expect(reserved).not.toHaveProperty('receipt');
  });
  it.each([
    {inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:1},
    {inputMicrosPerMillionTokens:1,outputMicrosPerMillionTokens:0},
    {inputMicrosPerMillionTokens:1,outputMicrosPerMillionTokens:1},
  ])('requires a nonzero live cost reservation when any configured price is positive %#',pricing=>{
    expect(()=>outlineExecution({...executionInput(),evidence:'live_model',pricing})).toThrow('INVALID_INPUT');
    expect(outlineExecution({...executionInput(),evidence:'live_model',pricing,reservation:{tokens:100,costMicros:1},limits:{steps:1,tokens:100,costMicros:1}}).reservation.costMicros).toBe(1);
  });
  it('accepts exact safe-integer limits without the two-share foundation multiplier',()=>{
    const maximum=Number.MAX_SAFE_INTEGER;
    expect(outlineExecution({...executionInput(),reservation:{tokens:maximum,costMicros:maximum},limits:{steps:1,tokens:maximum,costMicros:maximum}})).toMatchObject({reservation:{tokens:maximum,costMicros:maximum}});
    expect(outlineExecution({...executionInput(),reservation:{tokens:1,costMicros:0},limits:{steps:1,tokens:1,costMicros:0}}).limits.steps).toBe(1);
  });
  it.each([
    {reservation:{tokens:101,costMicros:0},limits:{steps:1,tokens:100,costMicros:0}},
    {reservation:{tokens:100,costMicros:2},limits:{steps:1,tokens:100,costMicros:1}},
    {reservation:{tokens:Number.MAX_SAFE_INTEGER,costMicros:0},limits:{steps:1,tokens:Number.MAX_SAFE_INTEGER-1,costMicros:0}},
    {reservation:{tokens:1,costMicros:Number.MAX_SAFE_INTEGER},limits:{steps:1,tokens:1,costMicros:Number.MAX_SAFE_INTEGER-1}},
  ])('refuses insufficient token or cost limits using exact arithmetic %#',budget=>{
    expect(()=>outlineExecution({...executionInput(),...budget})).toThrow('INPUT_LIMIT');
  });
  const invalidFields:readonly [string,unknown][]=[
    ['connectionId',''],['connectionId','bad\nconnection'],['modeDigest','bad'],['modeDigest','A'.repeat(64)],['modelIdentity',''],['modelIdentity','\ud800'],
    ['evidence','deterministic'],['modelTier','quality'],['currency','cny'],['currency','CN'],['unknown',true],
    ['reservation',{tokens:0,costMicros:0}],['reservation',{tokens:1.5,costMicros:0}],['reservation',{tokens:Number.MAX_SAFE_INTEGER+1,costMicros:0}],
    ['reservation',{tokens:1,costMicros:-1}],['reservation',{tokens:1,costMicros:0.5}],['reservation',{tokens:1,costMicros:Number.MAX_SAFE_INTEGER+1}],
    ['limits',{steps:0,tokens:100,costMicros:0}],['limits',{steps:1.5,tokens:100,costMicros:0}],['limits',{steps:Number.MAX_SAFE_INTEGER+1,tokens:100,costMicros:0}],
    ['limits',{steps:1,tokens:-1,costMicros:0}],['limits',{steps:1,tokens:Infinity,costMicros:0}],['limits',{steps:1,tokens:100,costMicros:NaN}],
    ['pricing',{inputMicrosPerMillionTokens:-1,outputMicrosPerMillionTokens:0}],['pricing',{inputMicrosPerMillionTokens:0.5,outputMicrosPerMillionTokens:0}],
    ['pricing',{inputMicrosPerMillionTokens:0}],['pricing',{inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0,unknown:true}],
  ];
  it.each(invalidFields)('rejects invalid execution %s (%#)',(field,value)=>{
    expect(()=>outlineExecution({...executionInput(),[field]:value})).toThrow('INVALID_INPUT');
  });
});

describe('stable journal and model-call identity',()=>{
  const key={tenantId:'tenant',projectId:'project',runId:'outline-one'};
  it('uses all scope parts and the agreed durable decision step in a deterministic canonical identity',()=>{
    expect(outlineTaskId({...key})).toBe(outlineTaskId({runId:key.runId,projectId:key.projectId,tenantId:key.tenantId}));
    expect(outlineCallId(key)).toBe(stepIdempotencyKey({tenantId:key.tenantId,taskId:outlineTaskId(key)},'agent.0.decision'));
    for(const field of ['tenantId','projectId','runId']){
      const changed={...key,[field]:'other'};expect(outlineTaskId(changed)).not.toBe(outlineTaskId(key));expect(outlineCallId(changed)).not.toBe(outlineCallId(key));
    }
    expect(outlineTaskId({tenantId:'a:b',projectId:'c',runId:'d'})).not.toBe(outlineTaskId({tenantId:'a',projectId:'b:c',runId:'d'}));
    expect(outlineTaskId({...key,runId:'x'.repeat(128)})).toMatch(/^outline-[a-f0-9]{64}$/);
  });
  it.each(['','bad/run','white space','bad\n','x'.repeat(129),null,0])('rejects invalid task/call keys %#',runId=>{
    for(const fn of [outlineTaskId,outlineCallId])expect(()=>fn({...key,runId})).toThrow('INVALID_INPUT');
  });
  it('rejects unknown or hostile key fields without accepting an idempotency override',()=>{
    for(const fn of [outlineTaskId,outlineCallId]){
      expect(()=>fn({...key,idempotencyKey:'user-override'})).toThrow('INVALID_INPUT');
      const input:Record<string,unknown>={...key};delete input['projectId'];expect(()=>fn(input)).toThrow('INVALID_INPUT');
      let invoked=false;expect(()=>fn(Object.defineProperty({...key},'runId',{enumerable:true,get(){invoked=true;return 'override';}}))).toThrow('INVALID_INPUT');expect(invoked).toBe(false);
    }
  });
});

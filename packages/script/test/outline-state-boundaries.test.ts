import { describe,expect,it } from 'vitest';
import { generateOutline } from '../src/outline/node/generation.js';
import { captureOutlineProgress } from '../src/outline/node/state.js';
import { OutlineError } from '../src/outline/contracts.js';
import { OUTLINE_ENVELOPE_BYTES } from '../src/outline/generation-contracts.js';
import type { OutlineCandidate,ReviewedOutline,RejectedOutline } from '../src/outline/generation-contracts.js';
import { hash } from '../src/outline/node/data.js';
import { outlineWorkflowFixture } from './outline-workflow-support.js';

function rehash<T extends {readonly digest:string}>(value:T):T{const {digest:_digest,...body}=value;return {...value,digest:hash(body)};}
async function proposed(evidence:'synthetic_replay'|'live_model'='synthetic_replay'){
  const f=await outlineWorkflowFixture(evidence),candidate=await generateOutline(f);await f.store.saveCandidate(f.key,candidate);
  const decision={candidateDigest:candidate.digest,output:candidate.output,ablations:[{genre:'suspense' as const,judgment:'participates' as const,reason:'测试宿主明确核对辅轴改变主线选择。'}],waivers:[]};
  return {...f,candidate,decision};
}

describe('outline workflow protocol fixture',()=>{
  it('creates an immutable stored run without spending an outline model call or allocation',async()=>{
    const f=await outlineWorkflowFixture();expect((await f.progress()).run).toEqual(f.run);
    expect(f.exchange).not.toHaveBeenCalled();expect(f.allocate).not.toHaveBeenCalled();expect(f.sessionFor).not.toHaveBeenCalled();
    const session=await f.sessionFor({tenantId:f.key.tenantId,projectId:f.key.projectId,execution:f.run.execution},f.task);
    expect(session.profile).toEqual({tenantId:f.key.tenantId,connectionId:f.run.execution.connectionId,modeDigest:f.run.execution.modeDigest,modelIdentity:f.run.execution.modelIdentity,evidence:f.run.execution.evidence});
    expect(session.callsUsed).toBe(0);expect(f.exchange).not.toHaveBeenCalled();
  });
  it.each(['synthetic_replay','live_model'] as const)('respects the %s run profile and returns an independent held allocation',async evidence=>{
    const f=await outlineWorkflowFixture(evidence);expect(f.run.execution).toMatchObject({evidence,reservation:{tokens:300,costMicros:evidence==='live_model'?10:0},limits:{steps:1,tokens:300,costMicros:evidence==='live_model'?10:0}});
    const request={tenantId:f.key.tenantId,projectId:f.key.projectId,taskId:f.task.taskId,allocationId:'fixture-allocation',agent:f.run.method,budget:{maxSteps:1,maxTokens:300,maxCostMicros:f.execution.reservation.costMicros,currency:'CNY'}};
    const allocation=await f.allocate(request);expect(allocation).toEqual({...request,taskFingerprint:hash(request),state:'held',confirmation:null});expect(allocation).not.toBe(request);
    expect(f.allocate).toHaveBeenCalledWith(request);expect(f.exchange).not.toHaveBeenCalled();expect(f.sessionFor).not.toHaveBeenCalled();
  });
  it('captures explicit one-call reservation overrides and free-live pricing',async()=>{
    const f=await outlineWorkflowFixture('live_model',{reservationTokens:400,reservationCostMicros:0,pricing:{inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0}});
    expect(f.run.execution).toMatchObject({reservation:{tokens:400,costMicros:0},pricing:{inputMicrosPerMillionTokens:0,outputMicrosPerMillionTokens:0}});
  });
});

describe('captured outline workflow progress',()=>{
  it('replays a real saved candidate plus explicit test-host edits and retains the original model receipt',async()=>{
    const f=await proposed();const output=structuredClone(f.candidate.output);output.adaptation.title='测试宿主修订后的钟声';
    const reviewed=await f.store.review(f.key,{...f.decision,output},f.host),progress=await f.progress();
    const captured=captureOutlineProgress(f.key,progress);expect(captured).toEqual(progress);expect(captured.review).toEqual(reviewed);
    expect(captured.candidate!.model).toEqual(f.candidate.model);expect(captured.candidate!.output.adaptation.title).not.toBe(output.adaptation.title);
    expect(Object.isFrozen(captured)).toBe(true);expect(Object.isFrozen(captured.review)).toBe(true);expect(f.exchange).toHaveBeenCalledOnce();
    expect(f.allocate).not.toHaveBeenCalled();expect(f.sessionFor).not.toHaveBeenCalled();
  });
  it('replays an actual stored rejection without treating it as approved or re-running generation',async()=>{
    const f=await proposed();const rejected=await f.store.reject(f.key,'这一版需要重新设计冲突。',f.host),progress=await f.progress();
    expect(captureOutlineProgress(f.key,JSON.parse(JSON.stringify(progress)))).toEqual(progress);expect(progress.review).toEqual(rejected);expect(progress.review!.status).toBe('rejected');expect(f.exchange).toHaveBeenCalledOnce();
  });
  it.each(['tenantId','connectionId','modeDigest','modelIdentity','evidence','callId','inputDigest','outputDigest'] as const)('rejects a rehashed candidate with a foreign model %s',async field=>{
    const f=await proposed();const candidate:{-readonly [K in keyof OutlineCandidate]:OutlineCandidate[K]}=structuredClone(f.candidate);
    if(field==='evidence')candidate.model.evidence='live_model';
    else if(field==='modeDigest'||field==='inputDigest'||field==='outputDigest')candidate.model[field]='b'.repeat(64);
    else candidate.model[field]='foreign-model-binding';
    expect(()=>captureOutlineProgress(f.key,{run:f.run,candidate:rehash(candidate),review:null})).toThrow('INVALID_EVIDENCE');
  });
  it('requires the original candidate even when a review or rejection is otherwise complete',async()=>{
    const f=await proposed();const review=await f.store.review(f.key,f.decision,f.host);
    expect(()=>captureOutlineProgress(f.key,{run:f.run,candidate:null,review})).toThrow('INCOMPLETE');
    const g=await proposed();const rejected=await g.store.reject(g.key,'明确拒绝。',g.host);
    expect(()=>captureOutlineProgress(g.key,{run:g.run,candidate:null,review:rejected})).toThrow('INCOMPLETE');
  });
  const damagedReviews:readonly [string,(input:ReviewedOutline)=>unknown][]=[
    ['candidate identity',review=>rehash({...review,candidateDigest:'b'.repeat(64)})],
    ['recomputed report',review=>rehash({...review,report:{...review.report,issues:[]}})],
    ['missing assessment',review=>rehash({...review,ablations:[]})],
    ['foreign source',review=>rehash({...review,source:{...review.source,digest:'b'.repeat(64)}})],
    ['malformed actor',review=>rehash({...review,actorId:''})],
    ['noncanonical time',review=>rehash({...review,at:'2026-11-17'})],
    ['approval flag',review=>({...review,approved:true})],
  ];
  it.each(damagedReviews)('rejects malformed or inconsistent reviewed %s',async(_name,damage)=>{
    const f=await proposed();const review=await f.store.review(f.key,f.decision,f.host);
    expect(()=>captureOutlineProgress(f.key,{run:f.run,candidate:f.candidate,review:damage(review)})).toThrow(OutlineError);
  });
  const damagedRejections:readonly [string,(input:RejectedOutline)=>unknown][]=[
    ['candidate identity',review=>rehash({...review,candidateDigest:'b'.repeat(64)})],
    ['source identity',review=>rehash({...review,source:{...review.source,digest:'b'.repeat(64)}})],
    ['reason digest',review=>({...review,reason:'未经重新绑定的理由。'})],
    ['blank reason',review=>rehash({...review,reason:'  '})],
    ['noncanonical time',review=>rehash({...review,at:'2026-11-17'})],
    ['malformed actor',review=>rehash({...review,actorId:''})],
  ];
  it.each(damagedRejections)('rejects malformed or inconsistent rejected %s',async(_name,damage)=>{
    const f=await proposed();const rejected=await f.store.reject(f.key,'明确拒绝。',f.host);
    expect(()=>captureOutlineProgress(f.key,{run:f.run,candidate:f.candidate,review:damage(rejected)})).toThrow(OutlineError);
  });
  it('rejects unknown statuses and extra progress authority fields',async()=>{
    const f=await proposed();const review=await f.store.review(f.key,f.decision,f.host),progress=await f.progress();
    expect(()=>captureOutlineProgress(f.key,{run:f.run,candidate:f.candidate,review:{...review,status:'adopted'}})).toThrow('INVALID_INPUT');
    expect(()=>captureOutlineProgress(f.key,{...progress,approved:true})).toThrow('INVALID_INPUT');
  });
  it('captures data before returning and does not execute hostile progress accessors or leak their errors',async()=>{
    const f=await proposed();const raw=structuredClone(await f.progress()),captured=captureOutlineProgress(f.key,raw);
    if(!raw.candidate)throw new Error('Fixture candidate missing');raw.candidate.output.adaptation.title='caller mutation';expect(captured.candidate!.output.adaptation.title).not.toBe('caller mutation');
    let called=false;const accessor=Object.defineProperty({...raw},'run',{enumerable:true,get(){called=true;throw new Error('private source');}});
    expect(()=>captureOutlineProgress(f.key,accessor)).toThrow('INVALID_INPUT');expect(called).toBe(false);
    const cyclic:Record<string,unknown>={run:f.run,candidate:null,review:null};cyclic['review']=cyclic;
    expect(()=>captureOutlineProgress(f.key,cyclic)).toThrow('INVALID_INPUT');expect(()=>captureOutlineProgress(f.key,Object.create(raw))).toThrow('INVALID_INPUT');
    expect(()=>captureOutlineProgress(f.key,new Proxy({},{ownKeys(){throw new Error('private source');}}))).not.toThrow('private source');
  });
  it.each(['run','candidate','review'] as const)('retains the independent %s envelope byte limit inside aggregate progress',async field=>{
    const f=await proposed();const review=await f.store.review(f.key,f.decision,f.host);
    const progress={run:f.run,candidate:f.candidate,review};
    const oversized={...progress,[field]:{...progress[field],oversized:'x'.repeat(OUTLINE_ENVELOPE_BYTES)}};
    expect(()=>captureOutlineProgress(f.key,oversized)).toThrow('INPUT_LIMIT');
  });
  it('rejects aggregate input beyond the three-envelope budget without truncation',async()=>{
    const f=await outlineWorkflowFixture();expect(()=>captureOutlineProgress(f.key,{run:f.run,candidate:'x'.repeat(3*OUTLINE_ENVELOPE_BYTES),review:null})).toThrow('INPUT_LIMIT');
  });
});

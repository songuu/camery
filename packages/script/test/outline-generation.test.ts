import { describe,expect,it } from 'vitest';
import { createStructuredGenerationExecutor,digest,MethodRunner,ModelSession } from '@camery/methods';
import { ModelError,OpenAiCompatibleLlm,RecordingTransport,ReplayTransport } from '@camery/model-modes';
import type { HttpTransport } from '@camery/model-modes';
import type { OutlineCandidate } from '../src/outline/generation-contracts.js';
import { captureOutlineBrief,validateOutlineBrief } from '../src/outline/node/brief.js';
import { generateOutline,prepareOutline,validateOutlineCandidate,createOutlineCandidate } from '../src/outline/node/generation.js';
import { outlineFixture } from './outline-support.js';
import { outlineModelFixture } from './outline-model-support.js';

describe('versioned outline brief',()=>{
  it('pins the effective thresholds and original genre bodies without source or approval claims',()=>{
    const {sourceRefIds:_ids,...context}=outlineFixture().context;
    const input={tenantId:'tenant',projectId:'project',briefId:'outline',revision:1,notes:'保留港城共同记忆的冲突。',...context};
    const brief=captureOutlineBrief(input);expect(brief.profiles.map(profile=>profile.id)).toEqual(['rebirth-revenge','suspense']);
    expect(brief.thresholds.lowEmotionBelow).toBe(6);expect(Object.isFrozen(brief.profiles[0])).toBe(true);expect(validateOutlineBrief(JSON.parse(JSON.stringify(brief)))).toEqual(brief);
    expect(()=>validateOutlineBrief({...brief,digest:'a'.repeat(64)})).toThrow('CONFLICT');expect(()=>validateOutlineBrief({...brief,profiles:[{...brief.profiles[0],digest:'b'.repeat(64)},brief.profiles[1]]})).toThrow('CONFLICT');
  });
});

describe('source-bound outline generation',()=>{
  it('performs one actual structured-adapter call, with fixed method/profile pins and the original receipt',async()=>{
    const f=await outlineModelFixture();const candidate=await generateOutline(f);expect(f.exchange).toHaveBeenCalledOnce();expect(f.session.callsUsed).toBe(1);
    const request=f.exchange.mock.calls[0]![0].body as {messages:{role:string;content:string}[]};
    const wire=JSON.parse(request.messages.at(-1)!.content).untrustedSource;
    expect(wire.brief).toEqual(f.brief);expect(wire.source).toEqual(f.source);expect(wire.profiles.map((profile:{id:string})=>profile.id)).toEqual(['rebirth-revenge','suspense']);
    expect(request.messages[0]!.content).not.toContain(f.brief.notes);expect(candidate.model).toEqual(f.session.receiptFor(f.context));
    expect(candidate.model.outputDigest).toBe(digest(f.output));expect(candidate.status).toBe('candidate');expect(candidate).not.toHaveProperty('actorId');
    expect(validateOutlineCandidate(f.brief,f.source,JSON.parse(JSON.stringify(candidate)))).toEqual(candidate);expect(Object.isFrozen(candidate.output.episodes[0])).toBe(true);
    expect(createOutlineCandidate(f.brief,f.source,f.output,candidate.model)).toEqual(candidate);expect(f.exchange).toHaveBeenCalledOnce();
  });
  it('refuses scope, source, brief and fixed-method changes before dispatch',async()=>{
    for(const kind of ['scope','source','brief','method'] as const){
      const f=await outlineModelFixture();if(kind==='scope')f.context.tenantId='foreign';
      if(kind==='source')f.source={...f.source,digest:'b'.repeat(64)};
      if(kind==='brief')f.brief=structuredClone(f.brief);if(kind==='brief')f.brief.digest='b'.repeat(64);
      if(kind==='method')f.method={...f.method,digest:'b'.repeat(64)};
      await expect(generateOutline(f)).rejects.toThrow();expect(f.exchange).not.toHaveBeenCalled();
    }
  });
  it('keeps live semantic output failures completed and does not retry or accept invented source IDs',async()=>{
    const f=await outlineModelFixture('live_model');f.output.beats[0]!.origin.sourceRefIds=['foreign'];
    await expect(generateOutline(f)).rejects.toMatchObject({code:'OUTLINE_INVALID_REFERENCE',outcome:'completed'});
    await expect(generateOutline(f)).rejects.toMatchObject({code:'MODEL_KEY_REUSE',outcome:'not_sent'});expect(f.exchange).toHaveBeenCalledOnce();
  });
  it.each(['not_sent','unknown','completed'] as const)('retains provider %s without repair or fallback',async outcome=>{
    const f=await outlineModelFixture('live_model');f.exchange.mockRejectedValue(new ModelError('NETWORK_FAILED','protocol failure',outcome));
    await expect(generateOutline(f)).rejects.toMatchObject({outcome});expect(f.exchange).toHaveBeenCalledOnce();
  });
  it('binds receipt input/output evidence instead of accepting a self-reported digest',async()=>{
    const f=await outlineModelFixture();const candidate=await generateOutline(f);
    expect(()=>createOutlineCandidate(f.brief,f.source,f.output,{...candidate.model,inputDigest:'b'.repeat(64)})).toThrow('INVALID_EVIDENCE');
    expect(()=>createOutlineCandidate(f.brief,f.source,{...f.output,adaptation:{...f.output.adaptation,title:'another'}},candidate.model)).toThrow('INVALID_EVIDENCE');
    expect(prepareOutline(f.brief,f.source).method).toEqual(f.method);
  });
  it('exactly replays the recorded outline request and receipt with no live fallback',async()=>{
    const f=await outlineModelFixture();const recording=new RecordingTransport({exchange:f.exchange},{kind:'synthetic_contract',source:'Original outline protocol fixture. No real inference, billing or human quality signoff.',recordedAt:'2026-11-17T10:30:00.000Z'});
    async function run(transport:HttpTransport){
      const session=new ModelSession(new OpenAiCompatibleLlm(transport,{model:'fixture-outline',structuredOutput:'json_schema'}),{...f.session.profile,maxCalls:1,timeoutMs:1000,maxInputBytes:2097152,maxOutputBytes:524288});
      return generateOutline({...f,runner:new MethodRunner(f.methods,[createStructuredGenerationExecutor(session)])});
    }
    const actual=await run(recording);const replay=new ReplayTransport(recording.exportCassette());expect(await run(replay)).toEqual(actual);replay.assertComplete();expect(f.exchange).toHaveBeenCalledOnce();
  });
  it('captures brief, source, pin and context before awaiting a model reply',async()=>{
    const f=await outlineModelFixture();const brief=structuredClone(f.brief),source=structuredClone(f.source),method={...f.method},context={...f.context};
    let release!:()=>void;let began!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{began=resolve;});const exchange=f.exchange.getMockImplementation()!;
    f.exchange.mockImplementation(async(...args)=>{began();await gate;return exchange(...args);});
    const pending=generateOutline({...f,brief,source,method,context});await started;
    brief.notes='mutated';(source as {digest:string}).digest='b'.repeat(64);method.digest='b'.repeat(64);context.tenantId='foreign';release();
    const actual=await pending;expect(actual.brief).toEqual(f.brief);expect(actual.source).toEqual(f.source);expect(actual.method).toEqual(f.method);expect(actual.model.tenantId).toBe(f.brief.tenantId);
  });
  it('refuses pre-dispatch abort without consuming a paid attempt',async()=>{
    const f=await outlineModelFixture('live_model');const controller=new AbortController();controller.abort();
    await expect(generateOutline({...f,context:{...f.context,signal:controller.signal}})).rejects.toMatchObject({code:'ABORTED',outcome:'not_sent'});expect(f.exchange).not.toHaveBeenCalled();
  });
  it.each(['method','tenant','connection','mode','call','input','evidence','network','effect','shape'] as const)('rejects tampered %s execution evidence without fabricating completion',async kind=>{
    const f=await outlineModelFixture();const original=structuredClone(await f.runner.run(f.method,prepareOutline(f.brief,f.source).input,f.context));
    const trace=original.trace[0]!;const receipt=trace.modelCall!;
    if(kind==='method')original.method.digest='b'.repeat(64);if(kind==='tenant')receipt.tenantId='foreign';if(kind==='connection')receipt.connectionId='foreign';if(kind==='mode')receipt.modeDigest='b'.repeat(64);
    if(kind==='call')receipt.callId='foreign';if(kind==='input')receipt.inputDigest='b'.repeat(64);if(kind==='evidence')trace.evidence='live_model';if(kind==='network')trace.network=true;if(kind==='effect')trace.effect='paid';
    const result=kind==='shape'?{status:'adopted'}:original;
    await expect(generateOutline({...f,runner:{run:async()=>result as typeof original}})).rejects.toMatchObject({code:kind==='shape'?'OUTLINE_INVALID_INPUT':'OUTLINE_INVALID_EVIDENCE',outcome:'unknown'});
  });
  it('retains a known completion when aborted after valid original execution evidence',async()=>{
    const f=await outlineModelFixture('live_model');const prepared=prepareOutline(f.brief,f.source);const original=await f.runner.run(f.method,prepared.input,f.context);const controller=new AbortController();
    await expect(generateOutline({...f,context:{...f.context,signal:controller.signal},runner:{run:async()=>{controller.abort();return original;}}})).rejects.toMatchObject({code:'ABORTED',outcome:'completed'});
  });
  it.each(['digest','brief','source','method','receipt'] as const)('refuses rehashed candidate %s tampering against current host bindings',async kind=>{
    const f=await outlineModelFixture();const raw:{-readonly [K in keyof OutlineCandidate]:OutlineCandidate[K]}=structuredClone(await generateOutline(f));
    if(kind==='digest')raw.digest='b'.repeat(64);
    if(kind==='brief'){const {version:_v,profiles:_p,digest:_d,...input}=f.brief;raw.brief=captureOutlineBrief({...input,revision:2});}
    if(kind==='source')raw.source={...raw.source,digest:'b'.repeat(64)};
    if(kind==='method')raw.method.digest='b'.repeat(64);if(kind==='receipt')raw.model.outputDigest='b'.repeat(64);
    if(kind!=='digest'){const {digest:_digest,...body}=raw;raw.digest=digest(body);}
    expect(()=>validateOutlineCandidate(f.brief,f.source,raw)).toThrow();
  });
  it('rejects a source from another project and handles hostile brief data without reading accessors',async()=>{
    const f=await outlineModelFixture();const {version:_v,profiles:_p,digest:_d,...input}=f.brief;
    expect(()=>prepareOutline(captureOutlineBrief({...input,projectId:'other'}),f.source)).toThrow('FORBIDDEN');
    let invoked=false;const bad=Object.defineProperty({...input},'notes',{enumerable:true,get(){invoked=true;throw new Error('secret');}});
    expect(()=>captureOutlineBrief(bad)).toThrow('INVALID_INPUT');expect(invoked).toBe(false);
  });
});

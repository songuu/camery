import { describe,expect,it } from 'vitest';
import { digest } from '@camery/methods';
import { generateOutline,outlineContext } from '../src/outline/node/generation.js';
import { captureOutlineBrief } from '../src/outline/node/brief.js';
import { reviewOutline,rejectOutline,validateReviewedOutline } from '../src/outline/node/review.js';
import { reviewOutlineCraft } from '../src/outline/outline.js';
import type { OutlineReviewHost,ReviewedOutline } from '../src/outline/generation-contracts.js';
import { outlineModelFixture } from './outline-model-support.js';

async function proposed(){const f=await outlineModelFixture();return {...f,candidate:await generateOutline(f)};}
function decision(f:Awaited<ReturnType<typeof proposed>>){return {candidateDigest:f.candidate.digest,output:structuredClone(f.candidate.output),ablations:[{genre:'suspense' as const,judgment:'participates' as const,reason:'人工核对第二集查证确实改变第三集反击条件。'}],waivers:[] as {issueId:string;reason:string}[]};}
describe('explicit human outline review',()=>{
  it('accepts edits only with source/candidate binding, records actual actor and ablation assessment, and replays stored integrity',async()=>{
    const f=await proposed();const input=decision(f);input.output.adaptation.title='人工改名：最后一次钟声';
    const reviewed=reviewOutline(f.brief,f.source,f.candidate,input,f.host);
    expect(reviewed).toMatchObject({status:'reviewed',candidateDigest:f.candidate.digest,actorId:f.host.actor.id,at:f.host.at,output:input.output});
    expect(reviewed.report.issues.map(issue=>issue.code)).toEqual(['ABLATION_REVIEW']);expect(reviewed.waivers).toEqual([]);
    expect(validateReviewedOutline(f.brief,f.source,f.candidate,JSON.parse(JSON.stringify(reviewed)))).toEqual(reviewed);
    expect(reviewed).not.toHaveProperty('qualityScore');expect(Object.isFrozen(reviewed.output)).toBe(true);
  });
  it('rechecks edited output and requires exact located waivers for actual remaining craft issues',async()=>{
    const f=await proposed();const input=decision(f);for(const episode of input.output.episodes){episode.emotionIntensity=5;episode.cliffhanger.type='choice';}
    expect(()=>reviewOutline(f.brief,f.source,f.candidate,input,f.host)).toThrow('INCOMPLETE');
    const report=reviewOutlineCraft(outlineContext(f.brief,f.source),input.output,f.brief.thresholds);
    input.waivers=report.issues.filter(issue=>issue.code!=='ABLATION_REVIEW').map(issue=>({issueId:issue.id,reason:'人工选择在本单元保持蓄势与同类卡点，后续成片复核效果。'}));
    expect(reviewOutline(f.brief,f.source,f.candidate,input,f.host).waivers).toEqual(input.waivers);
    input.output.episodes[0]!.openingHook.beatId='foreign';expect(()=>reviewOutline(f.brief,f.source,f.candidate,input,f.host)).toThrow('INVALID_REFERENCE');
  });
  it('requires every auxiliary assessment and an explicit waiver for label-only genre participation',async()=>{
    const f=await proposed();const input=decision(f);input.ablations=[];expect(()=>reviewOutline(f.brief,f.source,f.candidate,input,f.host)).toThrow('INCOMPLETE');
    const label={...decision(f),ablations:[{genre:'suspense' as const,judgment:'label_only' as const,reason:'当前辅轴没有改变主线，记录为人工例外。'}]};
    expect(()=>reviewOutline(f.brief,f.source,f.candidate,label,f.host)).toThrow('INCOMPLETE');
    label.waivers=[{issueId:'ABLATION_REVIEW:recipe.ablations.0',reason:'本次明确接受标签型辅轴，下一版再加强因果。'}];
    expect(reviewOutline(f.brief,f.source,f.candidate,label,f.host).ablations[0]!.judgment).toBe('label_only');
  });
  it('denies machine, cross-scope, false, throwing and asynchronous authorization hosts',async()=>{
    const f=await proposed();const input=decision(f);
    const hosts=[{...f.host,tenantId:'foreign'},{...f.host,projectId:'foreign'},{...f.host,actor:{kind:'agent',id:'agent'}},{...f.host,at:'2026-11-17'},
      {...f.host,authorize:()=>false},{...f.host,authorize:()=>{throw new Error('secret');}},{...f.host,authorize:()=>Promise.reject(new Error('secret'))}];
    for(const host of hosts)expect(()=>reviewOutline(f.brief,f.source,f.candidate,input,host as unknown as OutlineReviewHost)).toThrow('FORBIDDEN');
  });
  it('rejects a bound candidate and records reason without approving edits or formal adoption',async()=>{
    const f=await proposed();const result=rejectOutline(f.brief,f.source,f.candidate,'冲突需要重新整理。',f.host);expect(result).toMatchObject({status:'rejected',candidateDigest:f.candidate.digest,reason:'冲突需要重新整理。',actorId:f.host.actor.id});expect(result).not.toHaveProperty('output');
  });
  it.each(['candidate','duplicate-assessment','foreign-assessment','wildcard','duplicate-waiver','unneeded-waiver','blank-reason'] as const)('refuses %s review decisions',async kind=>{
    const f=await proposed();const input=decision(f);
    if(kind==='candidate')input.candidateDigest='b'.repeat(64);
    if(kind==='duplicate-assessment')input.ablations.push(input.ablations[0]!);
    if(kind==='foreign-assessment')input.ablations[0]!.genre='sweet-romance' as never;
    if(kind==='wildcard')input.waivers=[{issueId:'*',reason:'全部忽略。'}];
    if(kind==='duplicate-waiver')input.waivers=[{issueId:'fake',reason:'one'},{issueId:'fake',reason:'two'}];
    if(kind==='unneeded-waiver')input.waivers=[{issueId:'ABLATION_REVIEW:recipe.ablations.0',reason:'已人工判断参与，不应再冒充未处理问题。'}];
    if(kind==='blank-reason')input.ablations[0]!.reason='   ';
    expect(()=>reviewOutline(f.brief,f.source,f.candidate,input,f.host)).toThrow();
  });
  it.each(['report','brief','source','actor','timestamp','digest'] as const)('rejects malformed or inconsistent stored %s',async kind=>{
    const f=await proposed();const raw:{-readonly [K in keyof ReviewedOutline]:ReviewedOutline[K]}=structuredClone(reviewOutline(f.brief,f.source,f.candidate,decision(f),f.host));
    if(kind==='report')raw.report={...raw.report,issues:[]};
    if(kind==='brief')raw.brief={...raw.brief,notes:'another'};
    if(kind==='source')raw.source={...raw.source,digest:'b'.repeat(64)};
    if(kind==='actor')(raw as {actorId:string}).actorId='';if(kind==='timestamp')(raw as {at:string}).at='2026-11-17';
    if(kind==='digest')(raw as {digest:string}).digest='b'.repeat(64);
    else{const {digest:_digest,...body}=raw;(raw as {digest:string}).digest=digest(body);}
    expect(()=>validateReviewedOutline(f.brief,f.source,f.candidate,raw)).toThrow();
  });
  it('captures host data properties, requires canonical time and exposes the exact review/reject action',async()=>{
    const f=await proposed();const actions:string[]=[];const host={...f.host,authorize:(request:{action:string})=>{actions.push(request.action);return true;}};
    reviewOutline(f.brief,f.source,f.candidate,decision(f),host);rejectOutline(f.brief,f.source,f.candidate,'人工拒绝。',host);expect(actions).toEqual(['outline:review','outline:reject']);
    let called=false;const bad=Object.defineProperty({...f.host},'authorize',{get(){called=true;throw new Error('secret');}});
    expect(()=>reviewOutline(f.brief,f.source,f.candidate,decision(f),bad)).toThrow('FORBIDDEN');expect(called).toBe(false);
    expect(()=>reviewOutline(f.brief,f.source,f.candidate,decision(f),{...f.host,authorize:1 as never})).toThrow('FORBIDDEN');
    expect(()=>rejectOutline(f.brief,f.source,f.candidate,' ',f.host)).toThrow('INVALID_INPUT');
    expect(()=>rejectOutline(f.brief,f.source,f.candidate,'拒绝。',{...f.host,authorize:()=>false})).toThrow('FORBIDDEN');
  });
  it('uses the edited output and reports every real issue instead of reusing the model proposal report',async()=>{
    const f=await proposed();const input=decision(f);input.output.episodes[0]!.openingHook.estimatedSecond=4;
    expect(()=>reviewOutline(f.brief,f.source,f.candidate,input,f.host)).toThrow('INCOMPLETE');
    input.waivers=[{issueId:'LATE_OPENING_HOOK:episodes.0.openingHook',reason:'先以一个动作确立空间，人工接受4秒的计划。'}];
    const actual=reviewOutline(f.brief,f.source,f.candidate,input,f.host);expect(actual.report.issues.map(issue=>issue.code)).toEqual(['LATE_OPENING_HOOK','ABLATION_REVIEW']);
    expect(actual.report.emotionCurve).toEqual(input.output.episodes.map(episode=>({episodeNumber:episode.number,intensity:episode.emotionIntensity})));
  });
  it('carries a complete legal plan larger than the old development envelope through generation and review',async()=>{
    const f=await outlineModelFixture();const sample=f.output.assets[0]!,choice=f.output.adaptation.decisions[0]!;
    f.output.assets=Array.from({length:128},(_,index)=>({...sample,id:`asset-${index}`,description:'x'.repeat(1000),narrativeRole:'y'.repeat(1000)}));
    f.output.adaptation.decisions=Array.from({length:128},(_,index)=>({...choice,id:`decision-${index}`,reason:'z'.repeat(1000)}));
    const size=Buffer.byteLength(JSON.stringify(f.output));expect(size).toBeGreaterThan(262144);expect(size).toBeLessThanOrEqual(524288);
    const candidate=await generateOutline(f);const actual={...f,candidate};const reviewed=reviewOutline(f.brief,f.source,candidate,decision(actual),f.host);
    expect(reviewed.output.assets).toHaveLength(128);expect(validateReviewedOutline(f.brief,f.source,candidate,reviewed)).toEqual(reviewed);
  });
  it('supports an explicitly selected single genre without manufacturing auxiliary questions',async()=>{
    const f=await outlineModelFixture();const {version:_v,digest:_d,profiles:_p,...input}=f.brief;
    f.brief=captureOutlineBrief({...input,auxiliaryGenres:[]});f.output.recipe.auxiliaryGenres=[];f.output.recipe.ablations=[];
    const candidate=await generateOutline(f);const reviewed=reviewOutline(f.brief,f.source,candidate,{candidateDigest:candidate.digest,output:candidate.output,ablations:[],waivers:[]},f.host);
    expect(reviewed.report.issues).toEqual([]);expect(reviewed.ablations).toEqual([]);expect(reviewed.brief.profiles).toHaveLength(1);
  });
  it('normalizes assessment order and locates label-only waivers by the actual ablation path',async()=>{
    const f=await outlineModelFixture();const {version:_v,digest:_d,profiles:_p,...input}=f.brief;
    f.brief=captureOutlineBrief({...input,auxiliaryGenres:['suspense','sweet-romance']});f.output.recipe.auxiliaryGenres=['suspense','sweet-romance'];
    f.output.recipe.ablations.unshift({...f.output.recipe.ablations[0]!,genre:'sweet-romance'});
    const candidate=await generateOutline(f);const reviewed=reviewOutline(f.brief,f.source,candidate,{candidateDigest:candidate.digest,output:candidate.output,
      ablations:[{genre:'sweet-romance',judgment:'label_only',reason:'当前情感辅轴仅装饰，明确保留例外。'},{genre:'suspense',judgment:'participates',reason:'查证改变了反击条件。'}],
      waivers:[{issueId:'ABLATION_REVIEW:recipe.ablations.0',reason:'本次接受情感轴仅作装饰，保留复查。'}]},f.host);
    expect(reviewed.ablations.map(item=>item.genre)).toEqual(['suspense','sweet-romance']);expect(reviewed.waivers[0]!.issueId).toBe('ABLATION_REVIEW:recipe.ablations.0');expect(reviewed.brief.profiles).toHaveLength(3);
  });
});

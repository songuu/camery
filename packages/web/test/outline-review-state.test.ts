import {expect,it,vi} from 'vitest';
import {DEFAULT_RULE_THRESHOLDS,reviewOutlineCraft} from '@camery/script/outline';
import type {OutlineOutput} from '@camery/script/outline';
import type {OutlineRunView} from '@camery/script/outline/http';
import {OutlineCraftReportSchema} from '@camery/script/outline/http';
import {outlineFixture} from '../../script/test/outline-support.js';
import {inspectOutlineDraft,outlineDecision,outlineRequiredIssues} from '../src/outline-review-state.js';

function fixture(){
  const {context,output}=outlineFixture();const digest='a'.repeat(64),at='2026-11-18T01:00:00.000Z';
  const view:OutlineRunView={runId:'outline',runDigest:digest,briefId:'brief',briefRevision:1,createdAt:at,candidateDigest:digest,reviewStatus:null,sourceChanged:false,state:'awaiting_review',task:null,
    brief:{version:1,briefId:'brief',revision:1,notes:'保留钟声因果',episodeCount:context.episodeCount,targetSeconds:context.targetSeconds,paidEpisodeNumbers:context.paidEpisodeNumbers,mainGenre:context.mainGenre,auxiliaryGenres:context.auxiliaryGenres,thresholds:{...DEFAULT_RULE_THRESHOLDS},profiles:[{id:context.mainGenre,version:1,digest},{id:'suspense',version:1,digest}],digest},
    source:{version:1,descriptor:{kind:'development',runId:'development',runDigest:digest,briefDigest:digest,foundationReviewDigest:digest,episodesReviewDigest:digest},material:{},references:context.sourceRefIds.map(id=>({id,path:id})),digest},
    candidate:{digest,output,report:OutlineCraftReportSchema.parse(reviewOutlineCraft(context,output))},review:null};
  const ablations=[{genre:'suspense',judgment:'participates',reason:'查证改变第三集反击的条件。'}];return {view,output,ablations};
}
it('revalidates ordinary edited output with frozen source references and preserves exact edits',()=>{
  const {view,output,ablations}=fixture();const draft=structuredClone(output);draft.adaptation.title='最后一次钟声';
  const inspected=inspectOutlineDraft(view,draft);expect(inspected).toMatchObject({valid:true,issues:[],limit:524288,output:draft});expect(inspected.report?.issues.map(x=>x.code)).toEqual(['ABLATION_REVIEW']);
  expect(inspected.bytes).toBe(new TextEncoder().encode(JSON.stringify(draft)).length);expect(view.candidate!.output.adaptation.title).toBe('停钟之夜');
  expect(outlineDecision(view,draft,ablations,[])).toEqual({candidateDigest:view.candidateDigest,output:draft,ablations,waivers:[]});
});
it.each(['character','source','beat','episode','paid','genre','duplicate','protagonist'] as const)('rejects invalid %s references instead of repairing the draft',kind=>{
  const {view,output,ablations}=fixture();
  if(kind==='character')output.beats[0]!.characterIds=['missing'];
  if(kind==='source')output.characters[0]!.origin.sourceRefIds=['foreign'];
  if(kind==='beat')output.episodes[0]!.openingHook.beatId='b3';
  if(kind==='episode')output.episodes[0]!.number=2;
  if(kind==='paid')output.episodes[0]!.paidBreakpoint=true;
  if(kind==='genre')output.recipe.mainGenre='sweet-romance';
  if(kind==='duplicate')output.beats.push({...output.beats[0]!});
  if(kind==='protagonist')output.characters[0]!.function='supporting';
  expect(inspectOutlineDraft(view,output)).toMatchObject({valid:false});expect(inspectOutlineDraft(view,output).issues.join()).toMatch(/引用|集数|主角|顺序|字段|条目/);
  expect(outlineDecision(view,output,ablations,[])).toBeNull();
});
it('recomputes every craft issue from edits and requires exactly located reasoned waivers',()=>{
  const {view,output,ablations}=fixture();for(const episode of output.episodes){episode.emotionIntensity=3;episode.cliffhanger.type='choice';}output.episodes[0]!.openingHook.estimatedSecond=9;output.episodes[0]!.stakes.estimatedSecond=15;
  const inspected=inspectOutlineDraft(view,output);expect(inspected.valid).toBe(true);expect(inspected.report?.issues.map(x=>x.code)).toEqual(expect.arrayContaining(['LOW_EMOTION','REPEATED_CLIFFHANGER','LATE_OPENING_HOOK','LATE_STAKES']));
  const required=outlineRequiredIssues(inspected.report!,output,ablations)!;expect(required.every(x=>x.code!=='ABLATION_REVIEW')).toBe(true);
  const waivers=required.map(issue=>({issueId:issue.id,reason:'保留本单元蓄势，人工接受此项创作风险。'}));
  expect(outlineDecision(view,output,ablations,[])).toBeNull();expect(outlineDecision(view,output,ablations,waivers)).toMatchObject({waivers});
  for(const invalid of [waivers.slice(1),[...waivers,waivers[0]!],[...waivers,{issueId:'*',reason:'全部忽略'}],waivers.map((w,i)=>i? w:{...w,reason:'   '})])expect(outlineDecision(view,output,ablations,invalid)).toBeNull();
});
it('requires explicit auxiliary judgments and only label-only assessments require ablation waivers',()=>{
  const {view,output,ablations}=fixture();const report=inspectOutlineDraft(view,output).report!;
  for(const invalid of [[],[...ablations,...ablations],[{...ablations[0]!,genre:'sweet-romance'}],[{...ablations[0]!,reason:''}],{}]){
    expect(outlineRequiredIssues(report,output,invalid)).toBeNull();expect(outlineDecision(view,output,invalid,[])).toBeNull();
  }
  expect(outlineRequiredIssues(report,output,ablations)).toEqual([]);
  const label=[{...ablations[0]!,judgment:'label_only'}];const required=outlineRequiredIssues(report,output,label)!;expect(required.map(x=>x.id)).toEqual(['ABLATION_REVIEW:recipe.ablations.0']);
  expect(outlineDecision(view,output,label,[])).toBeNull();const waivers=[{issueId:required[0]!.id,reason:'本修订明确接受仅标签参与，后续补强。'}];expect(outlineDecision(view,output,label,waivers)).toMatchObject({ablations:label,waivers});
  expect(outlineDecision(view,output,ablations,waivers)).toBeNull();
});
it.each(['stale','reviewed','rejected','missing-candidate','digest-mismatch'] as const)('retains inspection but rejects %s review submissions',kind=>{
  const {view,output,ablations}=fixture();
  if(kind==='stale')view.sourceChanged=true;
  if(kind==='reviewed'){view.reviewStatus='reviewed';view.state='reviewed';}
  if(kind==='rejected'){view.reviewStatus='rejected';view.state='rejected';}
  if(kind==='missing-candidate')view.candidate=null;
  if(kind==='digest-mismatch')view.candidateDigest='b'.repeat(64);
  expect(inspectOutlineDraft(view,output).valid).toBe(true);expect(outlineDecision(view,output,ablations,[])).toBeNull();
});
it('allows review when a real candidate exists before its physical worker journal finishes',()=>{
  const {view,output,ablations}=fixture();view.state='running';view.task={status:'running',resultState:null,reason:null};expect(outlineDecision(view,output,ablations,[])).not.toBeNull();
});
it('refuses an existing stored audit, stale status and malformed candidate binding independently',()=>{
  const {view,output,ablations}=fixture();view.review={status:'rejected',digest:'c'.repeat(64),candidateDigest:view.candidate!.digest,actorId:'reviewer',at:view.createdAt,reason:'重新整理冲突'};
  expect(outlineDecision(view,output,ablations,[])).toBeNull();view.review=null;view.state='stale';expect(outlineDecision(view,output,ablations,[])).toBeNull();
  view.state='awaiting_review';view.candidate!.digest='bad';view.candidateDigest='bad';expect(outlineDecision(view,output,ablations,[])).toBeNull();
});
it('does not silently drop a craft issue that no longer locates an actual auxiliary proposal',()=>{
  const {view,output,ablations}=fixture();const report=inspectOutlineDraft(view,output).report!;
  const missing={...report,issues:report.issues.map(issue=>({...issue,path:'recipe.ablations.99'}))};expect(outlineRequiredIssues(missing,output,ablations)).toBeNull();
  const foreign=structuredClone(output);foreign.recipe.ablations[0]!.genre='sweet-romance';expect(outlineRequiredIssues(report,foreign,ablations)).toBeNull();
});
it('contains unexpected inspection failures without exposing their raw diagnostic',()=>{
  const {view,output}=fixture();Object.defineProperty(view.brief,'thresholds',{get(){throw new Error('secret diagnostic');}});
  const result=inspectOutlineDraft(view,output);expect(result.valid).toBe(false);expect(result.issues.join()).not.toContain('secret diagnostic');expect(result.issues.join()).toContain('重新载入');
});
function large(output:OutlineOutput,count:number):OutlineOutput{
  return {...output,adaptation:{...output.adaptation,decisions:Array.from({length:count},(_,i)=>({id:`decision-${i}`,action:'invent',reason:'x'.repeat(1000),sourceRefIds:[]}))},assets:Array.from({length:count},(_,i)=>({...output.assets[0]!,id:`asset-${i}`,description:'x'.repeat(1000),narrativeRole:'x'.repeat(1000)}))};
}
it('preserves valid complete outputs over256KiB and enforces the existing512KiB boundary',()=>{
  const {view,output,ablations}=fixture();const draft=large(output,128);expect(new TextEncoder().encode(JSON.stringify(draft)).length).toBeGreaterThan(262144);expect(inspectOutlineDraft(view,draft).valid).toBe(true);expect(outlineDecision(view,draft,ablations,[])).toMatchObject({output:draft});
  const excess=large(output,128);excess.assets=excess.assets.map(x=>({...x,description:'海'.repeat(1000),narrativeRole:'海'.repeat(1000)}));expect(inspectOutlineDraft(view,excess)).toMatchObject({valid:false});expect(inspectOutlineDraft(view,excess).issues.join()).toContain('512 KiB');expect(outlineDecision(view,excess,ablations,[])).toBeNull();
});
it('rejects malformed data, accessors and unsafe JSON without executing user code',()=>{
  const {view,output,ablations}=fixture();const getter=vi.fn(()=>output.adaptation);const accessed=Object.defineProperty({...output},'adaptation',{get:getter,enumerable:true});
  for(const invalid of [null,{},accessed,{...output,extra:true},{...output,adaptation:{...output.adaptation,title:''}}])expect(inspectOutlineDraft(view,invalid).valid).toBe(false);
  expect(getter).not.toHaveBeenCalled();const assessmentGetter=vi.fn(()=>ablations[0]);const assessed=Object.defineProperty([],0,{get:assessmentGetter,enumerable:true});assessed.length=1;expect(outlineDecision(view,output,assessed,[])).toBeNull();expect(assessmentGetter).not.toHaveBeenCalled();
});

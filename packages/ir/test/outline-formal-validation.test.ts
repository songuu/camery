import {expect,it} from 'vitest';
import {OUTLINE_FORMAL_BYTES,StoryboardPackage,validatePackage,outlineDependencyIssues} from '../src/index';
import type {StoryboardPackageV07} from '../src/index';
import {fixtureId as id} from './fixtures';
import {makeOutlinePackage,outlineRef as ref} from './outline-formal-fixture';
import {makeCapacityOutlinePackage} from './outline-formal-capacity-fixture';

type Package=StoryboardPackageV07;
const plan=(p:Package)=>p.adaptation_plans[0]!;
function codes(p:Package){return validatePackage(p).errors.map(issue=>issue.code);}
function withAuxiliary():Package{
  const p=makeOutlinePackage(),a=plan(p);a.brief.auxiliary_genres=['suspense'];a.brief.profiles.push({id:'suspense',version:1,digest:'f'.repeat(64)});a.recipe.auxiliary_genres=['suspense'];a.recipe.ablations=[{genre:'suspense',affected_beats:[ref('outline-beat')],removal_effect:'抽去查证将改变反击方式。',mainline_survives:false,reason:'线索决定主角的选择。'}];a.review.ablations=[{genre:'suspense',judgment:'participates',reason:'人工核对查证推动主线。'}];a.review.report.issues=[{id:'ablation:suspense',code:'ABLATION_REVIEW',path:'recipe.ablations.0',episode_numbers:[1],detail:'请人工判断辅助题材是否参与主线。'}];return p;
}
function twoBeats():Package{
  const p=makeOutlinePackage();const second={...structuredClone(p.outline_beats[0]!),id:id('outline-beat-second'),order:2};p.outline_beats.push(second);plan(p).beats.push({id:second.id,version:1});p.outline_episode_plans[0]!.beats.push({id:second.id,version:1});p.outline_plot_units[0]!.beats.push({id:second.id,version:1});return p;
}
const invalidCases:readonly [string,(p:Package)=>void,string][]=[
  ['main genre also listed as auxiliary',p=>{plan(p).brief.auxiliary_genres=['rebirth-revenge'];},'OUTLINE_GENRE'],
  ['duplicate auxiliary genre',p=>{plan(p).brief.auxiliary_genres=['suspense','suspense'];},'DUPLICATE_REFERENCE'],
  ['paid episode outside season',p=>{plan(p).brief.paid_episode_numbers=[2];},'OUTLINE_EPISODE'],
  ['duplicate paid breakpoint',p=>{plan(p).brief.paid_episode_numbers=[1,1];},'DUPLICATE_REFERENCE'],
  ['duplicate frozen source identity',p=>{plan(p).source.references.push({id:'source:clock',path:'/another'});},'DUPLICATE_REFERENCE'],
  ['duplicate frozen source locator',p=>{plan(p).source.references.push({id:'source:another',path:'/foundation/world'});},'DUPLICATE_REFERENCE'],
  ['profile does not bind selected genre',p=>{plan(p).brief.profiles[0]!.id='suspense';},'OUTLINE_COVERAGE'],
  ['recipe changes the frozen main genre',p=>{plan(p).recipe.main_genre='sweet-romance';},'OUTLINE_COVERAGE'],
  ['recipe introduces an unselected auxiliary',p=>{plan(p).recipe.auxiliary_genres=['suspense'];},'OUTLINE_COVERAGE'],
  ['duplicate signature scene key',p=>{plan(p).recipe.signature_scenes.push(structuredClone(plan(p).recipe.signature_scenes[0]!));},'DUPLICATE_REFERENCE'],
  ['unselected ablation',p=>{plan(p).recipe.ablations=[{genre:'suspense',affected_beats:[ref('outline-beat')],removal_effect:'失去查证。',mainline_survives:true,reason:'作为人审提案。'}];},'OUTLINE_ABLATION'],
  ['missing formal character',p=>{plan(p).characters[0]!.character=ref('missing');},'MISSING_REFERENCE'],
  ['duplicate character membership',p=>{plan(p).characters.push(structuredClone(plan(p).characters[0]!));},'DUPLICATE_REFERENCE'],
  ['adapted character without citation',p=>{plan(p).characters[0]!.origin.source_ref_ids=[];},'OUTLINE_ORIGIN'],
  ['adapted character cites absent source',p=>{plan(p).characters[0]!.origin.source_ref_ids=['source:absent'];},'OUTLINE_SOURCE'],
  ['invented character claims a source',p=>{plan(p).characters[0]!.origin.kind='invented';},'OUTLINE_ORIGIN'],
  ['signature references an external beat',p=>{plan(p).recipe.signature_scenes[0]!.beats=[ref('external-beat')];},'OUTLINE_SCOPE'],
  ['engine references a character outside plan',p=>{plan(p).season_engine.characters=[ref('external-character')];},'OUTLINE_SCOPE'],
  ['engine references a unit outside plan',p=>{plan(p).season_engine.plot_units=[ref('external-unit')];},'OUTLINE_SCOPE'],
  ['character lacks complete development',p=>{delete p.characters[0]!.development;},'INCOMPLETE_DEVELOPMENT'],
  ['season has no participating protagonist',p=>{p.characters[0]!.development!.function='supporting';},'PROTAGONIST_REQUIRED'],
  ['beat leaves season episode range',p=>{p.outline_beats[0]!.episode_number=2;},'OUTLINE_EPISODE'],
  ['beat order is discontinuous',p=>{p.outline_beats[0]!.order=2;},'OUTLINE_COVERAGE'],
  ['beat references unrelated character',p=>{p.outline_beats[0]!.characters=[{id:p.characters[1]!.id,version:1}];},'OUTLINE_SCOPE'],
  ['beat claims invented source',p=>{p.outline_beats[0]!.origin={kind:'invented',source_ref_ids:['source:clock']};},'OUTLINE_ORIGIN'],
  ['episode points to missing formal Episode',p=>{p.outline_episode_plans[0]!.episode_id=id('missing-episode');},'MISSING_REFERENCE'],
  ['episode references wrong beat',p=>{p.outline_episode_plans[0]!.beats=[ref('external-beat')];},'OUTLINE_SCOPE'],
  ['opening hook leaves its own episode',p=>{p.outline_episode_plans[0]!.opening_hook.beat=ref('external-hook');},'OUTLINE_SCOPE'],
  ['stakes point outside their episode',p=>{p.outline_episode_plans[0]!.stakes.beat=ref('external-stakes');},'OUTLINE_SCOPE'],
  ['cliffhanger points outside its episode',p=>{p.outline_episode_plans[0]!.cliffhanger.beat=ref('external-cliffhanger');},'OUTLINE_SCOPE'],
  ['opening estimate exceeds planned duration',p=>{p.outline_episode_plans[0]!.opening_hook.estimated_second=91;},'OUTLINE_EPISODE'],
  ['stakes estimate exceeds planned duration',p=>{p.outline_episode_plans[0]!.stakes.estimated_second=91;},'OUTLINE_EPISODE'],
  ['paid breakpoint disagrees with brief',p=>{p.outline_episode_plans[0]!.paid_breakpoint=false;},'OUTLINE_EPISODE'],
  ['prop has no narrative state',p=>{p.asset_plans[0]!.prop_states=[];},'OUTLINE_ASSET'],
  ['non-prop invents prop state',p=>{p.asset_plans[0]!.kind='music';},'OUTLINE_ASSET'],
  ['character asset has no formal character',p=>{p.asset_plans[0]!.kind='character';},'OUTLINE_ASSET'],
  ['appearance asset has no formal character',p=>{p.asset_plans[0]!.kind='appearance';},'OUTLINE_ASSET'],
  ['asset cites missing character',p=>{p.asset_plans[0]!.character=ref('missing-character');},'MISSING_REFERENCE'],
  ['asset character leaves plan membership',p=>{p.asset_plans[0]!.character={id:p.characters[1]!.id,version:1};},'OUTLINE_SCOPE'],
  ['asset beat leaves plan membership',p=>{p.asset_plans[0]!.beats=[ref('external-beat')];},'OUTLINE_SCOPE'],
  ['asset source is absent',p=>{p.asset_plans[0]!.origin.source_ref_ids=['source:absent'];},'OUTLINE_SOURCE'],
  ['prop state points outside appearances',p=>{p.asset_plans[0]!.prop_states[0]!.beat=ref('external-beat');},'OUTLINE_SCOPE'],
  ['unit references unrelated episode',p=>{p.outline_plot_units[0]!.episodes=[ref('external-episode')];},'OUTLINE_SCOPE'],
  ['unit references unrelated beat',p=>{p.outline_plot_units[0]!.beats=[ref('external-beat')];},'OUTLINE_SCOPE'],
  ['retained decision omits citation',p=>{p.outline_adaptation_decisions[0]!.source_ref_ids=[];},'OUTLINE_ORIGIN'],
  ['new decision secretly retains source',p=>{p.outline_adaptation_decisions[0]!.action='invent';},'OUTLINE_ORIGIN'],
  ['review emotion curve differs from episodes',p=>{plan(p).review.report.emotion_curve[0]!.intensity=2;},'OUTLINE_COVERAGE'],
  ['review thresholds differ from brief',p=>{plan(p).review.report.thresholds={...plan(p).review.report.thresholds,stakes_by_second:16};},'OUTLINE_COVERAGE'],
  ['unknown waiver has no located issue',p=>{plan(p).review.waivers=[{issue_id:'absent',reason:'不能豁免未出现的问题。'}];},'OUTLINE_WAIVER'],
  ['human assesses unselected genre',p=>{plan(p).review.ablations=[{genre:'suspense',judgment:'participates',reason:'不是本简报选中的轴。'}];},'OUTLINE_ABLATION'],
];
it.each(invalidCases)('rejects %s',(_name,mutate,expected)=>{const p=makeOutlinePackage();mutate(p);expect(codes(p)).toContain(expected);});

it('accepts explicit invention, source reuse, both human ablation decisions and exactly located waivers',()=>{
  const p=withAuxiliary();expect(validatePackage(p).errors).toEqual([]);const a=plan(p);a.review.ablations[0]!.judgment='label_only';expect(codes(p)).toContain('OUTLINE_WAIVER');a.review.waivers=[{issue_id:'ablation:suspense',reason:'保留这一题材标签的明确创作选择。'}];expect(validatePackage(p).errors).toEqual([]);
  for(const origin of [a.characters[0]!.origin,p.outline_beats[0]!.origin,p.asset_plans[0]!.origin]){origin.kind='invented';origin.source_ref_ids=[];}p.outline_adaptation_decisions[0]!.action='invent';p.outline_adaptation_decisions[0]!.source_ref_ids=[];expect(validatePackage(p).errors).toEqual([]);
});
it('requires every selected auxiliary to have a unique proposal and independent human assessment',()=>{const p=withAuxiliary();plan(p).review.ablations=[];expect(codes(p)).toContain('OUTLINE_ABLATION');const q=withAuxiliary();plan(q).recipe.ablations=[];expect(codes(q)).toContain('OUTLINE_ABLATION');const r=withAuxiliary();plan(r).review.ablations.push(structuredClone(plan(r).review.ablations[0]!));expect(codes(r)).toContain('DUPLICATE_REFERENCE');});
it('rejects malformed ablation issue locations and duplicate proposal identities',()=>{const p=withAuxiliary();plan(p).review.report.issues[0]!.path='recipe.ablations.8';expect(codes(p)).toContain('OUTLINE_ABLATION');const q=withAuxiliary();plan(q).recipe.ablations.push(structuredClone(plan(q).recipe.ablations[0]!));expect(codes(q)).toContain('DUPLICATE_REFERENCE');const r=withAuxiliary();plan(r).recipe.ablations[0]!.affected_beats=[ref('external-beat')];expect(codes(r)).toContain('OUTLINE_SCOPE');});
it('binds every reported problem, episode location and waiver to its immutable audit',()=>{const p=makeOutlinePackage();plan(p).review.report.issues=[{id:'late-hook',code:'LATE_OPENING_HOOK',path:'episodes.0.openingHook',episode_numbers:[1],detail:'计划开场超过简报阈值。'}];expect(codes(p)).toContain('OUTLINE_WAIVER');plan(p).review.waivers=[{issue_id:'late-hook',reason:'人工选择先完整展示钟声。'}];expect(validatePackage(p).errors).toEqual([]);plan(p).review.waivers.push(structuredClone(plan(p).review.waivers[0]!));expect(codes(p)).toContain('DUPLICATE_REFERENCE');plan(p).review.waivers.pop();plan(p).review.report.issues[0]!.episode_numbers=[2];expect(codes(p)).toContain('OUTLINE_EPISODE');plan(p).review.report.issues[0]!.episode_numbers=[1,1];expect(codes(p)).toContain('DUPLICATE_REFERENCE');plan(p).review.report.issues.push(structuredClone(plan(p).review.report.issues[0]!));expect(codes(p)).toContain('DUPLICATE_REFERENCE');});
it('keeps prop state chronology distinct from arbitrary appearance selection order',()=>{const p=twoBeats(),a=p.asset_plans[0]!,first=ref('outline-beat'),second=ref('outline-beat-second');a.beats=[second,first];a.prop_states=[{beat:first,before:'完整',after:'折断',reason:'门口冲突。'},{beat:second,before:'折断',after:'修复',reason:'主角作出选择。'}];expect(validatePackage(p).errors).toEqual([]);a.prop_states.reverse();expect(codes(p)).toContain('OUTLINE_ASSET');});
it('allows explicitly planned character appearances and non-prop resources without inventing materialized assets',()=>{for(const kind of ['character','appearance','music'] as const){const p=makeOutlinePackage(),asset=p.asset_plans[0]!;asset.kind=kind;asset.prop_states=[];asset.character=kind==='music'?null:{id:p.characters[0]!.id,version:1};expect(validatePackage(p).errors).toEqual([]);expect(outlineDependencyIssues(p)).toEqual([]);}});
it('rejects repeated beat slots, reordered episode coverage and repeated formal Episode ownership',()=>{const p=twoBeats();p.outline_beats[1]!.order=1;expect(codes(p)).toContain('OUTLINE_COVERAGE');const q=makeCapacityOutlinePackage();plan(q).episodes.reverse();expect(codes(q)).toContain('OUTLINE_COVERAGE');const r=makeCapacityOutlinePackage();r.outline_episode_plans[1]!.episode_id=r.outline_episode_plans[0]!.episode_id;expect(codes(r)).toContain('DUPLICATE_REFERENCE');});
it('requires PlotUnits to partition every season episode consecutively and carry all episode beats in order',()=>{const p=makeCapacityOutlinePackage();p.outline_plot_units[0]!.episodes=[plan(p).episodes[0]!,plan(p).episodes[2]!];p.outline_plot_units[0]!.beats=[...p.outline_episode_plans[0]!.beats,...p.outline_episode_plans[2]!.beats];expect(codes(p)).toContain('OUTLINE_COVERAGE');const q=makeCapacityOutlinePackage();q.outline_plot_units[1]!.episodes=[plan(q).episodes[0]!];q.outline_plot_units[1]!.beats=structuredClone(q.outline_episode_plans[0]!.beats);expect(codes(q)).toContain('OUTLINE_COVERAGE');const r=twoBeats();r.outline_plot_units[0]!.beats.reverse();expect(codes(r)).toContain('OUTLINE_COVERAGE');});
it('does not resolve an existing ID from the wrong formal collection',()=>{const p=makeOutlinePackage();plan(p).beats[0]={id:p.characters[0]!.id,version:1};expect(codes(p)).toContain('MISSING_REFERENCE');});
it.each(['outline_beats','outline_episode_plans','asset_plans','outline_plot_units','outline_adaptation_decisions'] as const)('rejects missing and unowned %s records',collection=>{const p=makeOutlinePackage();p[collection][0]!.adaptation_plan=ref('missing-plan');expect(codes(p)).toContain('MISSING_REFERENCE');const q=makeOutlinePackage();const extra={...structuredClone(q[collection][0]!),id:id(`orphan-${collection}`)};switch(collection){case 'outline_beats':q.outline_beats.push({...q.outline_beats[0]!,id:extra.id});break;case 'outline_episode_plans':q.outline_episode_plans.push({...q.outline_episode_plans[0]!,id:extra.id});break;case 'asset_plans':q.asset_plans.push({...q.asset_plans[0]!,id:extra.id});break;case 'outline_plot_units':q.outline_plot_units.push({...q.outline_plot_units[0]!,id:extra.id});break;case 'outline_adaptation_decisions':q.outline_adaptation_decisions.push({...q.outline_adaptation_decisions[0]!,id:extra.id});break;}expect(codes(q)).toContain('OUTLINE_SCOPE');});
it('preserves old pins as stale dependencies without rebinding to a newer owned record',()=>{const p=makeOutlinePackage();const original=structuredClone(plan(p).assets[0]!);p.asset_plans[0]!.version=2;const report=validatePackage(p);expect(report.errors).toEqual([]);expect(report.warnings).toContainEqual(expect.objectContaining({code:'STALE_OUTLINE_DEPENDENCY'}));expect(plan(p).assets[0]).toEqual(original);expect(outlineDependencyIssues(p)).toContainEqual({objectId:plan(p).id,referenceId:original.id,expectedVersion:1,actualVersion:2});});
it('preserves child parent pins when the plan advances, making the old consumers visibly stale',()=>{const p=makeOutlinePackage();const original=structuredClone(p.outline_beats[0]!.adaptation_plan);plan(p).version=2;expect(validatePackage(p).errors).toEqual([]);expect(outlineDependencyIssues(p)).toContainEqual({objectId:p.outline_beats[0]!.id,referenceId:plan(p).id,expectedVersion:1,actualVersion:2});expect(p.outline_beats[0]!.adaptation_plan).toEqual(original);});
it('rejects future pins and reports missing dependencies with an explicit null current revision',()=>{const p=makeOutlinePackage();plan(p).assets[0]!.version=2;expect(codes(p)).toContain('FUTURE_OUTLINE_DEPENDENCY');const q=makeOutlinePackage();q.asset_plans=[];expect(codes(q)).toContain('MISSING_REFERENCE');expect(outlineDependencyIssues(q)).toContainEqual({objectId:plan(q).id,referenceId:ref('outline-asset').id,expectedVersion:1,actualVersion:null});});
it('rejects row-field smuggling and malformed source/method provenance at the strict formal boundary',()=>{const p=makeOutlinePackage();expect(StoryboardPackage.safeParse({...p,adaptation_plans:[{...plan(p),raw_output:{approved:true}}]}).success).toBe(false);expect(StoryboardPackage.safeParse({...p,asset_plans:[{...p.asset_plans[0],status:'ready',uri:'https://unverified.invalid'}]}).success).toBe(false);expect(StoryboardPackage.safeParse({...p,adaptation_plans:[{...plan(p),method:{...plan(p).method,digest:'unknown'}}]}).success).toBe(false);expect(StoryboardPackage.safeParse({...p,adaptation_plans:[{...plan(p),source:{...plan(p).source,reviewed_at:'yesterday'}}]}).success).toBe(false);});
it('retains all maximum row counts and validates more than a thousand formal objects without the old 500-op truncation',()=>{const p=makeCapacityOutlinePackage(),before=structuredClone(p);expect(plan(p).characters).toHaveLength(64);expect(p.outline_beats).toHaveLength(500);expect(p.outline_episode_plans).toHaveLength(100);expect(p.asset_plans).toHaveLength(256);expect(p.outline_plot_units).toHaveLength(100);expect(p.outline_adaptation_decisions).toHaveLength(128);expect(p.outline_beats.length+p.outline_episode_plans.length+p.asset_plans.length+p.outline_plot_units.length+p.outline_adaptation_decisions.length+p.characters.length).toBeGreaterThan(1000);expect(validatePackage(p).errors).toEqual([]);expect(p).toEqual(before);});
it('bounds the complete formal dependency graph even when an existing legacy character contains oversized text',()=>{const p=makeOutlinePackage();p.characters[0]!.role='x'.repeat(OUTLINE_FORMAL_BYTES);expect(codes(p)).toContain('OUTLINE_LIMIT');expect(p.characters[0]!.role).toHaveLength(OUTLINE_FORMAL_BYTES);});

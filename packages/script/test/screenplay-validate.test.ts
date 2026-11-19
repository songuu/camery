import {expect,it} from 'vitest';
import {SCREENPLAY_DRAFT_BYTES,ScreenplayError,ScreenplayReportSchema} from '../src/screenplay/contracts.js';
import type {ScreenplayIssueCode} from '../src/screenplay/contracts.js';
import {checkScreenplay} from '../src/screenplay/validate.js';
import {screenplayFixture} from './screenplay-support.js';

const issues=(report:ReturnType<typeof checkScreenplay>,code:ScreenplayIssueCode)=>report.issues.filter(issue=>issue.code===code);
function fourBeats(){const f=screenplayFixture(),scene=f.draft.scenes[0]!,action=scene.beats[0]!;scene.beats.splice(1,0,{...structuredClone(action),id:'second-action'},{...structuredClone(action),id:'third-action'});return f;}

it('reports required human judgements even when all deterministic first-episode checks pass',()=>{
  const f=screenplayFixture(),before=structuredClone(f.draft),report=checkScreenplay(f.context,f.draft);
  expect(ScreenplayReportSchema.parse(report)).toEqual(report);expect(report).toMatchObject({version:1,kind:'screenplay_check',ruleVersion:'screenplay-v1',episodeId:f.draft.episodeId});
  expect(report.issues.filter(issue=>issue.severity==='error')).toEqual([]);expect(issues(report,'MODULE_REVIEW')).toHaveLength(5);expect(issues(report,'HOOK_REVIEW')).toHaveLength(2);expect(issues(report,'CONTINUITY_REVIEW')).toHaveLength(1);
  expect(report.issues.every(issue=>issue.path&&issue.detail&&issue.audienceImpact&&issue.remedy)).toBe(true);expect(Object.isFrozen(report.issues[0]!.collateralImpact)).toBe(true);expect(f.draft).toEqual(before);
});

it('allows different modules to overlap while retaining each configured subjective purpose for review',()=>{
  const f=screenplayFixture();f.context.rules.firstEpisode!.modules.forEach((module,index)=>{module.purpose='人工核对第'+index+'项观众感受。';});
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'FIRST_EPISODE_MODULE')).toEqual([]);
  for(const module of f.context.rules.firstEpisode!.modules)expect(issues(report,'MODULE_REVIEW').some(issue=>issue.detail.includes(module.purpose)&&issue.severity==='warning')).toBe(true);
});

it.each([0,1,2])('accepts the opening hook at global local beat position %i',index=>{
  const f=fourBeats();f.draft.openingHook!.beatId=f.draft.scenes[0]!.beats[index]!.id;const report=checkScreenplay(f.context,f.draft);expect(issues(report,'MISSING_OPENING_HOOK')).toEqual([]);expect(issues(report,'LATE_OPENING_HOOK')).toEqual([]);
});

it('rejects an opening hook at the fourth beat without pretending its prose is automatically engaging',()=>{
  const f=fourBeats();f.draft.openingHook!.beatId=f.draft.scenes[0]!.beats[3]!.id;const report=checkScreenplay(f.context,f.draft);
  expect(issues(report,'LATE_OPENING_HOOK')).toMatchObject([{severity:'error',path:'/openingHook/beatId'}]);expect(issues(report,'HOOK_REVIEW').every(issue=>issue.severity==='warning')).toBe(true);
});

it.each(['missing','line','scene','outline','unknown'] as const)('rejects a missing or non-local-beat opening hook: %s',kind=>{
  const f=screenplayFixture();if(kind==='missing')f.draft.openingHook=null;else f.draft.openingHook!.beatId=kind==='line'?'line-0':kind==='scene'?'scene':kind==='outline'?f.context.outline.beats[0]!.ref.id:'unknown-local-beat';
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'MISSING_OPENING_HOOK')).toHaveLength(1);expect(issues(report,'MISSING_OPENING_HOOK')[0]!.severity).toBe('error');expect(issues(report,'HOOK_REVIEW')).toHaveLength(2);
});

it.each(['missing','unknown','not-last'] as const)('requires the closing hook to name the final real local beat: %s',kind=>{
  const f=screenplayFixture();if(kind==='missing')f.draft.closingHook=null;else f.draft.closingHook!.beatId=kind==='unknown'?'unknown-closing':'action-0';
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'CLOSING_HOOK')).toMatchObject([{severity:'error'}]);expect(issues(report,'HOOK_REVIEW')).toHaveLength(2);
});

it('uses flattened screenplay order across scenes for both hooks',()=>{
  const f=fourBeats(),old=f.draft.scenes[0]!,tail={...structuredClone(old),id:'last-scene',beats:[{...structuredClone(old.beats[0]!),id:'last-action'}]};f.draft.scenes.push(tail);
  expect(issues(checkScreenplay(f.context,f.draft),'CLOSING_HOOK')).toHaveLength(1);f.draft.closingHook!.beatId='last-action';expect(issues(checkScreenplay(f.context,f.draft),'CLOSING_HOOK')).toEqual([]);
  f.draft.openingHook!.beatId='last-action';expect(issues(checkScreenplay(f.context,f.draft),'LATE_OPENING_HOOK')).toHaveLength(1);
});

it('warns when opening or closing types depart from the adopted outline',()=>{
  const f=screenplayFixture();f.draft.openingHook!.type=f.context.outline.openingHook.type==='danger'?'mystery':'danger';f.draft.closingHook!.type=f.context.outline.cliffhanger.type==='identity_near'?'choice':'identity_near';
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'HOOK_TYPE_CHANGED')).toMatchObject([{severity:'warning',path:'/openingHook/type'},{severity:'warning',path:'/closingHook/type'}]);expect(issues(report,'HOOK_REVIEW')).toHaveLength(2);
});

it('requires an explicit first-episode profile instead of inventing five module defaults',()=>{
  const f=screenplayFixture();f.context.rules.firstEpisode=null;f.draft.modules=[];const report=checkScreenplay(f.context,f.draft);
  expect(issues(report,'FIRST_EPISODE_CONFIG')).toMatchObject([{severity:'error',path:'/rules/firstEpisode'}]);expect(issues(report,'MODULE_REVIEW')).toEqual([]);
});

it('does not accept five self-named module annotations when the project has no first-episode configuration',()=>{
  const f=screenplayFixture();f.context.rules.firstEpisode=null;const report=checkScreenplay(f.context,f.draft);expect(issues(report,'FIRST_EPISODE_CONFIG')).toHaveLength(1);expect(issues(report,'FIRST_EPISODE_MODULE')).toHaveLength(5);expect(issues(report,'MODULE_REVIEW')).toEqual([]);
});

it.each(['missing','unknown','duplicate'] as const)('requires all five exact unique module annotations in the first episode: %s',kind=>{
  const f=screenplayFixture();if(kind==='missing')f.draft.modules.pop();else if(kind==='unknown')f.draft.modules[0]!.moduleId='unknown-module';else f.draft.modules[1]!.moduleId=f.draft.modules[0]!.moduleId;
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'FIRST_EPISODE_MODULE').some(issue=>issue.severity==='error')).toBe(true);expect(issues(report,'MODULE_REVIEW')).toHaveLength(5);
});

it.each(['missing-beat','line-instead-of-beat','repeated-beat'] as const)('requires real unique local beat references inside a module: %s',kind=>{
  const f=screenplayFixture();f.draft.modules[0]!.beatIds=kind==='missing-beat'?['missing-beat']:kind==='line-instead-of-beat'?['line-0']:['action-0','action-0'];
  expect(issues(checkScreenplay(f.context,f.draft),'FIRST_EPISODE_MODULE').some(issue=>issue.severity==='error'&&issue.path.startsWith('/modules/0/beatIds'))).toBe(true);
});

it('counts only actual unique module beats toward minBeats and preserves distinct rule failures at the same location',()=>{
  const f=screenplayFixture(),module=f.context.rules.firstEpisode!.modules[0]!;module.minBeats=2;module.requiredKinds=['action','dialogue'];f.draft.modules[0]!.beatIds=['action-0','action-0','missing'];
  const report=checkScreenplay(f.context,f.draft),errors=issues(report,'FIRST_EPISODE_MODULE').filter(issue=>issue.path.startsWith('/modules/0')&&issue.severity==='error');
  expect(errors.some(issue=>issue.detail.includes('2'))).toBe(true);expect(errors.some(issue=>issue.detail.includes('对白'))).toBe(true);expect(new Set(errors.map(issue=>issue.id)).size).toBe(errors.length);
  f.draft.modules[0]!.beatIds=['action-0','dialogue-0'];expect(issues(checkScreenplay(f.context,f.draft),'FIRST_EPISODE_MODULE')).toEqual([]);
});

it('supports configured action, dialogue and narration requirements without inferring a module purpose from text',()=>{
  const f=screenplayFixture(),scene=f.draft.scenes[0]!,line=scene.beats[1]!.lines[0]!;scene.beats.splice(1,0,{...structuredClone(scene.beats[1]!),id:'narration-beat',kind:'narration',lines:[{...line,id:'narration-line',kind:'narration'}]});
  f.context.rules.firstEpisode!.modules[0]!.requiredKinds=['action','dialogue','narration'];f.draft.modules[0]!.beatIds=['action-0','narration-beat','dialogue-0'];
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'FIRST_EPISODE_MODULE')).toEqual([]);expect(issues(report,'MODULE_REVIEW')).toHaveLength(5);
});

it('retains each missing required kind at the same module location instead of deduplicating away another repair',()=>{
  const f=screenplayFixture();f.context.rules.firstEpisode!.modules[0]!.requiredKinds=['dialogue','narration'];const report=checkScreenplay(f.context,f.draft),missing=issues(report,'FIRST_EPISODE_MODULE');
  expect(missing).toHaveLength(2);expect(missing.every(issue=>issue.path==='/modules/0/beatIds')).toBe(true);expect(missing.some(issue=>issue.detail.includes('对白'))).toBe(true);expect(missing.some(issue=>issue.detail.includes('旁白'))).toBe(true);expect(new Set(missing.map(issue=>issue.id)).size).toBe(2);
});

it('does not require five modules after episode one but rejects unknown or malformed optional annotations',()=>{
  const f=screenplayFixture(2);f.context.rules.firstEpisode=null;expect(issues(checkScreenplay(f.context,f.draft),'FIRST_EPISODE_CONFIG')).toEqual([]);expect(issues(checkScreenplay(f.context,f.draft),'FIRST_EPISODE_MODULE')).toEqual([]);
  f.draft.modules=[{moduleId:'unknown-module',beatIds:['action-0']}];expect(issues(checkScreenplay(f.context,f.draft),'FIRST_EPISODE_MODULE')).toMatchObject([{severity:'error',path:'/modules/0/moduleId'}]);
  const known=screenplayFixture(2);known.draft.modules=[{moduleId:known.context.rules.firstEpisode!.modules[0]!.id,beatIds:['action-0']}];expect(issues(checkScreenplay(known.context,known.draft),'FIRST_EPISODE_MODULE')).toEqual([]);expect(issues(checkScreenplay(known.context,known.draft),'MODULE_REVIEW')).toHaveLength(1);
});

it('still validates the constraints of a known optional later-episode module without requiring the other four',()=>{
  const f=screenplayFixture(2),module=f.context.rules.firstEpisode!.modules[0]!;module.minBeats=2;module.requiredKinds=['dialogue'];f.draft.modules=[{moduleId:module.id,beatIds:['action-0']}];
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'FIRST_EPISODE_CONFIG')).toEqual([]);expect(issues(report,'FIRST_EPISODE_MODULE')).toHaveLength(2);expect(issues(report,'MODULE_REVIEW')).toHaveLength(1);
});

it('warns about uncovered adopted outline beats and clears the warning only for actual mapped coverage',()=>{
  const f=screenplayFixture(),first=f.context.outline.beats[0]!,newRef={id:f.id('uncovered-screenplay-outline'),version:1};f.context.outline.beats.push({...structuredClone(first),ref:newRef,order:first.order+1});
  expect(issues(checkScreenplay(f.context,f.draft),'OUTLINE_COVERAGE')).toMatchObject([{severity:'warning',path:'/outline/beats/1'}]);f.draft.scenes[0]!.beats[0]!.outlineBeatIds.push(newRef.id);expect(issues(checkScreenplay(f.context,f.draft),'OUTLINE_COVERAGE')).toEqual([]);
});

it('merges actual continuity-rule findings and keeps continuity review mandatory',()=>{
  const f=screenplayFixture(),evidence={event:{kind:'beat' as const,id:'action-0'},quote:f.draft.scenes[0]!.beats[0]!.summary};f.draft.continuity=[{id:'unsupported-use',op:'use_fact',characterId:f.speaker,factId:'not-established',evidence}];
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'CONTINUITY_RULE').some(issue=>issue.severity==='error')).toBe(true);expect(issues(report,'CONTINUITY_REVIEW')).toMatchObject([{severity:'warning'}]);
});

it('does not infer undeclared facts or character knowledge from free-form prose',()=>{
  const f=screenplayFixture();f.draft.scenes[0]!.beats[0]!.summary='人物突然知道了未被告知的真相，并发现隐藏的关系。';f.draft.continuity=[];
  const report=checkScreenplay(f.context,f.draft);expect(issues(report,'CONTINUITY_RULE')).toEqual([]);expect(issues(report,'CONTINUITY_REVIEW')).toHaveLength(1);expect(Object.hasOwn(report,'ledger')).toBe(false);
});

it('deduplicates shared inspection/continuity-preview issues by stable id while retaining repair context',()=>{
  const f=screenplayFixture();f.draft.continuity=[{id:'bad-local-reference',op:'assert_fact',factId:'note',kind:'fact',text:'声明必须定位。',evidence:{event:{kind:'beat',id:'missing-local'},quote:'不存在的证据'}}];
  f.draft.scenes[0]!.beats[1]!.lines[0]!.speakerId=f.id('unknown-screenplay-speaker');const report=checkScreenplay(f.context,f.draft);
  expect(new Set(report.issues.map(issue=>issue.id)).size).toBe(report.issues.length);expect(issues(report,'CONTINUITY_REFERENCE')).toHaveLength(1);expect(issues(report,'UNKNOWN_CHARACTER')).toHaveLength(1);expect(issues(report,'SCENE_SPEAKER')).toHaveLength(1);
});

it('retains input boundary failures and refuses unsafe accessors or over-budget drafts',()=>{
  const f=screenplayFixture();let touched=false;const draft=Object.defineProperty({...f.draft},'title',{enumerable:true,get:()=>{touched=true;return '不应读取';}});expect(()=>checkScreenplay(f.context,draft)).toThrow(ScreenplayError);expect(touched).toBe(false);
  expect(()=>checkScreenplay(f.context,{...f.draft,title:'x'.repeat(SCREENPLAY_DRAFT_BYTES)})).toThrow('INPUT_LIMIT');
  const bad=screenplayFixture();bad.context.rules.firstEpisode!.modules[1]!.id=bad.context.rules.firstEpisode!.modules[0]!.id;expect(()=>checkScreenplay(bad.context,bad.draft)).toThrow('INVALID_REFERENCE');
});

it('fails explicitly rather than returning a truncated report when many actual module repair findings exceed the output budget',()=>{
  const f=screenplayFixture();for(const module of f.draft.modules)module.beatIds=Array.from({length:2048},(_,index)=>'unknown-local-'+index);
  expect(JSON.stringify(f.draft).length).toBeLessThan(SCREENPLAY_DRAFT_BYTES);expect(()=>checkScreenplay(f.context,f.draft)).toThrow('INPUT_LIMIT');
});

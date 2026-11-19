import {expect,it} from 'vitest';
import {validateScreenplayContext,inspectScreenplayDraft,projectScreenplayContinuity} from '../src/screenplay/context.js';
import {screenplayFixture} from './screenplay-support.js';

it('captures complete writing context and preserves the original typed draft without claiming adoption',()=>{
  const f=screenplayFixture();expect(validateScreenplayContext(f.context)).toEqual(f.context);const inspected=inspectScreenplayDraft(f.context,f.draft);expect(inspected.draft).toEqual(f.draft);expect(inspected.issues).toEqual([]);expect(Object.isFrozen(inspected.draft)).toBe(true);
});
it('reports a misplaced speaker and false original quote with exact locations for human repair',()=>{
  const f=screenplayFixture(),beat=f.draft.scenes[0]!.beats[1]!;beat.lines[0]!.speakerId=f.id('unknown-speaker');beat.origin={kind:'adapted',reason:null,citations:[{referenceId:f.context.references[0]!.id,relationship:'quoted',quote:'并未出现的原文。'}]};
  const report=inspectScreenplayDraft(f.context,f.draft);expect(report.issues.map(row=>row.code)).toEqual(expect.arrayContaining(['UNKNOWN_CHARACTER','SCENE_SPEAKER','SOURCE_QUOTE']));expect(report.issues.every(row=>row.path&&row.audienceImpact&&row.remedy)).toBe(true);
});
it('reuses the four-ledger reducer against explicitly provisional current-episode refs',()=>{
  const f=screenplayFixture(),evidence={event:{kind:'beat' as const,id:'action-0'},quote:f.draft.scenes[0]!.beats[0]!.summary};
  f.draft.continuity=[{id:'assert-current',op:'assert_fact',factId:'current-note',kind:'fact',text:'本集核对便签。',evidence},{id:'learn-current',op:'learn',characterId:f.speaker,factId:'current-note',source:{kind:'witness'},evidence}];
  const preview=projectScreenplayContinuity(f.context,f.draft);expect(preview.kind).toBe('candidate_projection');expect(preview.ledger?.facts[0]!.text).toBe('本集核对便签。');expect(preview.ledger?.knowledge).toHaveLength(1);expect(preview.issues).toEqual([]);
  expect(preview.references.find(row=>row.localId==='action-0')!.ref.id).not.toBe('action-0');
});
it('inherits the full previous ledger and rejects unsupported knowledge use',()=>{
  const f=screenplayFixture(2),before=f.context.previous!.ledger;
  expect(projectScreenplayContinuity(f.context,f.draft).ledger?.facts).toEqual(before.facts);
  f.draft.continuity=[{id:'use-missing',op:'use_fact',characterId:f.speaker,factId:'missing',evidence:{event:{kind:'beat',id:'action-0'},quote:f.draft.scenes[0]!.beats[0]!.summary}}];
  expect(projectScreenplayContinuity(f.context,f.draft).issues.some(row=>row.severity==='error'&&row.code==='CONTINUITY_RULE')).toBe(true);
});

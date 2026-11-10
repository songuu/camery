import { describe, expect, it } from 'vitest';
import type { StoryboardPackage } from '../src/index';
import { validatePackage } from '../src/index';
import { errorCodes, fixtureId as id, makeOmitDecision, makeProductionPackage, mutate, row } from './fixtures';

type Edit = (p: StoryboardPackage) => void;
const missing = id('missing');
const cases: Array<[string, Edit]> = [
  ['MISSING_REFERENCE', p => { p.shot_takes[0]!.shot_id = missing; }],
  ['MISSING_REFERENCE', p => { p.shot_takes[0]!.segment_revision_id.id = missing; }],
  ['MISSING_REFERENCE', p => { p.shot_takes[0]!.media_asset_id.id = missing; }],
  ['STALE_REFERENCE', p => { p.shot_takes[0]!.media_asset_id.version++; }],
  ['STALE_REFERENCE', p => { p.shot_takes[0]!.segment_revision_id.version++; }],
  ['TARGET', p => { p.segments[0]!.rendition_id = id('rnd_a'); }],
  ['TAKE_PROVENANCE', p => { row(p.assets, 'video').generated_from_segment = null; }],
  ['STALE_REFERENCE', p => { row(p.assets, 'video').generated_from_segment!.version++; }],
  ['TAKE_MEDIA', p => { row(p.assets, 'video').measured_seconds = null; }],
  ['TAKE_MEDIA', p => { Object.assign(row(p.assets, 'video'), { status: 'missing', file: null }); }],
  ['TAKE_MEDIA', p => { row(p.assets, 'video').media_type = 'image'; }],
  ['TAKE_RANGE', p => { p.shot_takes[0]!.source_out = p.shot_takes[0]!.source_in; }],
  ['TAKE_RANGE', p => { p.shot_takes[0]!.source_out = 12; }],
  ['TAKE_RANGE', p => { p.shot_takes[0]!.source_in = 0; }],
  ['TAKE_COVERAGE', p => { p.shot_takes[0]!.timeline_offset = 1; }],
  ['MISSING_REFERENCE', p => { p.shot_takes[0]!.visible_speaker_id = missing; }],
  ['VISIBLE_SPEAKER', p => { p.shot_takes[0]!.visible_speaker_id = id('char_lin'); }],
  ['LIPSYNC_SCOPE', p => { p.shots[0]!.production_tier = 'lipsync'; }],
  ['LIPSYNC_SCOPE', p => { p.shots[1]!.production_tier = 'lipsync'; row(p.lines, 'l_say').kind = 'inner_monologue'; }],
  ['SEGMENT_HANDLES', p => { p.segments[0]!.handles = { head: 7, tail: 5 }; }],
  ['MISSING_REFERENCE', p => { p.segments[0]!.rendition_id = missing; }],
  ['MISSING_REFERENCE', p => { p.segments[0]!.continuity_from = { id: missing, version: 1 }; }],
  ['CONTINUITY_MEDIA', p => { p.segments[0]!.continuity_from = { id: id('as_voice'), version: 1 }; }],
  ['STALE_REFERENCE', p => { p.segments[0]!.continuity_from = { id: id('video'), version: 7 }; }],
  ['MISSING_REFERENCE', p => { row(p.assets, 'video').generated_from_segment = { id: missing, version: 1 }; }],
  ['MISSING_REFERENCE', p => { row(p.assets, 'video').derived_from = { id: missing, version: 1 }; }],
  ['STALE_REFERENCE', p => { row(p.assets, 'video').derived_from = { id: id('as_img'), version: 2 }; }],
  ['DERIVATION_CYCLE', p => { row(p.assets, 'video').derived_from = { id: id('video'), version: 1 }; }],
];

describe('adopted material uses', () => {
  it('covers every shot with explicit media revisions for declared delivery', () => {
    expect(validatePackage(makeProductionPackage(), { stage: 'delivery' })).toMatchObject({ valid: true });
  });

  it.each(cases)('rejects %s', (code, edit) => {
    expect(errorCodes(validatePackage(mutate(makeProductionPackage(), edit)))).toContain(code);
  });

  it('supports a multi-piece shot, a measured duration and explicit speed change', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      const first = p.shot_takes[0]!;
      first.source_out = 4.5;
      first.playback_rate = { numerator: 2, denominator: 1 };
      p.shots[0]!.duration.measured = 4;
      p.shot_takes.push({ ...first, id: id('take-second'), timeline_offset: 2 });
    });
    expect(validatePackage(pkg, { stage: 'delivery' }).valid).toBe(true);
  });

  it('allows visible on-screen speech but rejects invisible narration lip sync', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      p.shots[1]!.production_tier = 'lipsync';
      p.shot_takes[1]!.visible_speaker_id = id('char_lin');
      p.shot_takes[1]!.audio_policy = 'keep';
    });
    expect(validatePackage(pkg).valid).toBe(true);
    expect(errorCodes(validatePackage(mutate(pkg, p => { row(p.lines, 'l_say').kind = 'inner_monologue'; })))).toContain('VISIBLE_SPEAKER');
  });

  it('requires declared source rights as well as project rights', () => {
    expect(errorCodes(validatePackage(mutate(makeProductionPackage(), p => { p.sources[0]!.usage_basis = 'unknown'; }), { stage: 'delivery' }))).toContain('RIGHTS');
  });

  it('applies approved omissions only to their rendition scope', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      p.shot_takes = p.shot_takes.filter(t => t.shot_id !== id('sh_1'));
      p.shots = p.shots.filter(s => s.id !== id('sh_1'));
      p.panels = p.panels.filter(s => s.shot_id !== id('sh_1'));
      p.adaptation_decisions.push(makeOmitDecision({ rendition_id: id('rnd_v') }));
    });
    expect(validatePackage(pkg, { stage: 'delivery' }).valid).toBe(true);
    expect(errorCodes(validatePackage(mutate(pkg, p => { p.adaptation_decisions[0]!.rendition_id = id('rnd_a'); }), { stage: 'delivery' }))).toContain('BEAT_COVERAGE');
  });

  it('requires actual coverage of replacement beats, including non-required replacements', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      p.shot_takes = p.shot_takes.filter(t => t.shot_id !== id('sh_1'));
      p.shots = p.shots.filter(s => s.id !== id('sh_1'));
      p.panels = p.panels.filter(s => s.shot_id !== id('sh_1'));
      p.beats.push({ ...p.beats[0]!, id: id('replacement'), order_key: 'a2', required: false });
      p.adaptation_decisions.push({
        id: id('replacement-decision'), version: 1, action: 'replace', rendition_id: id('rnd_v'),
        affected_beat_ids: [id('b_open')], replacement_beat_ids: [id('replacement')], reason: '替代', status: 'approved',
      });
    });
    expect(errorCodes(validatePackage(pkg, { stage: 'delivery' }))).toContain('BEAT_COVERAGE');
    const covered = mutate(pkg, p => { p.shots[0]!.beat_refs.push(id('replacement')); });
    expect(validatePackage(covered, { stage: 'delivery' }).valid).toBe(true);
  });
});

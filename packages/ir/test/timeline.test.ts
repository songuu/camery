import { describe, expect, it } from 'vitest';
import { validatePackage } from '../src/index';
import { errorCodes, fixtureId as id, makePackage, makeProductionPackage, mutate, row } from './fixtures';

describe('IR timeline checker integration', () => {
  it('resolves episode-relative timing in the existing multi-rendition fixture', () => {
    expect(validatePackage(makePackage()).valid).toBe(true);
  });

  it('rejects cyclic cue anchors with a source path', () => {
    const report = validatePackage(mutate(makePackage(), p => {
      row(p.audio_cues, 'cue_a_open').anchor = { ref: id('cue_a_say'), edge: 'end', offset: 0 };
    }));
    expect(errorCodes(report)).toContain('ANCHOR_CYCLE');
    expect(report.errors.find(e => e.code === 'ANCHOR_CYCLE')?.where).toMatch(/^\/audio_cues\/\d+\//);
  });

  it('rejects overlapping cues, oversized fades, and cues outside the episode', () => {
    const overlap = mutate(makePackage(), p => {
      const original = row(p.audio_cues, 'cue_a_open');
      p.audio_cues.push({ ...original, id: id('cue_overlap'), anchor: { ...original.anchor, offset: 1 } });
    });
    expect(errorCodes(validatePackage(overlap))).toContain('TRACK_OVERLAP');
    expect(errorCodes(validatePackage(mutate(makePackage(), p => {
      row(p.audio_cues, 'cue_say').mix.fade_in_seconds = 4;
    })))).toContain('AUDIO_FADE');
    expect(errorCodes(validatePackage(mutate(makePackage(), p => {
      row(p.audio_cues, 'cue_say').anchor.offset = -10;
    })))).toContain('CUE_RANGE');
  });

  it('allows beat anchors only when this rendition has timing evidence', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.audio_cues, 'cue_say').anchor.ref = id('b_say');
    });
    expect(validatePackage(pkg).valid).toBe(true);
    expect(errorCodes(validatePackage(mutate(pkg, p => {
      row(p.shots, 'sh_2').beat_refs = [];
      // cue_say cannot infer its own beat start: that would be self-referential timing.
    })))).toContain('ANCHOR_CYCLE');
  });

  it('does not let a global cue claim coverage of another episode', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      p.audio_cues = p.audio_cues.filter(c => c.id !== id('cue_a_arrive'));
      row(p.audio_cues, 'cue_a_reply').anchor = { ref: id('ep_2'), edge: 'start', offset: 0 };
      p.audio_tracks.push({ id: id('track-extra'), version: 1, rendition_id: id('rnd_a'), role: 'music', allow_overlap: true });
      const music = row(p.audio_cues, 'cue_music_1');
      p.audio_cues.push({ ...music, id: id('cue_false_coverage'), rendition_id: id('rnd_a'), track_id: id('track-extra'), beat_refs: [id('b_arrive')] } as typeof music);
    });
    const report = validatePackage(pkg, { stage: 'delivery' });
    expect(report.valid).toBe(false);
    expect(errorCodes(report)).toEqual(expect.arrayContaining(['SCENE_OWNERSHIP', 'BEAT_COVERAGE']));
  });
});

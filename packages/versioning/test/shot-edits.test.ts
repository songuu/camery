import { describe, expect, it } from 'vitest';
import type { ChangeOp, Shot, StoryboardPackage } from '@camery/ir';
import { validatePackage } from '@camery/ir';
import { resolveTimeline, toSeconds } from '@camery/timeline';
import { applyShotEdit } from '../src/shot-edits';
import { fixtureId as id, makePackage, makeProductionPackage, mutate, row } from '../../ir/test/fixtures';

type ShotEdit = Extract<ChangeOp, { op: 'split' | 'merge' }>;
const draft = (source: Shot, alias: string, planned: number, overrides: Partial<Omit<Shot, 'version'>> = {}): Omit<Shot, 'version'> => {
  const { version: _version, ...rest } = structuredClone(source);
  return { ...rest, id: id(alias), duration: { planned, measured: null }, ...overrides };
};
const splitOp = (pkg: StoryboardPackage, sizes = [2, 4]): ShotEdit => ({
  op: 'split', op_id: id('split-op'), target: id('sh_2'),
  into: sizes.map((size, index) => draft(row(pkg.shots, 'sh_2'), `part-${index}`, size)),
});
const context = () => { let counter = 0; return { newId: () => id('allocated-' + counter++) }; };
const cueSeconds = (pkg: StoryboardPackage, cueId: string): number => {
  const result = resolveTimeline(pkg);
  const cue = row(pkg.audio_cues, cueId);
  const timeline = result.timelines.find(t => t.rendition_id === cue.rendition_id && t.episode_id === cue.episode_id)!;
  expect(result.valid, JSON.stringify(result.issues)).toBe(true);
  return toSeconds(timeline.spans.get(cue.id)!.start);
};

describe('atomic shot split remapping', () => {
  it('rejects a rounded source interval that collapses to zero before emitting warnings', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      row(p.shots, 'sh_2').duration.planned = 2e-16;
      const take = p.shot_takes.find(t => t.shot_id === id('sh_2'))!;
      take.source_in = 0.5; take.source_out = 0.5000000000000001;
      take.playback_rate = { numerator: 1, denominator: 2 };
      const cue = row(p.audio_cues, 'cue_say');
      cue.anchor.offset = 0;
      cue.extent = { kind: 'fixed', duration: { planned: 2e-16, measured: null } };
    });
    expect(validatePackage(pkg).valid).toBe(true);
    const warnings: unknown[] = [];
    expect(() => applyShotEdit(pkg, splitOp(pkg, [1e-16, 1e-16]), { ...context(), warn: issue => warnings.push(issue) })).toThrow(/TIME_PRECISION/);
    expect(warnings).toEqual([]);
  });
  it('splits shots while keeping other object versions and package head untouched', () => {
    const pkg = makePackage();
    const result = applyShotEdit(pkg, splitOp(pkg), context());
    expect(result.revision).toEqual(pkg.revision);
    expect(result.shots.filter(s => [id('part-0'), id('part-1')].includes(s.id)).map(s => s.version)).toEqual([1, 1]);
    expect(row(result.shots, 'sh_1')).toEqual(row(pkg.shots, 'sh_1'));
    expect(result.shot_lineage).toEqual([{ from_ids: [id('sh_2')], to_ids: [id('part-0'), id('part-1')], revision: pkg.revision.number + 1 }]);
    expect(pkg.shots.some(s => s.id === id('sh_2'))).toBe(true);
    expect(validatePackage(result).valid).toBe(true);
  });

  it('maps midpoint keyframes to local ratios and keeps end frames at the final piece', () => {
    const pkg = makePackage();
    const result = applyShotEdit(pkg, splitOp(pkg), context());
    expect(row(result.panels, 'p_key')).toMatchObject({ shot_id: id('part-1'), position: 'intermediate', offset_ratio: 0.25, version: 1 });
    expect(row(result.panels, 'p_end')).toMatchObject({ shot_id: id('part-1'), position: 'end' });
    expect(row(result.panels, 'p_end')).not.toHaveProperty('offset_ratio');
    expect(row(result.panels, 'p_start')).toEqual(row(pkg.panels, 'p_start'));
  });

  it('turns a keyframe exactly at a split into a start frame, without an illegal zero ratio', () => {
    const pkg = makePackage();
    const result = applyShotEdit(pkg, splitOp(pkg, [3, 3]), context());
    expect(row(result.panels, 'p_key')).toMatchObject({ shot_id: id('part-1'), position: 'start' });
    expect(row(result.panels, 'p_key')).not.toHaveProperty('offset_ratio');
  });

  it('canonicalizes a rounded boundary ratio instead of creating intermediate ratio 1', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.shots, 'sh_2').duration.planned = 0.7;
      const panel = row(p.panels, 'p_key');
      if (panel.position === 'intermediate') panel.offset_ratio = 1 / 7;
    });
    const warnings: unknown[] = [];
    const result = applyShotEdit(pkg, splitOp(pkg, [0.1, 0.6]), { ...context(), warn: issue => warnings.push(issue) });
    expect(row(result.panels, 'p_key')).toMatchObject({ shot_id: id('part-0'), position: 'end' });
    expect(row(result.panels, 'p_key')).not.toHaveProperty('offset_ratio');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('preserves absolute cue start and until endpoints with negative and overflowing offsets', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.audio_cues, 'cue_say').anchor = { ref: id('sh_2'), edge: 'end', offset: -0.5 };
      Object.assign(row(p.audio_cues, 'cue_music_1'), { extent: { kind: 'until', anchor: { ref: id('sh_2'), edge: 'start', offset: 7.5 } } });
    });
    const result = applyShotEdit(pkg, splitOp(pkg), context());
    expect(row(result.audio_cues, 'cue_say').anchor).toEqual({ ref: id('part-1'), edge: 'end', offset: -0.5 });
    expect(row(result.audio_cues, 'cue_music_1').extent).toEqual({ kind: 'until', anchor: { ref: id('part-1'), edge: 'end', offset: 1.5 } });
    expect(row(pkg.audio_cues, 'cue_say').anchor.ref).toBe(id('sh_2'));
  });

  it.each([
    ['start', -1, 'part-0', 'start', -1],
    ['end', 1, 'part-1', 'end', 1],
    ['start', 2, 'part-1', 'start', 0],
    ['end', -4, 'part-0', 'end', 0],
    ['start', 5, 'part-1', 'start', 3],
  ] as const)('maps %s offset %s across boundaries', (edge, offset, part, mappedEdge, mappedOffset) => {
    const pkg = mutate(makePackage(), p => { row(p.audio_cues, 'cue_say').anchor = { ref: id('sh_2'), edge, offset }; });
    const result = applyShotEdit(pkg, splitOp(pkg), context());
    expect(row(result.audio_cues, 'cue_say').anchor).toEqual({ ref: id(part), edge: mappedEdge, offset: mappedOffset });
  });

  it('clips a generated take across pieces and retains its shared material provenance', () => {
    const pkg = makeProductionPackage();
    const oldTake = pkg.shot_takes.find(t => t.shot_id === id('sh_2'))!;
    const result = applyShotEdit(pkg, splitOp(pkg), context());
    const takes = result.shot_takes.filter(t => [id('part-0'), id('part-1')].includes(t.shot_id));
    expect(takes.map(t => [t.source_in, t.source_out, t.timeline_offset])).toEqual([[0.5, 2.5, 0], [2.5, 6.5, 0]]);
    expect(takes.every(t => t.id !== oldTake.id && t.version === 1 && t.media_asset_id.id === id('video'))).toBe(true);
    expect(result.shot_takes.filter(t => t.shot_id !== id('part-0') && t.shot_id !== id('part-1'))).toEqual(pkg.shot_takes.filter(t => t.shot_id !== id('sh_2')));
    expect(validatePackage(result, { stage: 'delivery' }).valid).toBe(true);
  });

  it('preserves candidate take identity when it does not cross a cut, and supports explicit speed', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      const take = p.shot_takes.find(t => t.shot_id === id('sh_2'))!;
      take.source_out = 9.5;
      take.playback_rate = { numerator: 3, denominator: 2 };
      p.shot_takes.push({ ...take, id: id('candidate'), source_out: 2, status: 'candidate' });
    });
    const result = applyShotEdit(pkg, splitOp(pkg), context());
    expect(row(result.shot_takes, 'candidate')).toMatchObject({ shot_id: id('part-0'), source_in: 0.5, source_out: 2, version: 1 });
    expect(result.shot_takes.filter(t => t.status === 'adopted' && t.shot_id === id('part-1'))[0]).toMatchObject({ source_in: 3.5, source_out: 9.5 });
    expect(validatePackage(result, { stage: 'delivery' }).valid).toBe(true);
  });
});

describe('atomic shot merge remapping', () => {
  it('round-trips split/merge timeline times, panels and generated take intervals', () => {
    const pkg = makeProductionPackage();
    const split = applyShotEdit(pkg, splitOp(pkg), context());
    const joined = draft(row(pkg.shots, 'sh_2'), 'joined', 6);
    const result = applyShotEdit(split, { op: 'merge', op_id: id('merge-op'), targets: [id('part-0'), id('part-1')], into: joined }, context());
    expect(cueSeconds(result, 'cue_say')).toBe(cueSeconds(pkg, 'cue_say'));
    expect(row(result.panels, 'p_key')).toMatchObject({ shot_id: id('joined'), position: 'intermediate', offset_ratio: 0.5 });
    expect(row(result.panels, 'p_end')).toMatchObject({ shot_id: id('joined'), position: 'end' });
    const takes = result.shot_takes.filter(t => t.shot_id === id('joined'));
    expect(takes.map(t => t.id)).toEqual(split.shot_takes.filter(t => [id('part-0'), id('part-1')].includes(t.shot_id)).map(t => t.id));
    expect(takes.map(t => [t.source_in, t.source_out, t.timeline_offset])).toEqual([[0.5, 2.5, 0], [2.5, 6.5, 2]]);
    expect(result.shot_lineage).toHaveLength(2);
    expect(validatePackage(result, { stage: 'delivery' }).valid).toBe(true);
  });

  it('maps original shot start/end anchors with offsets into a merged shot', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.audio_cues, 'cue_say').anchor = { ref: id('sh_2'), edge: 'start', offset: 0.5 };
      Object.assign(row(p.audio_cues, 'cue_music_1'), { extent: { kind: 'until', anchor: { ref: id('sh_1'), edge: 'end', offset: 1 } } });
    });
    const result = applyShotEdit(pkg, { op: 'merge', op_id: id('merge-op'), targets: [id('sh_1'), id('sh_2')], into: draft(row(pkg.shots, 'sh_1'), 'joined', 10, { beat_refs: [id('b_open'), id('b_say')] }) }, context());
    expect(row(result.audio_cues, 'cue_say').anchor).toEqual({ ref: id('joined'), edge: 'start', offset: 4.5 });
    expect(row(result.audio_cues, 'cue_music_1').extent).toEqual({ kind: 'until', anchor: { ref: id('joined'), edge: 'end', offset: -5 } });
    expect(cueSeconds(result, 'cue_say')).toBe(cueSeconds(pkg, 'cue_say'));
  });

  it('reports bounded Number rounding for a normal one-third keyframe ratio', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.shots, 'sh_1').duration.planned = 1;
      row(p.shots, 'sh_2').duration.planned = 2;
      row(p.panels, 'p_start').position = 'start';
      p.panels.push({ ...row(p.panels, 'p_end'), id: id('boundary'), shot_id: id('sh_1'), position: 'end' });
    });
    const warnings: Array<{ code: string; where: string; message: string }> = [];
    const result = applyShotEdit(pkg, { op: 'merge', op_id: id('merge-op'), targets: [id('sh_1'), id('sh_2')], into: draft(row(pkg.shots, 'sh_1'), 'joined', 3, { beat_refs: [id('b_open'), id('b_say')] }) }, { ...context(), warn: issue => warnings.push(issue) });
    expect(row(result.panels, 'boundary')).toMatchObject({ position: 'intermediate', offset_ratio: 1 / 3 });
    expect(warnings.some(w => w.code === 'TIME_ROUNDED')).toBe(true);
  });

  it('reports bounded source-time rounding while preserving playback-rate timing', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      const take = p.shot_takes.find(t => t.shot_id === id('sh_2'))!;
      take.playback_rate = { numerator: 1, denominator: 3 };
      take.source_out = 2.5;
    });
    const warnings: Array<{ code: string; where: string; message: string }> = [];
    const result = applyShotEdit(pkg, splitOp(pkg), { ...context(), warn: issue => warnings.push(issue) });
    expect(result.shot_takes.filter(t => t.shot_id === id('part-0'))[0]!.source_out).toBeCloseTo(7 / 6);
    expect(warnings.some(w => w.where.startsWith('/shot_takes/'))).toBe(true);
    expect(validatePackage(result, { stage: 'delivery' }).valid).toBe(true);
  });
});

describe('shot edit failure boundaries', () => {
  it.each([
    ['missing target', (p: StoryboardPackage): ShotEdit => ({ ...splitOp(p), target: id('missing') } as ShotEdit)],
    ['cross scene', (p: StoryboardPackage): ShotEdit => ({ ...splitOp(p), into: [draft(row(p.shots, 'sh_2'), 'part-0', 2, { scene_id: id('sc_2') }), draft(row(p.shots, 'sh_2'), 'part-1', 4)] } as ShotEdit)],
    ['cross rendition', (p: StoryboardPackage): ShotEdit => ({ ...splitOp(p), into: [draft(row(p.shots, 'sh_2'), 'part-0', 2, { rendition_id: id('rnd_a') }), draft(row(p.shots, 'sh_2'), 'part-1', 4)] } as ShotEdit)],
    ['reuse removed target ID', (p: StoryboardPackage): ShotEdit => ({ ...splitOp(p), into: [draft(row(p.shots, 'sh_2'), 'sh_2', 2), draft(row(p.shots, 'sh_2'), 'part-1', 4)] } as ShotEdit)],
    ['reuse another object ID', (p: StoryboardPackage): ShotEdit => ({ ...splitOp(p), into: [draft(row(p.shots, 'sh_2'), 'ep_1', 2), draft(row(p.shots, 'sh_2'), 'part-1', 4)] } as ShotEdit)],
    ['nonconserving duration', (p: StoryboardPackage): ShotEdit => splitOp(p, [1, 1])],
    ['too few pieces', (p: StoryboardPackage): ShotEdit => splitOp(p, [6])],
    ['malformed shot draft', (p: StoryboardPackage): ShotEdit => ({ ...splitOp(p), into: [draft(row(p.shots, 'sh_2'), 'part-0', -1), draft(row(p.shots, 'sh_2'), 'part-1', 7)] } as ShotEdit)],
    ['empty merge', (p: StoryboardPackage): ShotEdit => ({ op: 'merge', op_id: id('merge-op'), targets: [], into: draft(row(p.shots, 'sh_1'), 'joined', 4) })],
    ['duplicate replacement IDs', (p: StoryboardPackage): ShotEdit => ({ ...splitOp(p), into: [draft(row(p.shots, 'sh_2'), 'part-0', 2), draft(row(p.shots, 'sh_2'), 'part-0', 4)] } as ShotEdit)],
    ['merge nonadjacent/cross scene', (p: StoryboardPackage): ShotEdit => ({ op: 'merge', op_id: id('merge-op'), targets: [id('sh_1'), id('sh_3')], into: draft(row(p.shots, 'sh_1'), 'joined', 9) })],
    ['merge reverse order', (p: StoryboardPackage): ShotEdit => ({ op: 'merge', op_id: id('merge-op'), targets: [id('sh_2'), id('sh_1')], into: draft(row(p.shots, 'sh_1'), 'joined', 10) })],
  ] as const)('rejects %s atomically', (_label, operation) => {
    const pkg = makePackage();
    expect(() => applyShotEdit(pkg, operation(pkg), context())).toThrow();
    expect(pkg.shots).toHaveLength(4);
    expect(pkg.shot_lineage).toEqual([]);
  });

  it('rejects a generated take ID collision or malformed ID', () => {
    const pkg = makeProductionPackage();
    expect(() => applyShotEdit(pkg, splitOp(pkg), { newId: () => id('sh_1') })).toThrow();
    expect(() => applyShotEdit(pkg, splitOp(pkg), { newId: () => 'bad-id' })).toThrow();
    expect(() => applyShotEdit(pkg, splitOp(pkg), { newId: () => id('repeated') })).toThrow();
  });

  it('does not silently drop out-of-shot candidate media', () => {
    const pkg = mutate(makeProductionPackage(), p => { p.shot_takes.find(t => t.shot_id === id('sh_2'))!.timeline_offset = 5; });
    expect(() => applyShotEdit(pkg, splitOp(pkg), context())).toThrow();
  });

  it('does not guess visible dialogue when the new piece drops its speaking beat', () => {
    const pkg = mutate(makeProductionPackage(), p => { p.shot_takes.find(t => t.shot_id === id('sh_2'))!.visible_speaker_id = id('char_lin'); });
    const op = splitOp(pkg);
    if (op.op === 'split') op.into[1]!.beat_refs = [];
    expect(() => applyShotEdit(pkg, op, context())).toThrow();
  });

  it('rejects reuse of historical shot IDs', () => {
    const pkg = mutate(makePackage(), p => { p.shot_lineage.push({ from_ids: [id('part-0')], to_ids: [id('sh_1')], revision: 4 }); });
    expect(() => applyShotEdit(pkg, splitOp(pkg), context())).toThrow();
  });

  it('rejects panel precision loss larger than one nanosecond', () => {
    const pkg = mutate(makePackage(), p => {
      row(p.shots, 'sh_1').duration.planned = 1e12;
      row(p.shots, 'sh_2').duration.planned = 2e12;
      p.panels.push({ ...row(p.panels, 'p_end'), id: id('boundary'), shot_id: id('sh_1'), position: 'end' });
    });
    expect(() => applyShotEdit(pkg, { op: 'merge', op_id: id('merge-op'), targets: [id('sh_1'), id('sh_2')], into: draft(row(pkg.shots, 'sh_1'), 'joined', 3e12) }, context())).toThrow(/TIME_PRECISION/);
  });

  it('requires explicit recomputation for snapshots bound to a removed shot, preserving unrelated snapshots', () => {
    const pkg = mutate(makePackage(), p => {
      p.episode_state_snapshots.push({
        id: id('snapshot'), version: 1, episode_id: id('ep_1'), status: 'adopted', based_on: [{ id: id('ep_1'), version: 1 }],
        facts: [], knowledge: [], characters: [], plot_threads: [],
      });
    });
    expect(applyShotEdit(pkg, splitOp(pkg), context()).episode_state_snapshots).toEqual(pkg.episode_state_snapshots);
    const dependent = mutate(pkg, p => { p.episode_state_snapshots[0]!.based_on = [{ id: id('sh_2'), version: 5 }]; });
    expect(() => applyShotEdit(dependent, splitOp(dependent), context())).toThrow(/DEPENDENT_SNAPSHOT/);
  });

  it('does not emit partial warnings if a later source-time precision failure aborts the edit', () => {
    const pkg = mutate(makeProductionPackage(), p => {
      const take = p.shot_takes.find(t => t.shot_id === id('sh_2'))!;
      take.playback_rate = { numerator: 1, denominator: 3 };
      take.source_in = 1e12;
      take.source_out = 1e12 + 2;
    });
    const warnings: unknown[] = [];
    expect(() => applyShotEdit(pkg, splitOp(pkg), { ...context(), warn: warning => warnings.push(warning) })).toThrow(/TIME_PRECISION/);
    expect(warnings).toEqual([]);
  });
});

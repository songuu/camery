import { describe, expect, it } from 'vitest';
import { resolveTimeline } from '../src/resolve';
import type { TimelineInput } from '../src/resolve';
import { toSeconds } from '../src/time';

function input(): TimelineInput {
  return {
    episodes: [{ id: 'ep1', order_key: 'a0' }, { id: 'ep2', order_key: 'a1' }],
    renditions: [{ id: 'video', kind: 'video' }, { id: 'audio', kind: 'audio' }],
    scenes: [{ id: 'sc1', episode_id: 'ep1', order_key: 'a0' }, { id: 'sc2', episode_id: 'ep2', order_key: 'a0' }],
    beats: [{ id: 'beat1', scene_id: 'sc1', order_key: 'a0' }],
    lines: [{ id: 'line1', beat_id: 'beat1' }],
    shots: [
      { id: 's2', rendition_id: 'video', scene_id: 'sc1', order_key: 'a1', duration: { planned: 0.2, measured: null }, beat_refs: [] },
      { id: 's1', rendition_id: 'video', scene_id: 'sc1', order_key: 'a0', duration: { planned: 0.1, measured: null }, beat_refs: ['beat1'] },
      { id: 's3', rendition_id: 'video', scene_id: 'sc2', order_key: 'a0', duration: { planned: 7, measured: 5 }, beat_refs: [] },
    ],
    audio_tracks: [{ id: 'voice', rendition_id: 'audio', allow_overlap: false }, { id: 'music', rendition_id: 'audio', allow_overlap: true }],
    audio_cues: [
      { id: 'a', rendition_id: 'audio', episode_id: 'ep1', track_id: 'voice', line_id: 'line1', anchor: { ref: 'ep1', edge: 'start', offset: 0 }, extent: { kind: 'fixed', duration: { planned: 3, measured: 2 } }, mix: { fade_in_seconds: 0, fade_out_seconds: 0 } },
      { id: 'b', rendition_id: 'audio', episode_id: 'ep1', track_id: 'voice', beat_refs: [], anchor: { ref: 'a', edge: 'end', offset: 0.2 }, extent: { kind: 'fixed', duration: { planned: 3, measured: null } }, mix: { fade_in_seconds: 0, fade_out_seconds: 0 } },
      { id: 'bed', rendition_id: 'audio', episode_id: 'ep1', track_id: 'music', beat_refs: [], anchor: { ref: 'ep1', edge: 'start', offset: 0 }, extent: { kind: 'until', anchor: { ref: 'ep1', edge: 'end', offset: 0 } }, mix: { fade_in_seconds: 0, fade_out_seconds: 0 } },
    ],
  };
}

describe('episode/rendition relative timeline', () => {
  it('accepts structural inputs with unrelated package metadata without inspecting those fields', () => {
    const pkg = { ...input(), package_id: 'package', revision: { number: 1 }, assets: [{ id: 's1' }] };
    expect(resolveTimeline(pkg).valid).toBe(true);
  });
  it('orders by scene and shot keys, resets each episode, and uses measured timing', () => {
    const result = resolveTimeline(input());
    expect(result.issues).toEqual([]);
    const video = result.timelines.find(t => t.episode_id === 'ep1' && t.rendition_id === 'video')!;
    expect(toSeconds(video.duration)).toBe(0.3);
    expect(toSeconds(video.spans.get('s2')!.start)).toBe(0.1);
    const second = result.timelines.find(t => t.episode_id === 'ep2' && t.rendition_id === 'video')!;
    expect(toSeconds(second.spans.get('s3')!.start)).toBe(0);
    expect(toSeconds(second.duration)).toBe(5);
  });

  it('resolves cue chains and audio episode-end beds without guessing target length', () => {
    const result = resolveTimeline(input());
    const audio = result.timelines.find(t => t.episode_id === 'ep1' && t.rendition_id === 'audio')!;
    expect(toSeconds(audio.duration)).toBe(5.2);
    expect(toSeconds(audio.spans.get('b')!.start)).toBe(2.2);
    expect(toSeconds(audio.spans.get('bed')!.end)).toBe(5.2);
    expect(toSeconds(audio.spans.get('beat1')!.end)).toBe(2);
  });

  it('resolves endpoints separately, so a cue start is independent of its end', () => {
    const pkg = input();
    pkg.audio_cues = [
      { ...pkg.audio_cues[0]!, id: 'a', extent: { kind: 'until', anchor: { ref: 'b', edge: 'end', offset: 0 } } },
      { ...pkg.audio_cues[1]!, id: 'b', anchor: { ref: 'a', edge: 'start', offset: 1 } },
    ];
    pkg.audio_tracks[0]!.allow_overlap = true;
    const result = resolveTimeline(pkg);
    expect(result.valid).toBe(true);
    expect(toSeconds(result.timelines.find(t => t.rendition_id === 'audio' && t.episode_id === 'ep1')!.duration)).toBe(4);
  });

  it.each([
    ['ANCHOR_CYCLE', (p: TimelineInput) => { p.audio_cues[0]!.anchor.ref = 'b'; }],
    ['ANCHOR_REFERENCE', (p: TimelineInput) => { p.audio_cues[0]!.anchor.ref = 'missing'; }],
    ['ANCHOR_SCOPE', (p: TimelineInput) => { p.audio_cues[0]!.anchor.ref = 's1'; }],
    ['ANCHOR_SCOPE', (p: TimelineInput) => { p.audio_cues[0]!.anchor.ref = 'ep2'; }],
    ['TRACK_OVERLAP', (p: TimelineInput) => { p.audio_cues[1]!.anchor = { ref: 'a', edge: 'start', offset: 1 }; }],
    ['CUE_RANGE', (p: TimelineInput) => { p.audio_cues[0]!.anchor.offset = -1; }],
    ['AUDIO_FADE', (p: TimelineInput) => { p.audio_cues[0]!.mix = { fade_in_seconds: 2, fade_out_seconds: 2 }; }],
    ['CUE_DURATION', (p: TimelineInput) => { p.audio_cues[0]!.extent = { kind: 'until', anchor: { ref: 'ep1', edge: 'start', offset: 0 } }; }],
    ['ORDER_KEY', (p: TimelineInput) => { p.shots[0]!.order_key = p.shots[1]!.order_key; }],
    ['DUPLICATE_ID', (p: TimelineInput) => { p.audio_cues[0]!.id = 'bed'; }],
    ['TRACK_REFERENCE', (p: TimelineInput) => { p.audio_cues[0]!.track_id = 'missing'; }],
    ['UNRESOLVED_DURATION', (p: TimelineInput) => { p.audio_cues = [p.audio_cues[2]!]; }],
    ['IDENTIFIER', (p: TimelineInput) => { p.episodes[0]!.id = ''; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.scenes[0]!.episode_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.beats[0]!.scene_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.lines[0]!.beat_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.shots[0]!.scene_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.shots[0]!.rendition_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.shots[0]!.beat_refs = ['missing']; }],
    ['ANCHOR_SCOPE', (p: TimelineInput) => { p.shots[2]!.beat_refs = ['beat1']; }],
    ['TARGET', (p: TimelineInput) => { p.shots[0]!.rendition_id = 'audio'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.audio_tracks[0]!.rendition_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.audio_cues[0]!.episode_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.audio_cues[0]!.rendition_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.audio_cues[0]!.line_id = 'missing'; }],
    ['TIMELINE_REFERENCE', (p: TimelineInput) => { p.audio_cues[0]!.beat_refs = ['missing']; }],
    ['ANCHOR_REFERENCE', (p: TimelineInput) => { p.shots[1]!.beat_refs = []; p.audio_cues[1]!.anchor.ref = 'beat1'; delete p.audio_cues[0]!.line_id; }],
    ['ANCHOR_SCOPE', (p: TimelineInput) => { p.audio_cues = [p.audio_cues[0]!]; p.audio_cues[0]!.episode_id = 'ep2'; p.audio_cues[0]!.anchor.ref = 'ep2'; }],
    ['ANCHOR_SCOPE', (p: TimelineInput) => { p.audio_cues = [p.audio_cues[0]!]; p.audio_cues[0]!.episode_id = 'ep2'; p.audio_cues[0]!.anchor.ref = 'ep2'; delete p.audio_cues[0]!.line_id; p.audio_cues[0]!.beat_refs = ['beat1']; }],
    ['DURATION', (p: TimelineInput) => { p.shots[0]!.duration.planned = 0; }],
    ['DURATION', (p: TimelineInput) => { p.audio_cues[0]!.extent = { kind: 'fixed', duration: { planned: 0, measured: null } }; }],
    ['TIME_FINITE', (p: TimelineInput) => { p.audio_cues[0]!.anchor.offset = Infinity; }],
    ['TIME_FINITE', (p: TimelineInput) => { p.audio_cues[0]!.mix.fade_in_seconds = NaN; }],
    ['AUDIO_FADE', (p: TimelineInput) => { p.audio_cues[0]!.mix.fade_out_seconds = -1; }],
  ] as const)('reports %s with contextual location', (code, edit) => {
    const pkg = input(); edit(pkg);
    const result = resolveTimeline(pkg);
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.code === code && i.where.startsWith('/'))).toBe(true);
  });

  it('keeps the longest active interval when finding nested overlaps', () => {
    const pkg = input();
    const a = pkg.audio_cues[0]!;
    pkg.audio_cues = [
      { ...a, id: 'long', extent: { kind: 'fixed', duration: { planned: 10, measured: null } } },
      { ...a, id: 'inner1', anchor: { ref: 'ep1', edge: 'start', offset: 1 }, extent: { kind: 'fixed', duration: { planned: 1, measured: null } } },
      { ...a, id: 'inner2', anchor: { ref: 'ep1', edge: 'start', offset: 3 }, extent: { kind: 'fixed', duration: { planned: 1, measured: null } } },
    ];
    expect(resolveTimeline(pkg).issues.filter(i => i.code === 'TRACK_OVERLAP')).toHaveLength(2);
  });

  it('does not mutate a frozen input and permits exactly touching cue boundaries', () => {
    const pkg = input();
    pkg.audio_cues[1]!.anchor.offset = 0;
    const freeze = (value: object): void => { for (const item of Object.values(value)) if (item && typeof item === 'object') freeze(item); Object.freeze(value); };
    freeze(pkg);
    expect(resolveTimeline(pkg).valid).toBe(true);
  });
});

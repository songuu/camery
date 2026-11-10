import { expect, it } from 'vitest';
import { resolveTimeline } from '../src/resolve';
import type { TimelineInput } from '../src/resolve';
import { toSeconds } from '../src/time';

it('preserves independent integer-millisecond reference timelines in 10,000 seeded cases', () => {
  let seed = 0x3ae791f5;
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let trial = 0; trial < 10_000; trial++) {
    const pkg: TimelineInput = {
      episodes: [{ id: 'e0', order_key: 'a0' }, { id: 'e1', order_key: 'a1' }],
      renditions: [{ id: 'v', kind: 'video' }, { id: 'a', kind: 'audio' }],
      scenes: [], beats: [], lines: [], shots: [], audio_tracks: [{ id: 't', rendition_id: 'a', allow_overlap: false }], audio_cues: [],
    };
    const expected = new Map<string, [number, number]>();
    for (const episode of pkg.episodes) {
      const scene = 'sc' + episode.id;
      pkg.scenes.push({ id: scene, episode_id: episode.id, order_key: 'a0' });
      const count = 1 + next() % 6;
      let picture = 0;
      let audio = 0;
      let previous = episode.id;
      for (let i = 0; i < count; i++) {
        const planned = 1 + next() % 10_000;
        const measured = next() % 2 ? 1 + next() % 10_000 : null;
        const duration = measured ?? planned;
        const shot = `s${episode.id}-${i}`;
        const cue = `c${episode.id}-${i}`;
        const gap = next() % 100;
        pkg.shots.push({ id: shot, rendition_id: 'v', scene_id: scene, order_key: `a${i}`, beat_refs: [], duration: { planned: planned / 1000, measured: measured === null ? null : measured / 1000 } });
        expected.set(shot, [picture, picture + duration]);
        picture += duration;
        pkg.audio_cues.push({ id: cue, rendition_id: 'a', episode_id: episode.id, track_id: 't', beat_refs: [], anchor: { ref: previous, edge: i ? 'end' : 'start', offset: gap / 1000 }, extent: { kind: 'fixed', duration: { planned: planned / 1000, measured: measured === null ? null : measured / 1000 } }, mix: { fade_in_seconds: 0, fade_out_seconds: 0 } });
        expected.set(cue, [audio + gap, audio + gap + duration]);
        audio += gap + duration;
        previous = cue;
      }
      expected.set('v:' + episode.id, [0, picture]);
      expected.set('a:' + episode.id, [0, audio]);
    }
    // 集合的物理顺序不等于播放顺序；锚点允许指向尚未遍历到的 cue。
    if (next() % 2) pkg.shots.reverse();
    if (next() % 2) pkg.audio_cues.reverse();
    const resolved = resolveTimeline(pkg);
    if (!resolved.valid) throw new Error(`trial=${trial}, seed=${seed}: ${JSON.stringify(resolved.issues)}`);
    for (const timeline of resolved.timelines) {
      const total = expected.get(timeline.rendition_id + ':' + timeline.episode_id)![1];
      if (timeline.duration.numerator * 1000n !== BigInt(total) * timeline.duration.denominator) throw new Error(`trial=${trial}: wrong episode total`);
      for (const [id, span] of timeline.spans) {
        const reference = expected.get(id);
        if (reference === undefined) continue;
        if (span.start.numerator * 1000n !== BigInt(reference[0]) * span.start.denominator || span.end.numerator * 1000n !== BigInt(reference[1]) * span.end.denominator)
          throw new Error(`trial=${trial}, id=${id}: wrong interval`);
      }
    }
  }
}, 30_000);

it('resolves a 5,000-cue dependency chain without recursive stack growth', () => {
  const pkg: TimelineInput = {
    episodes: [{ id: 'e', order_key: 'a0' }], renditions: [{ id: 'a', kind: 'audio' }],
    scenes: [], beats: [], lines: [], shots: [], audio_tracks: [{ id: 't', rendition_id: 'a', allow_overlap: false }], audio_cues: [],
  };
  for (let i = 0; i < 5000; i++) pkg.audio_cues.push({
    id: 'c' + i, rendition_id: 'a', episode_id: 'e', track_id: 't', beat_refs: [],
    anchor: { ref: i ? 'c' + (i - 1) : 'e', edge: i ? 'end' : 'start', offset: 0 },
    extent: { kind: 'fixed', duration: { planned: 0.1, measured: null } }, mix: { fade_in_seconds: 0, fade_out_seconds: 0 },
  });
  const result = resolveTimeline(pkg);
  expect(result.issues).toEqual([]);
  expect(toSeconds(result.timelines[0]!.duration)).toBe(500);
  expect(toSeconds(result.timelines[0]!.spans.get('c4999')!.end)).toBe(500);
});

import { describe, expect, it } from 'vitest';
import type { StoryboardPackage } from '../src/index';
import { validatePackage } from '../src/index';
import { errorCodes, fixtureId as id, makePackage, mutate, row } from './fixtures';

type Edit = (p: StoryboardPackage) => void;
const cases: Array<[string, Edit]> = [
  ['VOICE_REFERENCE', p => { p.characters[0]!.default_voice_ref_id = id('ar_img'); }],
  ['VOICE_REFERENCE', p => { row(p.assets, 'as_voice').media_type = 'image'; }],
  ['TRACK_SCOPE', p => { p.audio_tracks[0]!.rendition_id = id('rnd_a'); }],
  ['TRACK_SCOPE', p => { p.audio_tracks[0]!.role = 'music'; }],
  ['ANCHOR_SCOPE', p => { p.audio_cues[0]!.anchor.ref = id('cue_a_open'); }],
  ['ANCHOR_SCOPE', p => { p.audio_cues[0]!.anchor.ref = id('sh_3'); }],
  ['ANCHOR_SCOPE', p => { p.audio_cues[0]!.anchor.ref = id('ep_2'); }],
  ['SCENE_OWNERSHIP', p => { Object.assign(p.audio_cues[0]!, { line_id: id('l_reply') }); }],
  ['AUDIO_SCRIPT', p => { row(p.lines, 'l_say').only_rendition_ids = [id('rnd_a')]; }],
  ['SCENE_OWNERSHIP', p => { Object.assign(row(p.audio_cues, 'cue_music_1'), { scene_id: id('sc_2') }); }],
  ['SCENE_OWNERSHIP', p => { Object.assign(row(p.audio_cues, 'cue_music_1'), { scene_id: id('sc_1'), beat_refs: [id('b_arrive')] }); }],
  ['MISSING_REFERENCE', p => { Object.assign(row(p.audio_cues, 'cue_music_1'), { beat_refs: [id('missing')] }); }],
  ['CONTINUATION', p => { Object.assign(row(p.audio_cues, 'cue_music_2'), { continues_from: id('cue_music_2') }); }],
  ['CONTINUATION', p => { Object.assign(row(p.audio_cues, 'cue_music_2'), { continues_from: id('cue_a_open') }); }],
  ['CONTINUATION', p => { Object.assign(row(p.audio_cues, 'cue_music_2'), { continues_from: id('cue_say') }); }],
  ['CONTINUATION', p => { Object.assign(row(p.audio_cues, 'cue_music_2'), { episode_id: id('ep_1') }); }],
    ['CONTINUATION', p => { Object.assign(row(p.audio_cues, 'cue_music_1'), { continues_from: id('cue_music_2') }); }],
  ['SCOPE', p => { p.project.scope.expected_episode_count++; }],
  ['SCOPE', p => { p.project.scope.expected_required_beat_count++; }],
  ['DUPLICATE_ID', p => { p.locations[1]!.spots[0]!.id = id('spot_desk'); }],
];

describe('sound and continuity references', () => {
  it.each(cases)('reports %s', (code, edit) => {
    expect(errorCodes(validatePackage(mutate(makePackage(), edit)))).toContain(code);
  });

  const withSnapshot = () => mutate(makePackage(), p => {
    p.episode_state_snapshots.push({
      id: id('snap'), version: 1, episode_id: id('ep_1'), based_on: [{ id: id('ep_1'), version: 1 }], status: 'adopted',
      facts: ['世界规则'], knowledge: [{ character_id: id('char_lin'), fact: '收到便签', source: '第一集' }],
      characters: [{ character_id: id('char_lin'), appearance_id: id('look_lin'), spot_id: id('spot_desk'), holding: [id('prop_note')] }],
      plot_threads: [{ setup_episode_id: id('ep_1'), payoff_episode_id: id('ep_2'), summary: '便签的来历' }],
    });
    p.plot_units.push({ id: id('plot'), version: 1, episode_ids: [id('ep_1'), id('ep_2')], pressure: '压力', escalation: '加码', reversal: '反转', release: '释放', next_crisis: '新危机' });
  });

  it('accepts an explicit versioned episode handoff', () => {
    expect(validatePackage(withSnapshot()).valid).toBe(true);
  });

  it.each([
    ['STALE_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.based_on[0]!.version++; }],
    ['MISSING_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.knowledge[0]!.character_id = id('missing'); }],
    ['MISSING_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.characters[0]!.character_id = id('missing'); }],
    ['MISSING_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.characters[0]!.appearance_id = id('missing'); }],
    ['MISSING_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.characters[0]!.holding = [id('missing')]; }],
    ['MISSING_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.plot_threads[0]!.setup_episode_id = id('missing'); }],
    ['MISSING_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.plot_threads[0]!.payoff_episode_id = id('missing'); }],
    ['MISSING_REFERENCE', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.characters[0]!.spot_id = id('missing'); }],
    ['APPEARANCE_OWNER', (p: StoryboardPackage) => { p.episode_state_snapshots[0]!.characters[0]!.character_id = id('char_he'); }],
  ] as const)('rejects handoff %s', (code, edit) => {
    expect(errorCodes(validatePackage(mutate(withSnapshot(), edit)))).toContain(code);
  });
});

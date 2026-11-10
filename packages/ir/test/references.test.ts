import { describe, expect, it } from 'vitest';
import type { StoryboardPackage } from '../src/index';
import { validatePackage } from '../src/index';
import { errorCodes, fixtureId as id, makeClaim, makeOmitDecision, makePackage, mutate, row } from './fixtures';

type Edit = (pkg: StoryboardPackage) => void;
const missing = id('missing');
const invalidReferences: Array<[string, Edit]> = [
  ['source', p => { p.project.source_ids = [missing]; }],
  ['scene episode', p => { p.scenes[0]!.episode_id = missing; }],
  ['scene cast', p => { p.scenes[0]!.character_ids = [missing]; }],
  ['beat scene', p => { p.beats[0]!.scene_id = missing; }],
  ['beat source', p => { p.beats[0]!.source_refs[0]!.source_id = missing; }],
  ['beat claim', p => { p.beats[0]!.claim_ids = [missing]; }],
  ['line beat', p => { p.lines[0]!.beat_id = missing; }],
  ['line speaker', p => { p.lines[0]!.speaker_id = missing; }],
  ['line rendition', p => { p.lines[0]!.only_rendition_ids = [missing]; }],
  ['shot scene', p => { p.shots[0]!.scene_id = missing; }],
  ['shot rendition', p => { p.shots[0]!.rendition_id = missing; }],
  ['shot beat', p => { p.shots[0]!.beat_refs = [missing]; }],
  ['shot asset', p => { p.shots[0]!.asset_ref_ids = [missing]; }],
  ['shot cast', p => { p.shots[0]!.start_state.characters[0]!.character_id = missing; }],
  ['shot appearance', p => { p.shots[0]!.start_state.characters[0]!.appearance_id = missing; }],
  ['shot prop', p => { p.shots[0]!.start_state.characters[0]!.holding = [missing]; }],
  ['asset ref', p => { p.asset_references[0]!.asset_id = missing; }],
  ['panel shot', p => { p.panels[0]!.shot_id = missing; }],
  ['panel candidate', p => { p.panels[0]!.candidate_asset_ref_ids = [missing]; }],
  ['panel adoption', p => { p.panels[0]!.adopted_asset_ref_id = missing; }],
  ['appearance owner', p => { p.appearances[0]!.character_id = missing; }],
  ['appearance scene', p => { p.appearances[0]!.scene_ids = [missing]; }],
  ['appearance image', p => { p.appearances[0]!.reference_asset_ref_ids = [missing]; }],
  ['voice', p => { p.characters[0]!.default_voice_ref_id = missing; }],
  ['claim evidence', p => { p.claims.push(makeClaim({ evidence: [{ source_id: missing, locator: 'x' }] })); }],
  ['track rendition', p => { p.audio_tracks[0]!.rendition_id = missing; }],
  ['cue line', p => { Object.assign(p.audio_cues[0]!, { line_id: missing }); }],
  ['cue track', p => { p.audio_cues[0]!.track_id = missing; }],
  ['cue anchor', p => { p.audio_cues[0]!.anchor.ref = missing; }],
  ['cue episode', p => { p.audio_cues[0]!.episode_id = missing; }],
  ['cue rendition', p => { p.audio_cues[0]!.rendition_id = missing; }],
  ['cue asset', p => { p.audio_cues[0]!.asset_ref_ids = [missing]; }],
  ['cue continuation', p => { Object.assign(row(p.audio_cues, 'cue_music_2'), { continues_from: missing }); }],
  ['decision beat', p => { p.adaptation_decisions.push(makeOmitDecision({ affected_beat_ids: [missing] })); }],
  ['plot episode', p => { p.plot_units.push({ id: id('plot'), version: 1, episode_ids: [missing], pressure: 'p', escalation: 'e', reversal: 'r', release: 'r', next_crisis: 'n' }); }],
  ['snapshot episode', p => { p.episode_state_snapshots.push({ id: id('snap'), version: 1, episode_id: missing, based_on: [{ id: missing, version: 1 }], status: 'adopted', facts: [], knowledge: [], characters: [], plot_threads: [] }); }],
];

describe('modeled references', () => {
  it.each(invalidReferences)('rejects missing %s', (_name, edit) => {
    expect(errorCodes(validatePackage(mutate(makePackage(), edit)))).toContain('MISSING_REFERENCE');
  });

  it.each([
    ['SPEAKER_SCOPE', (p: StoryboardPackage) => { p.scenes[0]!.character_ids = [id('char_he')]; }],
    ['APPEARANCE_OWNER', (p: StoryboardPackage) => { p.shots[0]!.start_state.characters[0]!.character_id = id('char_he'); }],
    ['SPOT_SCOPE', (p: StoryboardPackage) => { p.shots[0]!.start_state.characters[0]!.spot_id = id('spot_bench'); }],
    ['TARGET', (p: StoryboardPackage) => { p.shots[0]!.rendition_id = id('rnd_a'); }],
    ['ASSET_READINESS', (p: StoryboardPackage) => { p.asset_references[0]!.mode = 'planned'; }],
    ['PANEL_ASSET', (p: StoryboardPackage) => { p.assets[0]!.media_type = 'audio'; }],
    ['PANEL_ADOPTION', (p: StoryboardPackage) => { p.panels[0]!.candidate_asset_ref_ids = []; }],
    ['PANEL_READINESS', (p: StoryboardPackage) => {
      Object.assign(p.assets[0]!, { status: 'planned', file: null }); p.asset_references[0]!.mode = 'planned';
    }],
    ['ORDER_KEY', (p: StoryboardPackage) => { p.shots[1]!.order_key = p.shots[0]!.order_key; }],
  ] as const)('reports %s', (code, edit) => {
    expect(errorCodes(validatePackage(mutate(makePackage(), edit)))).toContain(code);
  });

  it('does not approve unknown adaptation rights for delivery', () => {
    const p = mutate(makePackage(), p => { p.project.rights_status = 'unknown'; });
    expect(errorCodes(validatePackage(p, { stage: 'delivery' }))).toContain('RIGHTS');
  });

  it('detects missing target coverage instead of vacuous delivery success', () => {
    const p = mutate(makePackage(), p => { p.shots = []; p.panels = []; });
    expect(errorCodes(validatePackage(p, { stage: 'delivery' }))).toContain('BEAT_COVERAGE');
  });

  it.each(['../secret.png', '/etc/a.png', 'C:/a.png', 'https://a/b.png', 'a\\b.png'])('rejects unsafe asset path %s', path => {
    expect(errorCodes(validatePackage(mutate(makePackage(), p => {
      const asset = p.assets[0]!;
      if (asset.status === 'ready') asset.file.path = path;
    })))).toContain('ASSET_PATH');
  });
});

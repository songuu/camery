import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validatePackage } from '../src/index';
import { migrateV03 } from '../src/node/migrate-v03';
import type { MigrationOptions } from '../src/node/migrate-v03';
import { resolveTimeline, toSeconds } from '@camery/timeline';

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../storyboard_platform_v3/examples/${name}_package.json`, import.meta.url), 'utf8'));
const fiction = load('fiction');
const knowledge = load('knowledge');
const camera = { shot_sizes: { '中景': 'medium', '特写': 'close', '近景': 'medium_close', '远景': 'wide', '双人中景': 'medium' }, angles: { '平视': 'eye_level' }, movements: { '固定观察主要动作': 'static' } } as const;
const remove = Symbol('remove');
function changed(path: string, value: unknown, input: unknown = fiction): unknown {
  const clone = structuredClone(input);
  const keys = path.split('.');
  let row: unknown = clone;
  for (const key of keys.slice(0, -1)) row = (row as Record<string, unknown>)[key];
  if (value === remove) delete (row as Record<string, unknown>)[keys.at(-1)!];
  else (row as Record<string, unknown>)[keys.at(-1)!] = value;
  return clone;
}
function splitEpisodes(): unknown {
  let p = changed('episodes.0.timing.duration_seconds', 21);
  p = changed('episodes.1', { id: 'EP-FIC002', title: '第二集', sequence: 2, timing: { start_seconds: 21, duration_seconds: 21, basis: 'estimated' } }, p);
  p = changed('scene_occurrences.1.episode_id', 'EP-FIC002', p);
  p = changed('project.scope.expected_episode_count', 2, p);
  for (const index of [1, 4, 8, 9]) p = changed(`audio_cues.${index}.episode_ids`, ['EP-FIC002'], p);
  p = changed('audio_cues.5.episode_ids', ['EP-FIC001', 'EP-FIC002'], p);
  return p;
}

export function migrationOptions(name: 'fiction' | 'knowledge'): MigrationOptions {
  const original = (name === 'fiction' ? fiction : knowledge) as { assets: Array<{ id: string }> };
  return {
    camera, video_aspect_ratio: '16:9',
    line_kinds: { 'LINE-F03': 'on_screen', 'LINE-F05': 'on_screen' },
    asset_origins: Object.fromEntries(original.assets.map(a => [a.id, 'generated' as const])),
    source_mappings: { 'SRC-KNOW': { kind: 'article', capture_state: 'missing', coverage: 'partial' } },
    beat_kinds: { explanation: 'narration' }, source_relationships: { fact_basis: 'adapted' },
  };
}

describe('explicit v0.3 planning migration', () => {
  it.each(['fiction', 'knowledge'] as const)('migrates the actual %s source fixture without fabricating media or approval', name => {
    const source = load(name);
    const before = JSON.stringify(source);
    const report = migrateV03(source, migrationOptions(name));
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.package).not.toBeNull();
    const pkg = report.package!;
    expect(validatePackage(pkg)).toMatchObject({ valid: true, errors: [] });
    expect(pkg.revision.status).toBe('candidate');
    expect(pkg.shot_takes).toEqual([]);
    expect(pkg.assets.every(a => a.status === 'planned' && a.file === null)).toBe(true);
    expect(pkg.claims.some(c => c.verification === 'verified')).toBe(false);
    expect(pkg.lines.map(l => l.text)).toEqual((source as { dialogue_lines: Array<{ text: string }> }).dialogue_lines.map(l => l.text));
    expect(pkg.beats).toHaveLength((source as { beats: unknown[] }).beats.length);
    expect(report.legacy).toEqual(source);
    expect(JSON.stringify(source)).toBe(before);
    expect(migrateV03(source, migrationOptions(name))).toEqual(report);
    const stored = JSON.parse(readFileSync(new URL(`../examples/${name}.v05.planned.json`, import.meta.url), 'utf8')) as unknown;
    const storedReport = JSON.parse(readFileSync(new URL(`../examples/${name}.v03-migration.report.json`, import.meta.url), 'utf8')) as unknown;
    const storedOptions = JSON.parse(readFileSync(new URL(`../examples/${name}.v03-migration.options.json`, import.meta.url), 'utf8')) as unknown;
    expect(report.package).toEqual(stored);
    expect(JSON.parse(JSON.stringify(report))).toEqual(storedReport);
    expect(migrationOptions(name)).toEqual(storedOptions);
  });

  it('retains knowledge reference uncertainty as a delivery block', () => {
    const report = migrateV03(knowledge, migrationOptions('knowledge'));
    expect(report.package!.sources[0]!.origin_uri).toContain('science.nasa.gov');
    expect(report.package!.sources[0]!.usage_basis).toBe('unknown');
    expect(report.package!.project.rights_status).toBe('unknown');
    expect(report.blocked_actions).toContain('delivery');
    expect(report.issues.some(i => i.code === 'RIGHTS_UNRESOLVED')).toBe(true);
    expect(report.package!.beats.every(b => b.source_refs[0]?.locator.includes('NASA'))).toBe(true);
  });

  it('requires explicit voice, asset-origin, camera and source semantic mappings', () => {
    const missing = migrateV03(fiction, {});
    expect(missing.ok).toBe(false);
    expect(missing.package).toBeNull();
    expect(missing.issues.map(i => i.code)).toEqual(expect.arrayContaining(['VOICE_MAPPING', 'ASSET_ORIGIN', 'CAMERA_MAPPING', 'ASPECT_RATIO']));
    const sourceMissing = migrateV03(knowledge, { ...migrationOptions('knowledge'), source_mappings: {}, beat_kinds: {}, source_relationships: {} });
    expect(sourceMissing.issues.map(i => i.code)).toEqual(expect.arrayContaining(['SOURCE_MAPPING', 'BEAT_MAPPING', 'RELATIONSHIP_MAPPING']));
  });

  it('rejects unknown versions, fields and dangling legacy references', () => {
    const source = fiction as Record<string, unknown>;
    expect(migrateV03({ ...source, schema_version: '0.4.0-draft' }, migrationOptions('fiction')).issues[0]?.code).toBe('LEGACY_SCHEMA');
    expect(migrateV03({ ...source, undocumented: true }, migrationOptions('fiction')).issues[0]?.code).toBe('LEGACY_SCHEMA');
    const bad = structuredClone(fiction) as { shots: Array<{ scene_id: string }> };
    bad.shots[0]!.scene_id = 'SC-MISSING';
    expect(migrateV03(bad, migrationOptions('fiction')).issues.map(i => i.code)).toContain('LEGACY_REFERENCE');
  });

  it('does not retime old shot gaps or silently retain unknown measurement evidence', () => {
    const gap = structuredClone(fiction) as { shots: Array<{ timing: { start_seconds: number; basis: string; measurement_asset_id?: string } }> };
    gap.shots[1]!.timing.start_seconds++;
    expect(migrateV03(gap, migrationOptions('fiction')).issues.map(i => i.code)).toContain('SHOT_TIMING_GAP');
    gap.shots[1]!.timing.start_seconds--;
    gap.shots[0]!.timing.basis = 'measured';
    gap.shots[0]!.timing.measurement_asset_id = 'AS-VOICE-CHAR-LIN';
    expect(migrateV03(gap, migrationOptions('fiction')).issues.map(i => i.code)).toContain('MEASUREMENT_REVIEW');
    expect(migrateV03(changed('shots.5.timing.duration_seconds', 6), migrationOptions('fiction')).issues.map(i => i.code)).toContain('SHOT_TIMING_GAP');
  });

  it('duplicates shared cue IDs into per-rendition identities and leaves no guessed takes', () => {
    const report = migrateV03(fiction, migrationOptions('fiction'));
    expect(report.id_map['CUE-F03']).toHaveLength(2);
    expect(report.package!.audio_cues).toHaveLength(16);
    expect(new Set(report.package!.audio_cues.map(c => c.id)).size).toBe(16);
    expect(report.package!.segments).toHaveLength(3);
    expect(report.decisions.some(d => d.action === 'preserve_legacy_grouping_without_takes')).toBe(true);
  });

  it.each([
    ['shots.0.timing.basis', 'measured'],
    ['assets.0.status', 'ready'],
    ['assets.0.file', { path: 'a', sha256: 'a'.repeat(64), mime_type: 'audio/wav' }],
    ['audio_cues.0.speaker_id', remove], ['audio_cues.0.line_id', remove], ['audio_cues.0.text', remove],
    ['audio_cues.2.sound_intent', remove], ['audio_cues.2.line_id', 'LINE-F03'],
    ['render_segments.0.shot_ids', []], ['render_segments.2.shot_ids', ['SHOT-F01']], ['render_segments.2.audio_cue_ids', []],
    ['render_segments.0.status', 'produced'],
    ['adaptation_decisions.0', { id: 'DEC-01', action: 'replace', affected_beat_ids: ['BEAT-F01'], replacement_beat_ids: [], reason: 'x', status: 'proposed' }],
    ['adaptation_decisions.0', { id: 'DEC-01', action: 'omit', affected_beat_ids: ['BEAT-F01'], replacement_beat_ids: ['BEAT-F02'], reason: 'x', status: 'approved' }],
  ])('enforces legacy conditionals at %s', (path, value) => {
    expect(migrateV03(changed(path, value), migrationOptions('fiction')).issues.map(i => i.code)).toContain('LEGACY_SCHEMA');
  });

  it.each([
    'active_revision_id', 'adopted_revision_id', 'revisions.0.parent_revision_id', 'characters.0.voice_reference_id',
    'scene_occurrences.0.episode_id', 'scene_occurrences.0.location_id', 'dialogue_lines.0.beat_id',
    'dialogue_lines.0.scene_id', 'dialogue_lines.0.speaker_id', 'asset_references.0.asset_id', 'shots.0.scene_id',
    'panels.0.shot_id', 'panels.0.asset_ref_id', 'audio_cues.0.track_id', 'audio_cues.0.scene_id', 'audio_cues.0.line_id',
    'render_segments.0.output_asset_id', 'coverage.0.beat_id', 'coverage.0.decision_id',
  ])('rejects missing legacy reference %s', path => {
    expect(migrateV03(changed(path, 'MISSING-OBJECT'), migrationOptions('fiction')).issues.map(i => i.code)).toContain('LEGACY_REFERENCE');
  });

  it.each([
    'project.source_ids', 'scene_occurrences.0.character_ids', 'beats.0.source_refs.0.source_id',
    'shots.0.beat_refs', 'shots.0.asset_ref_ids', 'audio_cues.0.episode_ids', 'audio_cues.0.beat_refs', 'audio_cues.0.shot_refs',
    'audio_cues.0.asset_ref_ids', 'render_segments.0.shot_ids', 'render_segments.0.audio_cue_ids',
    'render_segments.0.required_asset_ref_ids', 'coverage.0.shot_ids', 'coverage.0.audio_cue_ids',
  ])('checks legacy reference collection %s', path => {
    const value = path.endsWith('.source_id') ? 'MISSING-OBJECT' : ['MISSING-OBJECT'];
    expect(migrateV03(changed(path, value), migrationOptions('fiction')).issues.map(i => i.code)).toContain('LEGACY_REFERENCE');
  });

  it.each([
    ['LEGACY_DUPLICATE_ID', 'project.id', 'PKG-FIC'], ['LEGACY_DUPLICATE_ID', 'characters.1.id', 'CHAR-LIN'],
    ['LEGACY_REVISION', 'revisions.0.parent_revision_id', 'REV-FIC-001'],
    ['LEGACY_OWNERSHIP', 'dialogue_lines.0.scene_id', 'SC-F02'], ['LEGACY_OWNERSHIP', 'scene_occurrences.0.character_ids', ['CHAR-AHE']],
    ['LEGACY_OWNERSHIP', 'shots.0.beat_refs', ['BEAT-F04']], ['LEGACY_AUDIO_SCRIPT', 'audio_cues.0.text', 'changed text'],
    ['LEGACY_TARGET', 'project.targets', ['audio']],
    ['LEGACY_COVERAGE', 'coverage.0.shot_ids', ['SHOT-F02']], ['LEGACY_COVERAGE', 'coverage.0.audio_cue_ids', ['CUE-F05']],
    ['LEGACY_SCOPE', 'project.scope.expected_episode_count', 2], ['LEGACY_SCOPE', 'project.scope.expected_scene_count', 3], ['LEGACY_SCOPE', 'project.scope.expected_required_beat_count', 7],
    ['LEGACY_SEQUENCE', 'shots.1.sequence', 1], ['LEGACY_TIMING', 'shots.0.timing.duration_seconds', 50],
    ['LEGACY_TIMING', 'audio_cues.0.timing.start_seconds', 40],
    ['UNASSIGNED_CUE', 'render_segments.2.audio_cue_ids', ['CUE-F03']],
    ['UNSUPPORTED_ASSET', 'assets.0.media_type', 'document'], ['UNSUPPORTED_REFERENCE', 'asset_references.0.purpose', 'generic'],
    ['REFERENCE_EXCLUSION', 'asset_references.0.must_not_control', ''],
    ['LEGACY_PANEL_TIME', 'panels.0.offset_seconds', 1], ['LEGACY_PANEL_TIME', 'panels.6.offset_seconds', 2],
  ])('reports %s for %s', (code, path, value) => {
    expect(migrateV03(changed(path, value), migrationOptions('fiction')).issues.map(i => i.code)).toContain(code);
  });

  it('does not let source-category mapping invent snapshots or full coverage', () => {
    for (const mapping of [
      { kind: 'article', capture_state: 'provided', coverage: 'partial' },
      { kind: 'article', capture_state: 'missing', coverage: 'full_selected_content' },
    ] as const) expect(migrateV03(knowledge, { ...migrationOptions('knowledge'), source_mappings: { 'SRC-KNOW': mapping } }).issues.map(i => i.code)).toContain('SOURCE_EVIDENCE');
  });

  it('supports explicit reference exclusions and missing-asset declarations', () => {
    const p = changed('assets.0.status', 'missing', changed('asset_references.0.must_not_control', ''));
    const report = migrateV03(p, { ...migrationOptions('fiction'), reference_exclusions: { 'AR-VOICE-CHAR-LIN': 'Only voice identity, never story text.' } });
    expect(report.ok).toBe(true);
    expect(report.package!.assets[0]!.status).toBe('missing');
  });

  it('resets ready assets and adopted panels only after explicit consent', () => {
    let p = changed('assets.1.status', 'ready');
    p = changed('assets.1.file', { path: 'a.png', sha256: 'a'.repeat(64), mime_type: 'image/png' }, p);
    p = changed('asset_references.1.mode', 'actual', p);
    p = changed('panels.0.status', 'ready', p);
    p = changed('panels.0.asset_ref_id', 'AR-IMAGE-CHAR-LIN', p);
    expect(migrateV03(p, migrationOptions('fiction')).issues.map(i => i.code)).toContain('READINESS_REVIEW');
    const report = migrateV03(p, { ...migrationOptions('fiction'), reset_readiness: true });
    expect(report.ok).toBe(true);
    expect(report.package!.panels[0]!.adopted_asset_ref_id).toBeNull();
    expect(report.package!.assets[1]!.file).toBeNull();
  });

  it('converts actual two-episode absolute positions and splits global beds without losing duration', () => {
    const report = migrateV03(splitEpisodes(), migrationOptions('fiction'));
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    expect(report.id_map['CUE-MUSIC']).toHaveLength(4);
    const second = report.package!.episodes[1]!.id;
    const cues = report.package!.audio_cues.filter(c => c.episode_id === second);
    expect(cues.every(c => c.anchor.offset >= 0 && c.anchor.offset <= 21)).toBe(true);
    expect(cues.some(c => c.kind === 'dialogue' && c.anchor.offset === 7)).toBe(true);
  });

  it('rejects temporal loss, cross-episode speech/fades and overlapping source episodes', () => {
    const p = splitEpisodes();
    expect(migrateV03(changed('audio_cues.0.timing.duration_seconds', 10, p), migrationOptions('fiction')).issues.map(i => i.code)).toContain('LEGACY_TIMING');
    let speech = changed('audio_cues.0.episode_ids', ['EP-FIC001', 'EP-FIC002'], p);
    speech = changed('audio_cues.0.timing.duration_seconds', 10, speech);
    expect(migrateV03(speech, migrationOptions('fiction')).issues.map(i => i.code)).toContain('CROSS_EPISODE_REVIEW');
    expect(migrateV03(changed('audio_cues.5.mix.fade_in_seconds', 1, p), migrationOptions('fiction')).issues.map(i => i.code)).toContain('CROSS_EPISODE_REVIEW');
    expect(migrateV03(changed('audio_cues.5.mix.fade_out_seconds', 1, p), migrationOptions('fiction')).issues.map(i => i.code)).toContain('CROSS_EPISODE_REVIEW');
    expect(migrateV03(changed('episodes.1.timing.start_seconds', 20, p), migrationOptions('fiction')).issues.map(i => i.code)).toContain('LEGACY_TIMING');
  });

  it('converts intermediate panels and retains declared adaptation decisions', () => {
    let p = changed('panels.0.position', 'key');
    p = changed('panels.0.offset_seconds', 3, p);
    p = changed('adaptation_decisions.0', { id: 'DEC-01', action: 'replace', affected_beat_ids: ['BEAT-F01'], replacement_beat_ids: ['BEAT-F02'], reason: 'merge narrative', status: 'proposed' }, p);
    p = changed('adaptation_decisions.1', { id: 'DEC-02', action: 'omit', affected_beat_ids: ['BEAT-F04'], replacement_beat_ids: [], reason: 'explicit prior editorial declaration', status: 'approved' }, p);
    const report = migrateV03(p, migrationOptions('fiction'));
    expect(report.ok).toBe(true);
    expect(report.package!.panels[0]).toMatchObject({ position: 'intermediate', offset_ratio: 0.5 });
    expect(report.package!.adaptation_decisions.map(d => d.status)).toEqual(['candidate', 'approved']);
    expect(migrateV03(changed('panels.0.offset_seconds', 0, p), migrationOptions('fiction')).issues.map(i => i.code)).toContain('LEGACY_PANEL_TIME');
  });

  it('still validates the resulting current contract and timing', () => {
    const invalidOption = { ...migrationOptions('fiction'), video_aspect_ratio: 'wrong' } as unknown as MigrationOptions;
    expect(migrateV03(fiction, invalidOption).issues.map(i => i.code)).toContain('OUTPUT_SCHEMA');
    expect(migrateV03(changed('audio_cues.0.timing.duration_seconds', 15), migrationOptions('fiction')).issues.map(i => i.code)).toContain('TRACK_OVERLAP');
    expect(migrateV03(changed('sources.0.usage_basis', 'authorized'), migrationOptions('fiction')).package!.project.rights_status).toBe('authorized');
  });

  it('returns JSON-safe failure reports for non-package inputs', () => {
    for (const bad of [null, 'bad', undefined, () => false]) {
      const report = migrateV03(bad);
      expect(report.ok).toBe(false);
      expect(report.legacy).toBeNull();
      expect(() => JSON.stringify(report)).not.toThrow();
    }
  });

  it('does not drop the old audio episode tail when no cue declares its silence', () => {
    const source = fiction as { render_segments: Array<{ audio_cue_ids: string[] }> };
    const cues = source.render_segments[2]!.audio_cue_ids.filter(id => id !== 'CUE-MUSIC' && id !== 'CUE-WIND');
    const report = migrateV03(changed('render_segments.2.audio_cue_ids', cues), migrationOptions('fiction'));
    expect(report.ok).toBe(false);
    expect(report.package).toBeNull();
    expect(report.issues.map(i => i.code)).toContain('EPISODE_TIMING_MISMATCH');
  });

  it('rejects scene order that would silently move otherwise unchanged shots', () => {
    const source = changed('scene_occurrences.1.sequence', 1, changed('scene_occurrences.0.sequence', 2));
    const report = migrateV03(source, migrationOptions('fiction'));
    expect(report.ok).toBe(false);
    expect(report.issues.map(i => i.code)).toContain('SHOT_TIMING_MISMATCH');
  });

  it('computes decimal endpoints exactly before finding intersections', () => {
    const source = changed('audio_cues.2.timing.duration_seconds', 0.1, changed('audio_cues.2.timing.start_seconds', 0.2));
    const report = migrateV03(source, migrationOptions('fiction'));
    expect(report.ok, JSON.stringify(report.issues)).toBe(true);
    const ids = report.id_map['CUE-PAPER']!;
    const copies = resolveTimeline(report.package!).timelines.flatMap(t => ids.flatMap(id => t.spans.has(id) ? [t.spans.get(id)!] : []));
    expect(copies).toHaveLength(2);
    expect(copies.every(span => toSeconds(span.start) === 0.2 && toSeconds(span.end) === 0.3)).toBe(true);
  });

  it('rejects relative offsets that cannot be represented without changing cue timing', () => {
    let source = changed('episodes.0.timing.start_seconds', 1e-30, knowledge);
    source = changed('project.target_duration_seconds', 61, source);
    source = changed('audio_cues.0.timing.start_seconds', 1e-30, source);
    const report = migrateV03(source, migrationOptions('knowledge'));
    expect(report.ok).toBe(false);
    expect(report.issues.map(i => i.code)).toContain('CUE_TIMING_MISMATCH');
  });
});

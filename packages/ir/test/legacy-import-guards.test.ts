import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { migrateV03 } from '../src/node/migrate-v03';
import type { MigrationOptions } from '../src/node/migrate-v03';
const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../storyboard_platform_v3/examples/${name}_package.json`, import.meta.url), 'utf8'));
const fiction = load('fiction');
const options = JSON.parse(readFileSync(new URL('../examples/fiction.v03-migration.options.json', import.meta.url), 'utf8')) as MigrationOptions;
function field(source: unknown, path: string): unknown {
  return path.split('.').reduce((value, key) => (value as Record<string, unknown>)[key], source);
}
function edited(changes: Array<[string, unknown]>): unknown {
  const result = structuredClone(fiction);
  for (const [path, value] of changes) {
    const keys = path.split('.'); const parent = keys.slice(0, -1).reduce((value, key) => (value as Record<string, unknown>)[key], result);
    (parent as Record<string, unknown>)[keys.at(-1)!] = structuredClone(value);
  }
  return result;
}
const bad: Array<[string, Array<[string, unknown]>]> = [
  ['LEGACY_ADOPTION', [['adopted_revision_id', field(fiction, 'active_revision_id')]]],
  ['LEGACY_ADOPTION', [['revisions.0.status', 'adopted']]],
  ['LEGACY_AUDIO_SHOT', [['audio_cues.0.shot_refs', ['SHOT-F06']]]],
  ['LEGACY_ASSET_READINESS', [['asset_references.0.mode', 'actual']]],
  ['LEGACY_ASSET_READINESS', [['assets.0.status', 'ready'], ['assets.0.file', { path: 'declared/a.wav', sha256: 'a'.repeat(64), mime_type: 'audio/wav' }]]],
  ['LEGACY_PANEL_READINESS', [['panels.0.status', 'ready']]],
  ['LEGACY_OWNERSHIP', [['audio_cues.2.scene_id', 'SC-F02']]],
  ['LEGACY_OWNERSHIP', [['audio_cues.2.beat_refs', ['BEAT-F04']]]],
  ['LEGACY_SEGMENT_ORDER', [['render_segments.0.shot_ids', ['SHOT-F03', 'SHOT-F02', 'SHOT-F01']]]],
  ['LEGACY_SEGMENT_ORDER', [['render_segments.0.shot_ids', ['SHOT-F01', 'SHOT-F03']]]],
  ['LEGACY_SEGMENT_TIMING', [['render_segments.0.timing.duration_seconds', 0.5]]],
  ['LEGACY_SEGMENT_TIMING', [['render_segments.0.timing.start_seconds', 16], ['render_segments.0.timing.duration_seconds', 5]]],
  ['LEGACY_SEGMENT_READINESS', [['render_segments.0.status', 'ready']]],
  ['LEGACY_SEGMENT_OUTPUT', [['render_segments.0.status', 'produced'], ['render_segments.0.output_asset_id', 'AS-VOICE-CHAR-LIN']]],
  ['LEGACY_SHOT_DELIVERY', [['render_segments.1.shot_ids', ['SHOT-F03', 'SHOT-F04', 'SHOT-F05', 'SHOT-F06']]]],
  ['LEGACY_SHOT_DELIVERY', [['render_segments.0.shot_ids', ['SHOT-F02', 'SHOT-F03']]]],
  ['LEGACY_SHOT_DELIVERY', [['render_segments', (field(fiction, 'render_segments') as Array<{ media_type: string }>).filter(s => s.media_type === 'audio')]]],
  ['LEGACY_TARGET_EMPTY', [['render_segments', (field(fiction, 'render_segments') as Array<{ media_type: string }>).filter(s => s.media_type === 'video')]]],
  ['LEGACY_COVERAGE', [['coverage.6', field(fiction, 'coverage.0')]]],
  ['LEGACY_COVERAGE', [['coverage', []]]],
  ['LEGACY_COVERAGE', [['coverage.0.shot_ids', []]]],
  ['LEGACY_COVERAGE', [['coverage.0.audio_cue_ids', []]]],
  ['LEGACY_COVERAGE', [['adaptation_decisions', [{ id: 'DEC-01', action: 'omit', affected_beat_ids: ['BEAT-F02'], replacement_beat_ids: [], reason: 'not this beat', status: 'approved' }]], ['coverage.0.decision_id', 'DEC-01']]],
  ['LEGACY_DECISION_CYCLE', [['adaptation_decisions', [{ id: 'DEC-01', action: 'replace', affected_beat_ids: ['BEAT-F01'], replacement_beat_ids: ['BEAT-F01'], reason: 'invalid self replacement', status: 'approved' }]]]],
  ['LEGACY_EXPORT_READINESS', [['export.status', 'render_ready']]],
  ['LEGACY_EXPORT_READINESS', [['export.status', 'exported'], ['revisions.0.status', 'adopted'], ['adopted_revision_id', field(fiction, 'active_revision_id')]]],
  ['LEGACY_EXPORT_LOSS', [['export.status', 'render_ready'], ['export.unsupported_features', ['unresolved']]]],
];
it.each(bad)('rejects invalid old declarations before dropping them: %s %#', (code, changes) => {
  const source = edited(changes); const before = JSON.stringify(source);
  const report = migrateV03(source, options);
  expect(report.issues.map(issue => issue.code)).toContain(code);
  expect(report.ok).toBe(false); expect(report.package).toBeNull();
  expect(JSON.stringify(source)).toBe(before);
});
it('allows consistent adopted metadata only as an explicitly downgraded planning candidate', () => {
  const assets = field(fiction, 'assets') as Array<{ id: string; media_type: string }>;
  const refs = field(fiction, 'asset_references') as unknown[];
  const changes: Array<[string, unknown]> = [['revisions.0.status', 'adopted'], ['adopted_revision_id', field(fiction, 'active_revision_id')], ['export.status', 'render_ready']];
  assets.forEach((asset, i) => { changes.push([`assets.${i}.status`, 'ready'], [`assets.${i}.file`, { path: `declared/${asset.id}`, sha256: 'a'.repeat(64), mime_type: asset.media_type === 'audio' ? 'audio/wav' : 'image/png' }]); });
  refs.forEach((_ref, i) => changes.push([`asset_references.${i}.mode`, 'actual']));
  const report = migrateV03(edited(changes), { ...options, reset_readiness: true });
  expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  expect(report.package!.revision.status).toBe('candidate'); expect(report.blocked_actions).toEqual(['delivery', 'publish']);
  expect(report.package!.assets.every(asset => asset.status === 'planned' && asset.file === null)).toBe(true);
});
function withoutFirstBeatDelivery(action: 'omit' | 'replace'): unknown {
  const cueId = 'CUE-FN01';
  const lines = field(fiction, 'dialogue_lines') as Array<{ id: string }>;
  const cues = field(fiction, 'audio_cues') as Array<{ id: string; line_id?: string }>;
  const lineId = cues.find(cue => cue.id === cueId)!.line_id;
  const segments = structuredClone(field(fiction, 'render_segments')) as Array<{ audio_cue_ids: string[] }>;
  segments.forEach(segment => { segment.audio_cue_ids = segment.audio_cue_ids.filter(id => id !== cueId); });
  return edited([
    ['shots.0.beat_refs', []], ['audio_cues', cues.filter(cue => cue.id !== cueId)], ['dialogue_lines', lines.filter(line => line.id !== lineId)],
    ['render_segments', segments], ['coverage.0.shot_ids', []], ['coverage.0.audio_cue_ids', []], ['coverage.0.decision_id', 'DEC-01'],
    ['adaptation_decisions', [{ id: 'DEC-01', action, affected_beat_ids: ['BEAT-F01'], replacement_beat_ids: action === 'replace' ? ['BEAT-F02'] : [], reason: 'explicit existing editorial choice', status: 'approved' }]],
  ]);
}
it.each(['omit', 'replace'] as const)('preserves approved legacy %s coverage without inventing media', action => {
  const report = migrateV03(withoutFirstBeatDelivery(action), options);
  expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  expect(report.package!.adaptation_decisions[0]!.action).toBe(action);
  expect(report.package!.shot_takes).toEqual([]);
});
it('rejects cyclic approved coverage with no delivered replacement', () => {
  const source = withoutFirstBeatDelivery('replace') as Record<string, unknown>;
  const shots = source['shots'] as Array<{ beat_refs: string[] }>; shots[1]!.beat_refs = [];
  const cues = source['audio_cues'] as Array<{ id: string; line_id?: string }>;
  const secondLine = cues.find(cue => cue.id === 'CUE-FN02')!.line_id;
  source['audio_cues'] = cues.filter(cue => cue.id !== 'CUE-FN02');
  source['dialogue_lines'] = (source['dialogue_lines'] as Array<{ id: string }>).filter(line => line.id !== secondLine);
  (source['render_segments'] as Array<{ audio_cue_ids: string[] }>).forEach(segment => { segment.audio_cue_ids = segment.audio_cue_ids.filter(id => id !== 'CUE-FN02'); });
  const coverage = source['coverage'] as Array<{ shot_ids: string[]; audio_cue_ids: string[]; decision_id: string | null }>;
  Object.assign(coverage[1]!, { shot_ids: [], audio_cue_ids: [], decision_id: 'DEC-02' });
  (source['adaptation_decisions'] as unknown[]).push({ id: 'DEC-02', action: 'replace', affected_beat_ids: ['BEAT-F02'], replacement_beat_ids: ['BEAT-F01'], reason: 'uncovered cycle', status: 'approved' });
  const report = migrateV03(source, options);
  expect(report.ok).toBe(false); expect(report.package).toBeNull();
  expect(report.issues.some(issue => issue.code === 'LEGACY_COVERAGE')).toBe(true);
});
it('checks produced modality as declaration only before an explicit planning reset', () => {
  const assets = field(fiction, 'assets') as Array<{ id: string; media_type: string }>;
  const refs = field(fiction, 'asset_references') as unknown[];
  const changes: Array<[string, unknown]> = [['render_segments.0.status', 'produced'], ['render_segments.0.output_asset_id', 'AS-VIDEO-OUTPUT']];
  assets.forEach((asset, i) => changes.push([`assets.${i}.status`, 'ready'], [`assets.${i}.file`, { path: `declared/${asset.id}`, sha256: 'a'.repeat(64), mime_type: asset.media_type === 'audio' ? 'audio/wav' : 'image/png' }]));
  refs.forEach((_ref, i) => changes.push([`asset_references.${i}.mode`, 'actual']));
  changes.push([`assets.${assets.length}`, { id: 'AS-VIDEO-OUTPUT', media_type: 'video', description: 'declared historical output', status: 'ready', file: { path: 'declared/output.mp4', sha256: 'b'.repeat(64), mime_type: 'video/mp4' } }]);
  const report = migrateV03(edited(changes), { ...options, reset_readiness: true, asset_origins: { ...options.asset_origins, 'AS-VIDEO-OUTPUT': 'generated' } });
  expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  expect(report.package!.assets.every(asset => asset.status === 'planned')).toBe(true); expect(report.blocked_actions).toEqual(['delivery', 'publish']);
});
it('does not normalize an invalid scene-free old episode into a valid audio planning episode', () => {
  const cues = structuredClone(field(fiction, 'audio_cues')) as Array<{ id: string; shot_refs: string[]; episode_ids: string[] }>;
  cues.forEach(cue => { cue.shot_refs = []; if (cue.id === 'CUE-MUSIC' || cue.id === 'CUE-WIND') cue.episode_ids = ['EP-FIC001', 'EP-EMPTY']; });
  const coverage = structuredClone(field(fiction, 'coverage')) as Array<{ shot_ids: string[] }>;
  coverage.forEach(row => { row.shot_ids = []; });
  const report = migrateV03(edited([
    ['project.targets', ['audio']], ['project.scope.expected_episode_count', 2], ['episodes.0.timing.duration_seconds', 41],
    ['episodes.1', { id: 'EP-EMPTY', sequence: 2, title: 'empty old episode', timing: { start_seconds: 41, duration_seconds: 1, basis: 'estimated' } }],
    ['shots', []], ['panels', []], ['audio_cues', cues], ['coverage', coverage],
    ['render_segments', (field(fiction, 'render_segments') as Array<{ media_type: string }>).filter(segment => segment.media_type === 'audio')],
  ]), options);
  expect(report.issues.map(issue => issue.code)).toContain('LEGACY_EPISODE_EMPTY');
  expect(report.ok).toBe(false); expect(report.package).toBeNull();
});

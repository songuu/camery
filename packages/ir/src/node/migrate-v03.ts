import { createHash } from 'node:crypto';
import { z } from 'zod';
import { add, compare, resolveTimeline, seconds, subtract, toSeconds } from '@camery/timeline';
import type { Rational } from '@camery/timeline';
import { StoryboardPackage } from '../legacy/v05-schema';
import type { DialogueLine, Shot } from '../legacy/v05-schema';
import { validatePackage } from '../legacy/v05-validate';

const oldId = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{1,95}$/);
const text = z.string().min(1);
const nonnegative = z.number().nonnegative();
const positive = z.number().positive();
const ids = z.array(oldId).refine(rows => new Set(rows).size === rows.length, 'Duplicate reference in legacy array');
const sequence = z.int().positive();
const timing = z.strictObject({ start_seconds: nonnegative, duration_seconds: positive, basis: z.enum(['estimated', 'measured']), measurement_asset_id: oldId.optional() })
  .superRefine((row, ctx) => { if (row.basis === 'measured' && row.measurement_asset_id === undefined) ctx.addIssue({ code: 'custom', message: 'Measured legacy timing needs an evidence asset' }); });
const sourceRef = z.strictObject({ source_id: oldId, locator: text, relationship: z.enum(['original', 'adapted', 'fact_basis', 'quoted', 'paraphrased']) });
const legacyAsset = z.strictObject({
  id: oldId, media_type: z.enum(['image', 'audio', 'video', 'document']), status: z.enum(['planned', 'ready', 'missing']), description: text,
  file: z.strictObject({ path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/), mime_type: text }).optional(),
}).superRefine((row, ctx) => { if ((row.status === 'ready') !== (row.file !== undefined)) ctx.addIssue({ code: 'custom', message: 'Legacy asset file and readiness disagree' }); });
const legacyCue = z.strictObject({
  id: oldId, scene_id: oldId.nullable(), episode_ids: ids.min(1), kind: z.enum(['dialogue', 'narration', 'sfx', 'ambience', 'music']),
  track_id: oldId, beat_refs: ids, shot_refs: ids, asset_ref_ids: ids, timing,
  speaker_id: oldId.optional(), line_id: oldId.optional(), text: text.optional(), sound_intent: text.optional(),
  mix: z.strictObject({ gain_db: z.number(), fade_in_seconds: nonnegative, fade_out_seconds: nonnegative }),
}).superRefine((row, ctx) => {
  const spoken = row.kind === 'dialogue' || row.kind === 'narration';
  if (spoken ? row.speaker_id === undefined || row.line_id === undefined || row.text === undefined
    : row.sound_intent === undefined || row.speaker_id !== undefined || row.line_id !== undefined || row.text !== undefined)
    ctx.addIssue({ code: 'custom', message: 'Legacy cue does not satisfy its spoken/nonspoken contract' });
});
const legacySegment = z.strictObject({
  id: oldId, media_type: z.enum(['video', 'audio']), shot_ids: ids, audio_cue_ids: ids, required_asset_ref_ids: ids,
  timing, status: z.enum(['planned', 'ready', 'produced']), target_profile: text, output_asset_id: oldId.nullable(),
}).superRefine((row, ctx) => {
  if (row.media_type === 'video' ? !row.shot_ids.length : !!row.shot_ids.length || !row.audio_cue_ids.length)
    ctx.addIssue({ code: 'custom', message: 'Legacy segment modality and membership disagree' });
  if (row.status === 'produced' && row.output_asset_id === null) ctx.addIssue({ code: 'custom', message: 'Produced segment needs output asset' });
});
const legacyDecision = z.strictObject({
  id: oldId, action: z.enum(['omit', 'replace']), affected_beat_ids: ids.min(1), replacement_beat_ids: ids,
  reason: text, status: z.enum(['proposed', 'approved']),
}).superRefine((row, ctx) => {
  if (row.action === 'replace' ? !row.replacement_beat_ids.length : !!row.replacement_beat_ids.length)
    ctx.addIssue({ code: 'custom', message: 'Legacy replacement membership is invalid' });
});
/** Explicit supported v0.3 envelope, including conditionals; unknown fields are never stripped. */
const LegacyPackage = z.strictObject({
  schema_version: z.literal('0.3.0-draft'), package_id: oldId,
  project: z.strictObject({
    id: oldId, title: text, mode: z.enum(['studio', 'personal']), content_kind: z.enum(['fiction', 'knowledge']),
    targets: z.array(z.enum(['video', 'audio'])).min(1).refine(rows => new Set(rows).size === rows.length),
    target_duration_seconds: positive, source_ids: ids.min(1),
    scope: z.strictObject({ label: text, expected_episode_count: sequence, expected_scene_count: sequence, expected_required_beat_count: sequence }),
  }),
  active_revision_id: oldId, adopted_revision_id: oldId.nullable(),
  revisions: z.array(z.strictObject({ id: oldId, number: sequence, parent_revision_id: oldId.nullable(), status: z.enum(['draft', 'reviewed', 'adopted']), note: z.string() })).min(1),
  sources: z.array(z.strictObject({
    id: oldId, kind: z.enum(['original', 'novel', 'book', 'note', 'web']), title: text, origin_uri: z.string().nullable(),
    capture_state: z.enum(['provided', 'captured', 'reference_only']), coverage: z.enum(['full_selected_content', 'partial', 'metadata_only', 'reference_only']),
    usage_basis: z.enum(['original', 'authorized', 'public_reference', 'undetermined']), selected_content: z.string().optional(), note: z.string(),
  })),
  locations: z.array(z.strictObject({ id: oldId, name: text, description: text })),
  characters: z.array(z.strictObject({ id: oldId, name: text, role: text, voice_reference_id: oldId.nullable() })),
  episodes: z.array(z.strictObject({ id: oldId, title: text, sequence, timing })),
  scene_occurrences: z.array(z.strictObject({ id: oldId, episode_id: oldId, sequence, title: text, location_id: oldId.nullable(), character_ids: ids, script_text: text, start_state: text, end_state: text })),
  beats: z.array(z.strictObject({ id: oldId, scene_id: oldId, sequence, kind: z.enum(['action', 'dialogue', 'explanation', 'transition']), required: z.boolean(), summary: text, source_refs: z.array(sourceRef).min(1) })),
  dialogue_lines: z.array(z.strictObject({ id: oldId, scene_id: oldId, beat_id: oldId, speaker_id: oldId, kind: z.enum(['dialogue', 'narration']), text, delivery: text })),
  assets: z.array(legacyAsset),
  asset_references: z.array(z.strictObject({ id: oldId, mode: z.enum(['planned', 'actual']), asset_id: oldId, purpose: z.enum(['identity', 'location', 'prop', 'style', 'voice', 'keyframe', 'generic']), controls: text, must_not_control: z.string() })),
  shots: z.array(z.strictObject({
    id: oldId, scene_id: oldId, sequence, beat_refs: ids, visual_purpose: text, start_state: text, action: text, end_state: text,
    camera: z.strictObject({ shot_size: text, angle: text, movement: text, lens_mm: positive.nullable().optional() }), asset_ref_ids: ids, timing,
  })),
  panels: z.array(z.strictObject({ id: oldId, shot_id: oldId, position: z.enum(['start', 'key', 'end']), offset_seconds: nonnegative, description: text, status: z.enum(['planned', 'ready']), asset_ref_id: oldId.nullable() })),
  audio_tracks: z.array(z.strictObject({ id: oldId, role: z.enum(['dialogue', 'narration', 'sfx', 'ambience', 'music']), allow_overlap: z.boolean() })),
  audio_cues: z.array(legacyCue), render_segments: z.array(legacySegment), adaptation_decisions: z.array(legacyDecision),
  coverage: z.array(z.strictObject({ beat_id: oldId, shot_ids: ids, audio_cue_ids: ids, decision_id: oldId.nullable() })),
  export: z.strictObject({ status: z.enum(['planned', 'validated', 'render_ready', 'exported']), format: z.literal('storyboard-package'), target_adapter: text, unsupported_features: z.array(text), notes: z.array(text) }),
});
type Legacy = z.infer<typeof LegacyPackage>;
interface Interval { start: Rational; end: Rational }
function interval(value: z.infer<typeof timing>): Interval {
  const start = seconds(value.start_seconds);
  return { start, end: add(start, seconds(value.duration_seconds)) };
}
function intersect(left: Interval, right: Interval): Interval {
  return {
    start: compare(left.start, right.start) >= 0 ? left.start : right.start,
    end: compare(left.end, right.end) <= 0 ? left.end : right.end,
  };
}
type Source = StoryboardPackage['sources'][number];
type Relationship = StoryboardPackage['beats'][number]['source_refs'][number]['relationship'];
type AspectRatio = Extract<StoryboardPackage['renditions'][number], { kind: 'video' }>['aspect_ratio'];

export interface MigrationOptions {
  video_aspect_ratio?: AspectRatio;
  line_kinds?: Readonly<Record<string, DialogueLine['kind']>>;
  asset_origins?: Readonly<Record<string, StoryboardPackage['assets'][number]['origin']>>;
  source_mappings?: Readonly<Record<string, Pick<Source, 'kind' | 'capture_state' | 'coverage'>>>;
  beat_kinds?: Readonly<Record<string, StoryboardPackage['beats'][number]['kind']>>;
  source_relationships?: Readonly<Record<string, Relationship>>;
  camera?: {
    shot_sizes: Readonly<Record<string, Shot['camera']['shot_size']>>;
    angles: Readonly<Record<string, Shot['camera']['angle']>>;
    movements: Readonly<Record<string, Shot['camera']['movement']>>;
  };
  reference_exclusions?: Readonly<Record<string, string>>;
  reset_readiness?: true;
}
export interface MigrationIssue { code: string; where: string; message: string; severity: 'error' | 'warning' }
export interface MigrationDecision { where: string; action: string; before: unknown; after: unknown }
export interface MigrationResult {
  ok: boolean; package: StoryboardPackage | null; issues: MigrationIssue[]; decisions: MigrationDecision[];
  id_map: Record<string, string[]>; blocked_actions: Array<'delivery' | 'publish'>; legacy: unknown;
}

/** Node-only, deterministic planning import. It does not adopt content, verify rights, or read media. */
export function migrateV03(input: unknown, options: MigrationOptions = {}): MigrationResult {
  const issues: MigrationIssue[] = [];
  const decisions: MigrationDecision[] = [];
  const mappings = new Map<string, string[]>();
  let legacy: unknown = null;
  const blocked = new Set<'delivery' | 'publish'>(['delivery', 'publish']);
  const issue = (code: string, where: string, message: string, severity: MigrationIssue['severity'] = 'error') => { issues.push({ code, where, message, severity }); };
  const decision = (where: string, action: string, before: unknown, after: unknown) => { decisions.push({ where, action, before, after }); };
  const finish = (pkg: StoryboardPackage | null): MigrationResult => ({ ok: pkg !== null && !issues.some(i => i.severity === 'error'), package: pkg, issues, decisions, id_map: Object.fromEntries(mappings), blocked_actions: [...blocked], legacy });
  const parsed = LegacyPackage.safeParse(input);
  if (!parsed.success) {
    parsed.error.issues.forEach(e => issue('LEGACY_SCHEMA', '/' + e.path.join('/'), e.message));
    return finish(null);
  }
  const old = parsed.data;
  legacy = structuredClone(old);
  const sceneById = new Map(old.scene_occurrences.map(s => [s.id, s]));
  const lineById = new Map(old.dialogue_lines.map(l => [l.id, l]));
  const beatById = new Map(old.beats.map(b => [b.id, b]));
  const idsSeen = new Set([old.package_id, old.project.id]);
  if (old.package_id === old.project.id) issue('LEGACY_DUPLICATE_ID', '/project/id', 'Package and project IDs must differ');
  for (const [name, rows] of Object.entries(old)) if (Array.isArray(rows)) rows.forEach((row: { id?: string }, index) => {
    if (row.id === undefined) return;
    if (idsSeen.has(row.id)) issue('LEGACY_DUPLICATE_ID', `/${name}/${index}/id`, 'Legacy object ID is ambiguous');
    idsSeen.add(row.id);
  });
  function need<T extends { id: string }>(rows: readonly T[], id: string | null, where: string): T | undefined {
    if (id === null) return undefined;
    const row = rows.find(r => r.id === id);
    if (row === undefined) issue('LEGACY_REFERENCE', where, `Legacy reference ${id} does not exist in its expected collection`);
    return row;
  }
  const active = need(old.revisions, old.active_revision_id, '/active_revision_id');
  const adopted = need(old.revisions, old.adopted_revision_id, '/adopted_revision_id');
  if (adopted && adopted.status !== 'adopted') issue('LEGACY_ADOPTION', '/adopted_revision_id', 'Adopted pointer must identify an adopted revision');
  if (active?.status === 'adopted' && old.adopted_revision_id !== active.id) issue('LEGACY_ADOPTION', '/active_revision_id', 'Adopted active revision must match the adopted pointer');
  old.revisions.forEach((r, i) => {
    const parent = need(old.revisions, r.parent_revision_id, `/revisions/${i}/parent_revision_id`);
    if (parent && parent.number >= r.number) issue('LEGACY_REVISION', `/revisions/${i}`, 'Revision ancestry must increase strictly');
  });
  old.project.source_ids.forEach(id => need(old.sources, id, '/project/source_ids'));
  old.characters.forEach(c => need(old.asset_references, c.voice_reference_id, `/characters/${c.id}/voice_reference_id`));
  old.scene_occurrences.forEach(s => {
    need(old.episodes, s.episode_id, `/scene_occurrences/${s.id}/episode_id`); need(old.locations, s.location_id, `/scene_occurrences/${s.id}/location_id`);
    s.character_ids.forEach(id => need(old.characters, id, `/scene_occurrences/${s.id}/character_ids`));
  });
  old.episodes.forEach((episode, index) => {
    if (!old.scene_occurrences.some(scene => scene.episode_id === episode.id)) issue('LEGACY_EPISODE_EMPTY', `/episodes/${index}`, 'Legacy episode must contain a scene occurrence');
  });
  old.beats.forEach(b => {
    need(old.scene_occurrences, b.scene_id, `/beats/${b.id}/scene_id`);
    b.source_refs.forEach(r => { need(old.sources, r.source_id, `/beats/${b.id}/source_refs`); if (!old.project.source_ids.includes(r.source_id)) issue('LEGACY_REFERENCE', `/beats/${b.id}/source_refs`, 'Source is outside declared project scope'); });
  });
  old.dialogue_lines.forEach(l => {
    const b = need(old.beats, l.beat_id, `/dialogue_lines/${l.id}/beat_id`);
    const s = need(old.scene_occurrences, l.scene_id, `/dialogue_lines/${l.id}/scene_id`);
    need(old.characters, l.speaker_id, `/dialogue_lines/${l.id}/speaker_id`);
    if (b && b.scene_id !== l.scene_id || s && !s.character_ids.includes(l.speaker_id)) issue('LEGACY_OWNERSHIP', `/dialogue_lines/${l.id}`, 'Legacy line scene/speaker does not match canonical content');
  });
  old.asset_references.forEach(r => {
    const asset = need(old.assets, r.asset_id, `/asset_references/${r.id}/asset_id`);
    if (asset && (r.mode === 'actual') !== (asset.status === 'ready')) issue('LEGACY_ASSET_READINESS', `/asset_references/${r.id}`, 'Legacy reference mode must agree with declared material readiness');
  });
  old.shots.forEach(s => {
    need(old.scene_occurrences, s.scene_id, `/shots/${s.id}/scene_id`);
    s.beat_refs.forEach(id => { const b = need(old.beats, id, `/shots/${s.id}/beat_refs`); if (b && b.scene_id !== s.scene_id) issue('LEGACY_OWNERSHIP', `/shots/${s.id}`, 'Shot beat belongs to another scene'); });
    s.asset_ref_ids.forEach(id => need(old.asset_references, id, `/shots/${s.id}/asset_ref_ids`));
  });
  old.panels.forEach(p => {
    need(old.shots, p.shot_id, `/panels/${p.id}/shot_id`); const ref = need(old.asset_references, p.asset_ref_id, `/panels/${p.id}/asset_ref_id`);
    if (p.status === 'ready' && (!ref || ref.mode !== 'actual')) issue('LEGACY_PANEL_READINESS', `/panels/${p.id}`, 'Ready legacy panel must declare an actual image reference');
  });
  old.audio_cues.forEach(c => {
    need(old.audio_tracks, c.track_id, `/audio_cues/${c.id}/track_id`); need(old.scene_occurrences, c.scene_id, `/audio_cues/${c.id}/scene_id`);
    c.episode_ids.forEach(id => need(old.episodes, id, `/audio_cues/${c.id}/episode_ids`));
    c.beat_refs.forEach(id => need(old.beats, id, `/audio_cues/${c.id}/beat_refs`)); c.shot_refs.forEach(id => need(old.shots, id, `/audio_cues/${c.id}/shot_refs`));
    c.asset_ref_ids.forEach(id => need(old.asset_references, id, `/audio_cues/${c.id}/asset_ref_ids`));
    const cueInterval = interval(c.timing);
    const touched = old.episodes.filter(e => {
      const overlap = intersect(interval(e.timing), cueInterval);
      return compare(overlap.end, overlap.start) > 0;
    });
    if (touched.length !== c.episode_ids.length || touched.some(e => !c.episode_ids.includes(e.id))) issue('LEGACY_TIMING', `/audio_cues/${c.id}/episode_ids`, 'Cue must declare exactly the episodes it intersects');
    const covered = touched.reduce((duration, e) => {
      const overlap = intersect(interval(e.timing), cueInterval);
      return add(duration, subtract(overlap.end, overlap.start));
    }, seconds(0));
    if (compare(covered, seconds(c.timing.duration_seconds)) !== 0) issue('LEGACY_TIMING', `/audio_cues/${c.id}`, 'Cue cannot lose time outside declared episodes during migration');
    const scene = sceneById.get(c.scene_id ?? '');
    if (scene && !c.episode_ids.includes(scene.episode_id)) issue('LEGACY_OWNERSHIP', `/audio_cues/${c.id}/scene_id`, 'Cue does not include its associated scene episode');
    for (const id of c.beat_refs) {
      const beat = beatById.get(id);
      if (c.scene_id !== null && beat && beat.scene_id !== c.scene_id) issue('LEGACY_OWNERSHIP', `/audio_cues/${c.id}/beat_refs`, 'Cue beat belongs to another scene');
    }
    for (const id of c.shot_refs) {
      const shot = old.shots.find(row => row.id === id);
      if (!shot) continue;
      const overlap = intersect(cueInterval, interval(shot.timing));
      if (compare(overlap.end, overlap.start) <= 0) issue('LEGACY_AUDIO_SHOT', `/audio_cues/${c.id}/shot_refs`, 'Referenced shot does not intersect the cue');
      if (c.scene_id !== null && shot.scene_id !== c.scene_id) issue('LEGACY_OWNERSHIP', `/audio_cues/${c.id}/shot_refs`, 'Cue shot belongs to another scene');
    }
    if (c.line_id !== undefined) {
      const l = need(old.dialogue_lines, c.line_id, `/audio_cues/${c.id}/line_id`);
      if (l && (l.text !== c.text || l.kind !== c.kind || l.speaker_id !== c.speaker_id || l.scene_id !== c.scene_id || !c.beat_refs.includes(l.beat_id))) issue('LEGACY_AUDIO_SCRIPT', `/audio_cues/${c.id}`, 'Cue duplicates disagree with canonical dialogue line');
    }
  });
  const visualUses = new Map<string, number>();
  const targetCues = { video: new Set<string>(), audio: new Set<string>() };
  old.render_segments.forEach(s => {
    if (!old.project.targets.includes(s.media_type)) issue('LEGACY_TARGET', `/render_segments/${s.id}`, 'Segment modality is not a declared target');
    s.shot_ids.forEach(id => need(old.shots, id, `/render_segments/${s.id}/shot_ids`)); s.audio_cue_ids.forEach(id => need(old.audio_cues, id, `/render_segments/${s.id}/audio_cue_ids`));
    const refs = s.required_asset_ref_ids.map(id => need(old.asset_references, id, `/render_segments/${s.id}/required_asset_ref_ids`));
    const output = need(old.assets, s.output_asset_id, `/render_segments/${s.id}/output_asset_id`);
    s.audio_cue_ids.forEach(id => targetCues[s.media_type].add(id));
    if (s.media_type === 'video') {
      s.shot_ids.forEach(id => visualUses.set(id, (visualUses.get(id) ?? 0) + 1));
      const shots = s.shot_ids.map(id => old.shots.find(row => row.id === id)).filter(row => row !== undefined);
      if (shots.some((shot, index) => index > 0 && shot.sequence !== shots[index - 1]!.sequence + 1)) issue('LEGACY_SEGMENT_ORDER', `/render_segments/${s.id}/shot_ids`, 'Legacy video grouping must remain consecutive and ordered');
      const group = interval(s.timing);
      for (const shot of shots) {
        const span = interval(shot.timing);
        if (compare(span.start, group.start) < 0 || compare(span.end, group.end) > 0) issue('LEGACY_SEGMENT_TIMING', `/render_segments/${s.id}/shot_ids`, 'Legacy segment must contain its assigned shot intervals');
      }
    }
    for (const id of s.audio_cue_ids) {
      const cue = old.audio_cues.find(row => row.id === id);
      if (!cue) continue;
      const overlap = intersect(interval(cue.timing), interval(s.timing));
      if (compare(overlap.end, overlap.start) <= 0) issue('LEGACY_SEGMENT_TIMING', `/render_segments/${s.id}/audio_cue_ids`, 'Assigned cue does not intersect the legacy segment');
    }
    if (s.status === 'ready' || s.status === 'produced') {
      if (refs.some(ref => ref !== undefined && ref.mode !== 'actual')) issue('LEGACY_SEGMENT_READINESS', `/render_segments/${s.id}/required_asset_ref_ids`, 'Ready segment prerequisites must be declared actual');
    }
    // This checks declaration consistency only; reset_readiness still cannot authenticate any file.
    if (s.status === 'produced' && (!output || output.status !== 'ready' || output.media_type !== s.media_type)) issue('LEGACY_SEGMENT_OUTPUT', `/render_segments/${s.id}/output_asset_id`, 'Produced output must declare ready material of the matching modality');
  });
  if (old.project.targets.includes('video')) {
    if (!old.shots.length) issue('LEGACY_TARGET_EMPTY', '/shots', 'Legacy video target needs a visual plan');
    old.shots.forEach(shot => { if (visualUses.get(shot.id) !== 1) issue('LEGACY_SHOT_DELIVERY', `/shots/${shot.id}`, 'Legacy shot must belong to exactly one video group before conversion'); });
  }
  if (old.project.targets.includes('audio') && !targetCues.audio.size) issue('LEGACY_TARGET_EMPTY', '/render_segments', 'Legacy audio target needs an audio delivery group');
  old.audio_cues.forEach(cue => { if (!targetCues.video.has(cue.id) && !targetCues.audio.has(cue.id)) issue('UNASSIGNED_CUE', `/audio_cues/${cue.id}`, 'Legacy cue has no declared rendition membership'); });
  old.adaptation_decisions.forEach(d => {
    [...d.affected_beat_ids, ...d.replacement_beat_ids].forEach(id => need(old.beats, id, `/adaptation_decisions/${d.id}`));
    if (d.affected_beat_ids.some(id => d.replacement_beat_ids.includes(id))) issue('LEGACY_DECISION_CYCLE', `/adaptation_decisions/${d.id}`, 'An adaptation replacement cannot directly replace itself');
  });
  const coverage = new Map<string, Legacy['coverage'][number]>();
  old.coverage.forEach((c, i) => {
    need(old.beats, c.beat_id, `/coverage/${i}/beat_id`); const decision = need(old.adaptation_decisions, c.decision_id, `/coverage/${i}/decision_id`);
    if (coverage.has(c.beat_id)) issue('LEGACY_COVERAGE', `/coverage/${i}`, 'A beat has more than one legacy coverage declaration');
    coverage.set(c.beat_id, c);
    if (decision && !decision.affected_beat_ids.includes(c.beat_id)) issue('LEGACY_COVERAGE', `/coverage/${i}/decision_id`, 'Coverage decision does not cover this beat');
    c.shot_ids.forEach(id => { const s = need(old.shots, id, `/coverage/${i}/shot_ids`); if (s && !s.beat_refs.includes(c.beat_id)) issue('LEGACY_COVERAGE', `/coverage/${i}`, 'Declared coverage differs from shot content'); });
    c.audio_cue_ids.forEach(id => { const a = need(old.audio_cues, id, `/coverage/${i}/audio_cue_ids`); if (a && !a.beat_refs.includes(c.beat_id)) issue('LEGACY_COVERAGE', `/coverage/${i}`, 'Declared coverage differs from cue content'); });
  });
  for (const [rows, field] of [[old.shots, 'shot_ids'], [old.audio_cues, 'audio_cue_ids']] as const) for (const row of rows) for (const beat of row.beat_refs) {
    const declared = coverage.get(beat);
    if (declared && !declared[field].includes(row.id)) issue('LEGACY_COVERAGE', `/coverage/${beat}/${field}`, 'Content edge is absent from its legacy coverage ledger');
  }
  // Resolve approved replacements iteratively: cycles without direct coverage cannot manufacture coverage.
  for (const target of old.project.targets) {
    const covered = new Set(old.coverage.filter(row => target === 'video'
      ? row.shot_ids.some(id => (visualUses.get(id) ?? 0) > 0) || row.audio_cue_ids.some(id => targetCues.video.has(id))
      : row.audio_cue_ids.some(id => targetCues.audio.has(id))).map(row => row.beat_id));
    let previous: number;
    do {
      previous = covered.size;
      for (const row of old.coverage) {
        const decision = old.adaptation_decisions.find(d => d.id === row.decision_id);
        if (decision?.status === 'approved' && decision.affected_beat_ids.includes(row.beat_id) && (decision.action === 'omit' || decision.replacement_beat_ids.every(id => covered.has(id)))) covered.add(row.beat_id);
      }
    } while (covered.size !== previous);
    old.beats.forEach(beat => { if (beat.required && !covered.has(beat.id)) issue('LEGACY_COVERAGE', `/coverage/${beat.id}`, `Required beat lacks legacy ${target} delivery coverage`); });
  }
  if (old.export.status === 'render_ready' || old.export.status === 'exported') {
    if (active?.status !== 'adopted' || old.adopted_revision_id !== old.active_revision_id) issue('LEGACY_EXPORT_READINESS', '/export/status', 'Ready handoff needs an adopted active revision');
    const used = new Set([...old.shots.flatMap(row => row.asset_ref_ids), ...old.audio_cues.flatMap(row => row.asset_ref_ids), ...old.render_segments.flatMap(row => row.required_asset_ref_ids), ...old.panels.flatMap(panel => panel.asset_ref_id === null ? [] : [panel.asset_ref_id])]);
    for (const id of used) {
      const ref = old.asset_references.find(row => row.id === id);
      if (ref && ref.mode !== 'actual') issue('LEGACY_EXPORT_READINESS', `/asset_references/${id}`, 'Ready handoff cannot consume a planned prerequisite');
    }
    if (old.export.unsupported_features.length) issue('LEGACY_EXPORT_LOSS', '/export/unsupported_features', 'Ready handoff must resolve declared unsupported features');
  }
  const count = old.project.scope;
  if (count.expected_episode_count !== old.episodes.length || count.expected_scene_count !== old.scene_occurrences.length || count.expected_required_beat_count !== old.beats.filter(b => b.required).length)
    issue('LEGACY_SCOPE', '/project/scope', 'Declared scope differs from legacy contents');
  for (const [name, rows, group] of [
    ['episodes', old.episodes, (_r: Legacy['episodes'][number]) => 'all'],
    ['scene_occurrences', old.scene_occurrences, (_r: Legacy['scene_occurrences'][number]) => 'all'],
    ['beats', old.beats, (r: Legacy['beats'][number]) => r.scene_id],
    ['shots', old.shots, (_r: Legacy['shots'][number]) => 'all'],
  ] as const) {
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const g = (group as (r: typeof row) => string)(row);
      groups.set(g, [...groups.get(g) ?? [], row.sequence]);
    }
    for (const values of groups.values()) if ([...values].sort((a, b) => a - b).some((n, i) => n !== i + 1)) issue('LEGACY_SEQUENCE', `/${name}`, 'Legacy sequence must be unique and consecutive');
  }
  const allTimed = [...old.episodes, ...old.shots, ...old.audio_cues, ...old.render_segments];
  allTimed.forEach(row => {
    if (row.timing.basis !== 'estimated') issue('MEASUREMENT_REVIEW', `/timing/${row.id}`, 'Measured legacy timing requires an explicit media/evidence migration, not a planning import');
    if (compare(interval(row.timing).end, seconds(old.project.target_duration_seconds)) > 0) issue('LEGACY_TIMING', `/timing/${row.id}`, 'Timing lies outside the declared source duration');
  });
  const episodeOrder = [...old.episodes].sort((a, b) => a.sequence - b.sequence);
  episodeOrder.forEach((e, i) => { if (i && compare(interval(episodeOrder[i - 1]!.timing).end, interval(e.timing).start) > 0) issue('LEGACY_TIMING', `/episodes/${e.id}`, 'Legacy episodes overlap'); });
  if (issues.some(i => i.severity === 'error')) return finish(null);

  const generated = new Map<string, string>();
  function mapped(oldIdentity: string, scope = oldIdentity): string {
    let value = generated.get(scope);
    if (value === undefined) {
      let n = BigInt('0x' + createHash('sha256').update(`camery-v03-to-v05\0${old.package_id}\0${old.active_revision_id}\0${scope}`).digest('hex').slice(0, 32));
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      value = '';
      for (let i = 0; i < 26; i++) { value = alphabet[Number(n & 31n)] + value; n >>= 5n; }
      generated.set(scope, value);
      const outputs = mappings.get(oldIdentity) ?? []; outputs.push(value); mappings.set(oldIdentity, outputs);
    }
    return value;
  }
  const nullable = (id: string | null) => id === null ? null : mapped(id);
  const key = (n: number) => n.toString(36).padStart(8, '0');
  const rid = (target: 'video' | 'audio') => mapped('$rendition:' + target);
  const membership = (cueId: string) => old.project.targets.filter(target => old.render_segments.some(s => s.media_type === target && s.audio_cue_ids.includes(cueId)));
  const sourceRows = old.sources.map((s, i) => {
    const mapping = options.source_mappings?.[s.id];
    const kind = s.kind === 'web' ? mapping?.kind : s.kind;
    const capture = s.capture_state === 'provided' ? 'provided' : mapping?.capture_state;
    const coverage = s.coverage === 'full_selected_content' || s.coverage === 'partial' ? s.coverage : mapping?.coverage;
    if (kind === undefined || capture === undefined || coverage === undefined) issue('SOURCE_MAPPING', `/sources/${i}`, 'Legacy source categories need explicit current-contract mappings');
    if (s.capture_state === 'reference_only' && capture === 'provided' || s.coverage !== 'full_selected_content' && coverage === 'full_selected_content')
      issue('SOURCE_EVIDENCE', `/sources/${i}`, 'Category mapping cannot invent a captured/full source snapshot');
    const basis = s.usage_basis === 'original' || s.usage_basis === 'authorized' ? s.usage_basis : 'unknown';
    if (basis === 'unknown') issue('RIGHTS_UNRESOLVED', `/sources/${i}/usage_basis`, 'Public reference/undetermined is not evidence of adaptation rights; delivery remains blocked', 'warning');
    decision(`/sources/${i}`, 'preserve_source_and_explicit_semantics', { kind: s.kind, capture_state: s.capture_state, coverage: s.coverage, usage_basis: s.usage_basis }, { kind, capture_state: capture, coverage, usage_basis: basis });
    return { id: mapped(s.id), version: 1, kind, title: s.title, origin_uri: s.origin_uri, capture_state: capture, coverage, usage_basis: basis, selected_content: s.selected_content ?? null, note: s.note };
  });
  const relationships = (r: Legacy['beats'][number]['source_refs'][number], where: string) => {
    const relationship = r.relationship === 'original' || r.relationship === 'adapted' || r.relationship === 'quoted' ? r.relationship : options.source_relationships?.[r.relationship];
    if (relationship === undefined) issue('RELATIONSHIP_MAPPING', where, `Legacy relationship ${r.relationship} requires an explicit mapping`);
    if (relationship !== r.relationship) decision(where, 'explicit_relationship_mapping', r.relationship, relationship);
    return { source_id: mapped(r.source_id), locator: r.locator, relationship };
  };
  const beatRows = old.beats.map((b, i) => {
    const kind = b.kind === 'action' || b.kind === 'dialogue' ? b.kind : options.beat_kinds?.[b.kind];
    if (kind === undefined) issue('BEAT_MAPPING', `/beats/${i}/kind`, `Legacy beat kind ${b.kind} requires an explicit mapping`);
    if (kind !== b.kind) decision(`/beats/${i}/kind`, 'explicit_beat_kind_mapping', b.kind, kind);
    return { id: mapped(b.id), version: 1, scene_id: mapped(b.scene_id), order_key: key(b.sequence), kind, required: b.required, summary: b.summary, source_refs: b.source_refs.map((r, j) => relationships(r, `/beats/${i}/source_refs/${j}`)), claim_ids: [] };
  });
  const lineRows = old.dialogue_lines.map((l, i) => {
    const kind = l.kind === 'narration' ? 'narration' : options.line_kinds?.[l.id];
    if (kind === undefined || l.kind === 'dialogue' && kind === 'narration') issue('VOICE_MAPPING', `/dialogue_lines/${i}/kind`, 'Legacy dialogue does not say whether the speaker is visible, internal or off-screen');
    const targets = new Set(old.audio_cues.filter(c => c.line_id === l.id).flatMap(c => membership(c.id)));
    if (!targets.size) issue('UNASSIGNED_LINE', `/dialogue_lines/${i}`, 'No rendition membership can be established from legacy generation groups');
    decision(`/dialogue_lines/${i}/kind`, 'explicit_voice_semantics', l.kind, kind);
    return { id: mapped(l.id), version: 1, beat_id: mapped(l.beat_id), order_key: key(old.dialogue_lines.filter(x => x.beat_id === l.beat_id).indexOf(l) + 1), speaker_id: mapped(l.speaker_id), kind, text: l.text, delivery: l.delivery, only_rendition_ids: [...targets].map(rid), locked: false };
  });
  const assetRows = old.assets.map((a, i) => {
    const origin = options.asset_origins?.[a.id];
    if (origin === undefined) issue('ASSET_ORIGIN', `/assets/${i}/origin`, 'Caller must explicitly declare the asset creation/import intent');
    if (a.media_type === 'document') issue('UNSUPPORTED_ASSET', `/assets/${i}`, 'Current media asset contract cannot represent legacy document assets');
    if (a.status === 'ready' && options.reset_readiness !== true) issue('READINESS_REVIEW', `/assets/${i}`, 'Ready metadata cannot be certified by migration; explicitly reset to planning or migrate actual files separately');
    decision(`/assets/${i}`, 'planning_asset_without_file_certification', { status: a.status, file: a.file, origin: null }, { status: a.status === 'missing' ? 'missing' : 'planned', origin, file: null });
    return { id: mapped(a.id), version: 1, media_type: a.media_type, status: a.status === 'missing' ? 'missing' : 'planned', description: a.description, origin, consent_ref: null, file: null };
  });
  const referenceRows = old.asset_references.map((r, i) => {
    const purpose = r.purpose === 'identity' ? 'character' : r.purpose === 'location' ? 'scene' : r.purpose;
    if (purpose === 'generic') issue('UNSUPPORTED_REFERENCE', `/asset_references/${i}/purpose`, 'Generic references need a typed current-contract purpose');
    const exclusions = r.must_not_control || options.reference_exclusions?.[r.id];
    if (!exclusions) issue('REFERENCE_EXCLUSION', `/asset_references/${i}/must_not_control`, 'Empty legacy exclusions need an explicit user-authored rule');
    return { id: mapped(r.id), version: 1, mode: 'planned', asset_id: mapped(r.asset_id), purpose, controls: r.controls, must_not_control: exclusions };
  });
  const shotRows = [...old.shots].sort((a, b) => a.sequence - b.sequence).map((s, i) => {
    const camera = { shot_size: options.camera?.shot_sizes[s.camera.shot_size], angle: options.camera?.angles[s.camera.angle], movement: options.camera?.movements[s.camera.movement], lens_mm: s.camera.lens_mm ?? null, note: null };
    if (camera.shot_size === undefined || camera.angle === undefined || camera.movement === undefined) issue('CAMERA_MAPPING', `/shots/${i}/camera`, 'Free-text legacy camera values require an explicit controlled-vocabulary mapping');
    decision(`/shots/${i}/camera`, 'explicit_camera_vocabulary', s.camera, camera);
    return { id: mapped(s.id), version: 1, rendition_id: rid('video'), scene_id: mapped(s.scene_id), order_key: key(s.sequence), beat_refs: s.beat_refs.map(x => mapped(x)), visual_purpose: s.visual_purpose,
      start_state: { summary: s.start_state, characters: [] }, action: s.action, end_state: { summary: s.end_state, characters: [] }, camera, asset_ref_ids: s.asset_ref_ids.map(x => mapped(x)), duration: { planned: s.timing.duration_seconds, measured: null }, continuity_break: null };
  });
  for (const episode of old.episodes) {
    let cursor = seconds(0);
    for (const shot of [...old.shots].filter(s => sceneById.get(s.scene_id)!.episode_id === episode.id).sort((a, b) => a.sequence - b.sequence)) {
      const start = subtract(seconds(shot.timing.start_seconds), seconds(episode.timing.start_seconds));
      if (compare(start, cursor) !== 0) issue('SHOT_TIMING_GAP', `/shots/${shot.id}/timing`, 'Duration-only picture tracks cannot silently remove legacy gaps or overlaps');
      cursor = add(cursor, seconds(shot.timing.duration_seconds));
      if (compare(cursor, seconds(episode.timing.duration_seconds)) > 0) issue('LEGACY_TIMING', `/shots/${shot.id}`, 'Shot exceeds its declared episode');
    }
    if (old.project.targets.includes('video') && compare(cursor, seconds(episode.timing.duration_seconds)) !== 0)
      issue('SHOT_TIMING_GAP', `/episodes/${episode.id}/timing`, 'Picture-track gaps cannot be filled or discarded without an explicit editorial decision');
  }
  const panelRows = old.panels.map((p, i) => {
    const shot = old.shots.find(s => s.id === p.shot_id)!;
    const duration = shot.timing.duration_seconds;
    if (p.position === 'start' ? p.offset_seconds !== 0 : p.position === 'end' ? p.offset_seconds !== duration : !(p.offset_seconds > 0 && p.offset_seconds < duration)) issue('LEGACY_PANEL_TIME', `/panels/${i}`, 'Legacy keyframe position and offset disagree');
    const base = { id: mapped(p.id), version: 1, shot_id: mapped(p.shot_id), description: p.description, candidate_asset_ref_ids: p.asset_ref_id === null ? [] : [mapped(p.asset_ref_id)], adopted_asset_ref_id: null };
    if (p.status === 'ready') decision(`/panels/${i}`, 'reset_adoption_pending_media_verification', p, base);
    return p.position === 'key' ? { ...base, position: 'intermediate', offset_ratio: p.offset_seconds / duration } : { ...base, position: p.position };
  });
  const cueRows: unknown[] = [];
  const expectedCues: Array<{ id: string; rendition: string; episode: string; span: Interval; where: string }> = [];
  for (const [i, cue] of old.audio_cues.entries()) {
    const targets = membership(cue.id);
    if (!targets.length) issue('UNASSIGNED_CUE', `/audio_cues/${i}`, 'Cue is absent from every legacy rendition group');
    if (cue.episode_ids.length > 1 && (cue.line_id !== undefined || cue.mix.fade_in_seconds || cue.mix.fade_out_seconds)) issue('CROSS_EPISODE_REVIEW', `/audio_cues/${i}`, 'Cross-episode speech or fades need a manual boundary decision');
    for (const target of targets) {
      let previous: string | null = null;
      for (const episode of episodeOrder.filter(e => cue.episode_ids.includes(e.id))) {
        const { start, end } = intersect(interval(cue.timing), interval(episode.timing));
        if (compare(end, start) <= 0) { issue('LEGACY_TIMING', `/audio_cues/${i}`, 'Declared cue episode has no temporal intersection'); continue; }
        const cueId = mapped(cue.id, `cue:${cue.id}:${target}:${episode.id}`);
        const relativeStart = subtract(start, seconds(episode.timing.start_seconds));
        const relativeEnd = subtract(end, seconds(episode.timing.start_seconds));
        const base = { id: cueId, version: 1, rendition_id: rid(target), episode_id: mapped(episode.id), track_id: mapped(cue.track_id, `track:${cue.track_id}:${target}`), asset_ref_ids: cue.asset_ref_ids.map(x => mapped(x)), anchor: { ref: mapped(episode.id), edge: 'start', offset: toSeconds(relativeStart) }, mix: cue.mix, kind: cue.kind, extent: { kind: 'fixed', duration: { planned: toSeconds(subtract(end, start)), measured: null } } };
        expectedCues.push({ id: cueId, rendition: rid(target), episode: mapped(episode.id), span: { start: relativeStart, end: relativeEnd }, where: `/audio_cues/${i}/timing` });
        const sourceScene = cue.scene_id === null ? null : sceneById.get(cue.scene_id)!;
        if (cue.line_id !== undefined) {
          const line = lineById.get(cue.line_id)!;
          if (sceneById.get(line.scene_id)!.episode_id !== episode.id) issue('LEGACY_OWNERSHIP', `/audio_cues/${i}`, 'Spoken cue belongs to another episode');
          cueRows.push({ ...base, line_id: mapped(cue.line_id) });
        } else {
          const beats = cue.beat_refs.filter(id => sceneById.get(beatById.get(id)!.scene_id)!.episode_id === episode.id).map(x => mapped(x));
          cueRows.push({ ...base, scene_id: sourceScene?.episode_id === episode.id ? mapped(sourceScene.id) : null, beat_refs: beats, sound_intent: cue.sound_intent, continues_from: previous });
        }
        previous = cueId;
        decision(`/audio_cues/${i}/timing`, 'preserve_absolute_time_as_episode_relative', { target, episode_id: episode.id, timing: cue.timing }, { id: cueId, anchor: base.anchor, extent: base.extent });
      }
    }
  }
  if (old.project.targets.includes('video') && options.video_aspect_ratio === undefined) issue('ASPECT_RATIO', '/project/targets', 'Legacy package has no video aspect ratio; caller must choose it explicitly');
  const rights = sourceRows.some(s => s.usage_basis === 'unknown') ? 'unknown' : sourceRows.every(s => s.usage_basis === 'original') ? 'original' : 'authorized';
  const candidate = {
    schema_version: '0.5.0-draft', package_id: mapped(old.package_id),
    project: { id: mapped(old.project.id), title: old.project.title, mode: old.project.mode, content_kind: old.project.content_kind, rights_status: rights, content_pack_versions: {}, source_ids: old.project.source_ids.map(x => mapped(x)), scope: old.project.scope },
    revision: { number: active!.number, status: 'candidate', note: `${active!.note}\nMigrated planning candidate; prior adoption/export is retained only in the migration report.` },
    sources: sourceRows,
    characters: old.characters.map(c => ({ id: mapped(c.id), version: 1, name: c.name, role: c.role, default_voice_ref_id: nullable(c.voice_reference_id) })),
    appearances: [], props: [], locations: old.locations.map(l => ({ id: mapped(l.id), version: 1, name: l.name, description: l.description, spots: [] })), claims: [],
    episodes: episodeOrder.map(e => ({ id: mapped(e.id), version: 1, title: e.title, order_key: key(e.sequence), target_seconds: e.timing.duration_seconds })),
    scenes: old.scene_occurrences.map(s => ({ id: mapped(s.id), version: 1, episode_id: mapped(s.episode_id), order_key: key(s.sequence), title: s.title, location_id: nullable(s.location_id), character_ids: s.character_ids.map(x => mapped(x)), script_text: s.script_text, start_state: s.start_state, end_state: s.end_state })),
    beats: beatRows, lines: lineRows,
    renditions: old.project.targets.map(target => target === 'video' ? { id: rid(target), version: 1, label: 'Imported video plan', kind: target, readiness: 'planned', aspect_ratio: options.video_aspect_ratio } : { id: rid(target), version: 1, label: 'Imported audio plan', kind: target, readiness: 'planned' }),
    shots: shotRows, panels: panelRows,
    audio_tracks: old.project.targets.flatMap(target => old.audio_tracks.map(t => ({ id: mapped(t.id, `track:${t.id}:${target}`), version: 1, rendition_id: rid(target), role: t.role, allow_overlap: t.allow_overlap }))),
    audio_cues: cueRows, assets: assetRows, asset_references: referenceRows,
    adaptation_decisions: old.adaptation_decisions.map(d => ({ ...d, id: mapped(d.id), version: 1, rendition_id: null, affected_beat_ids: d.affected_beat_ids.map(x => mapped(x)), replacement_beat_ids: d.replacement_beat_ids.map(x => mapped(x)), status: d.status === 'proposed' ? 'candidate' : 'approved' })),
    segments: old.render_segments.map(s => ({ id: mapped(s.id), version: 1, rendition_id: rid(s.media_type), target_mode: s.target_profile, purpose: `Legacy grouping intent ${s.id}; reconfirm before production`, planned_duration: s.timing.duration_seconds, handles: { head: 0, tail: 0 }, priority: 'normal', continuity_from: null })),
    shot_takes: [], plot_units: [], episode_state_snapshots: [], shot_lineage: [], locks: [],
  };
  decision('/render_segments', 'preserve_legacy_grouping_without_takes', old.render_segments, candidate.segments);
  decision('/coverage', 'recompute_coverage_from_content', old.coverage, 'No redundant coverage table in v0.5; original declarations retained in legacy report');
  decision('/revisions', 'retain_history_as_audit_only', old.revisions, candidate.revision);
  issue('PLANNING_ONLY', '/', 'Migration has not verified actual media, adopted content, facts or external export readiness', 'warning');
  if (issues.some(i => i.severity === 'error')) return finish(null);
  const output = StoryboardPackage.safeParse(candidate);
  if (!output.success) { output.error.issues.forEach(e => issue('OUTPUT_SCHEMA', '/' + e.path.join('/'), e.message)); return finish(null); }
  const report = validatePackage(output.data);
  if (!report.valid) { report.errors.forEach(e => issue(e.code, e.where, `Migrated candidate: ${e.message}`)); return finish(null); }
  const resolved = resolveTimeline(output.data);
  const timelines = new Map(resolved.timelines.map(t => [JSON.stringify([t.rendition_id, t.episode_id]), t]));
  // A valid new timeline is insufficient: it must reproduce the old editorial clock,
  // including audio tails and scene order. Missing silence cannot be invented here.
  for (const episode of old.episodes) for (const target of old.project.targets) {
    const timeline = timelines.get(JSON.stringify([rid(target), mapped(episode.id)]))!;
    if (compare(timeline.duration, seconds(episode.timing.duration_seconds)) !== 0)
      issue('EPISODE_TIMING_MISMATCH', `/episodes/${episode.id}/timing`, `The ${target} timeline cannot preserve the declared episode duration without an explicit editorial decision`);
  }
  for (const [i, shot] of old.shots.entries()) {
    const episode = old.episodes.find(e => e.id === sceneById.get(shot.scene_id)!.episode_id)!;
    const timeline = timelines.get(JSON.stringify([rid('video'), mapped(episode.id)]))!;
    const actual = timeline.spans.get(mapped(shot.id))!;
    const original = interval(shot.timing);
    const episodeStart = seconds(episode.timing.start_seconds);
    if (compare(actual.start, subtract(original.start, episodeStart)) !== 0 || compare(actual.end, subtract(original.end, episodeStart)) !== 0)
      issue('SHOT_TIMING_MISMATCH', `/shots/${i}/timing`, 'Current scene/shot ordering would move this shot away from its declared legacy interval');
  }
  for (const expected of expectedCues) {
    const actual = timelines.get(JSON.stringify([expected.rendition, expected.episode]))!.spans.get(expected.id)!;
    if (compare(actual.start, expected.span.start) !== 0 || compare(actual.end, expected.span.end) !== 0)
      issue('CUE_TIMING_MISMATCH', expected.where, 'Current cue representation cannot preserve the exact legacy interval');
  }
  if (issues.some(i => i.severity === 'error')) return finish(null);
  return finish(output.data);
}

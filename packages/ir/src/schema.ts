import { z } from 'zod';

export const SCHEMA_VERSION = '0.5.0-draft' as const;
export const StableId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'Expected a canonical ULID');
const text = z.string().min(1);
const seconds = z.number().nonnegative();
const positive = z.number().positive();
const revision = z.int().positive();
const orderKey = z.string().regex(/^[0-9A-Za-z]+$/);
const ids = z.array(StableId);
const identity = { id: StableId, version: revision };
export const RevisionRef = z.strictObject({ id: StableId, version: revision });
export const Duration = z.strictObject({ planned: positive, measured: positive.nullable() });
export const TimeAnchor = z.strictObject({ ref: StableId, edge: z.enum(['start', 'end']), offset: z.number() });
const sourceRef = z.strictObject({ source_id: StableId, locator: text, relationship: z.enum(['adapted', 'quoted', 'inspired', 'original']) });

export const Source = z.strictObject({
  ...identity, kind: z.enum(['novel', 'book', 'note', 'article', 'original']), title: text,
  origin_uri: text.nullable(), capture_state: z.enum(['provided', 'missing', 'partial']),
  coverage: z.enum(['full_selected_content', 'partial']), usage_basis: z.enum(['authorized', 'original', 'public_domain', 'unknown']),
  selected_content: text.nullable(), note: z.string(),
});
const character = z.strictObject({ ...identity, name: text, role: text, default_voice_ref_id: StableId.nullable() });
const appearance = z.strictObject({ ...identity, character_id: StableId, label: text, description: text, scene_ids: ids, reference_asset_ref_ids: ids });
const prop = z.strictObject({
  ...identity, name: text, description: text,
  physical_size: z.strictObject({ value: positive, unit: z.enum(['mm', 'cm', 'm']), description: text }).nullable().optional(),
});
const location = z.strictObject({
  ...identity, name: text, description: text, spots: z.array(z.strictObject({ id: StableId, label: text })),
  lighting_sentence: text.optional(),
});
const episode = z.strictObject({ ...identity, title: text, order_key: orderKey, target_seconds: positive });
const scene = z.strictObject({
  ...identity, episode_id: StableId, order_key: orderKey, title: text, location_id: StableId.nullable(),
  character_ids: ids, script_text: text, start_state: text, end_state: text,
});
const beat = z.strictObject({
  ...identity, scene_id: StableId, order_key: orderKey, kind: z.enum(['action', 'dialogue', 'narration']),
  required: z.boolean(), summary: text, source_refs: z.array(sourceRef), claim_ids: ids,
});
export const DialogueLine = z.strictObject({
  ...identity, beat_id: StableId, order_key: orderKey, speaker_id: StableId,
  kind: z.enum(['on_screen', 'inner_monologue', 'off_screen', 'narration']), text, delivery: text,
  only_rendition_ids: ids.nullable(), locked: z.boolean(),
});
export type DialogueLine = z.infer<typeof DialogueLine>;
const characterState = z.strictObject({ character_id: StableId, appearance_id: StableId, spot_id: StableId, holding: ids });
const state = z.strictObject({ summary: text, characters: z.array(characterState) });
export const Shot = z.strictObject({
  ...identity, rendition_id: StableId, scene_id: StableId, order_key: orderKey, beat_refs: ids,
  visual_purpose: text, start_state: state, action: text, end_state: state,
  camera: z.strictObject({
    shot_size: z.enum(['extreme_wide', 'wide', 'full', 'medium', 'medium_close', 'close', 'extreme_close', 'insert']),
    angle: z.enum(['eye_level', 'high', 'low', 'overhead', 'dutch']),
    movement: z.enum(['static', 'pan', 'tilt', 'push', 'pull', 'track', 'orbit', 'handheld', 'zoom']),
    lens_mm: positive.nullable(), note: text.nullable(),
  }),
  asset_ref_ids: ids, duration: Duration, continuity_break: text.nullable(),
  display_no: text.optional(), production_tier: z.enum(['still_motion', 'first_frame_animation', 'video', 'lipsync']).optional(),
  anchor_refs: z.array(RevisionRef).optional(), method_card_refs: z.array(text).optional(),
  camera_placement_id: StableId.nullable().optional(),
  shootability: z.strictObject({ score: z.number().min(0).max(10), issues: z.array(text) }).optional(),
});
export type Shot = z.infer<typeof Shot>;
const panelBase = { ...identity, shot_id: StableId, description: text, candidate_asset_ref_ids: ids, adopted_asset_ref_id: StableId.nullable() };
export const Keyframe = z.discriminatedUnion('position', [
  z.strictObject({ ...panelBase, position: z.literal('start') }),
  z.strictObject({ ...panelBase, position: z.literal('end') }),
  z.strictObject({ ...panelBase, position: z.literal('intermediate'), offset_ratio: z.number().gt(0).lt(1) }),
]);
const mix = z.strictObject({ gain_db: z.number(), fade_in_seconds: seconds, fade_out_seconds: seconds });
const fixedExtent = z.strictObject({ kind: z.literal('fixed'), duration: Duration });
const untilExtent = z.strictObject({ kind: z.literal('until'), anchor: TimeAnchor });
const cueBase = { ...identity, rendition_id: StableId, episode_id: StableId, track_id: StableId, asset_ref_ids: ids, anchor: TimeAnchor, mix };
export const AudioCue = z.union([
  z.strictObject({ ...cueBase, kind: z.enum(['dialogue', 'narration']), line_id: StableId, extent: fixedExtent }),
  z.strictObject({
    ...cueBase, kind: z.enum(['music', 'ambience', 'sfx']), scene_id: StableId.nullable(), beat_refs: ids,
    sound_intent: text, extent: z.union([fixedExtent, untilExtent]), continues_from: StableId.nullable(),
  }),
]);
export type AudioCue = z.infer<typeof AudioCue>;
const file = z.strictObject({ path: text, sha256: z.string().regex(/^[0-9a-f]{64}$/), mime_type: text });
const assetBase = {
  ...identity, media_type: z.enum(['image', 'video', 'audio']), description: text,
  origin: z.enum(['generated', 'uploaded', 'licensed']), consent_ref: text.nullable(),
  measured_seconds: positive.nullable().optional(), quality_tier: z.enum(['draft', 'upscaled', 'refined']).optional(),
  derived_from: RevisionRef.nullable().optional(),
  generated_from_segment: RevisionRef.nullable().optional(),
};
export const Asset = z.discriminatedUnion('status', [
  z.strictObject({ ...assetBase, status: z.literal('ready'), file }),
  z.strictObject({ ...assetBase, status: z.enum(['planned', 'missing']), file: z.null() }),
]);
export type Asset = z.infer<typeof Asset>;
export const AssetReference = z.strictObject({
  ...identity, mode: z.enum(['actual', 'planned']), asset_id: StableId,
  purpose: z.enum(['keyframe', 'voice', 'character', 'scene', 'prop', 'style', 'output']), controls: text, must_not_control: text,
});
export type AssetReference = z.infer<typeof AssetReference>;
export const Claim = z.strictObject({
  ...identity, statement: text, kind: z.enum(['fact', 'opinion']), evidence: z.array(z.strictObject({ source_id: StableId, locator: text })),
  verification: z.enum(['verified', 'unverified', 'rejected']),
});
export type Claim = z.infer<typeof Claim>;
const decisionBase = {
  ...identity, rendition_id: StableId.nullable(), affected_beat_ids: ids.min(1), reason: text,
  status: z.enum(['candidate', 'approved', 'rejected']),
};
export const AdaptationDecision = z.discriminatedUnion('action', [
  z.strictObject({ ...decisionBase, action: z.literal('omit'), replacement_beat_ids: ids.max(0) }),
  z.strictObject({ ...decisionBase, action: z.literal('replace'), replacement_beat_ids: ids.min(1) }),
]);
export type AdaptationDecision = z.infer<typeof AdaptationDecision>;
export const Segment = z.strictObject({
  ...identity, rendition_id: StableId, target_mode: text, purpose: text, planned_duration: positive,
  handles: z.strictObject({ head: seconds, tail: seconds }), priority: z.enum(['first', 'normal', 'backup']),
  continuity_from: RevisionRef.nullable(),
});
export type Segment = z.infer<typeof Segment>;
export const ShotTake = z.strictObject({
  ...identity, shot_id: StableId, segment_revision_id: RevisionRef, media_asset_id: RevisionRef,
  source_in: seconds, source_out: positive, timeline_offset: seconds,
  playback_rate: z.strictObject({ numerator: z.int().positive(), denominator: z.int().positive() }),
  audio_policy: z.enum(['keep', 'detach', 'mute']), visible_speaker_id: StableId.nullable(),
  status: z.enum(['candidate', 'adopted', 'rejected']),
});
export type ShotTake = z.infer<typeof ShotTake>;
export const PlotUnit = z.strictObject({ ...identity, episode_ids: ids.min(1), pressure: text, escalation: text, reversal: text, release: text, next_crisis: text });
export const EpisodeStateSnapshot = z.strictObject({
  ...identity, episode_id: StableId, based_on: z.array(RevisionRef).min(1), status: z.enum(['candidate', 'adopted']),
  facts: z.array(text), knowledge: z.array(z.strictObject({ character_id: StableId, fact: text, source: text })),
  characters: z.array(characterState), plot_threads: z.array(z.strictObject({ setup_episode_id: StableId, payoff_episode_id: StableId.nullable(), summary: text })),
});
const lock = z.strictObject({ ...identity, target: StableId, fields: z.array(text), owner_id: StableId, reason: text });
export const StoryboardPackage = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION), package_id: StableId,
  project: z.strictObject({
    id: StableId, title: text, mode: z.enum(['studio', 'personal']), content_kind: z.enum(['fiction', 'knowledge']),
    rights_status: z.enum(['authorized', 'original', 'public_domain', 'unknown']), content_pack_versions: z.record(text, text), source_ids: ids,
    scope: z.strictObject({ label: text, expected_episode_count: z.int().nonnegative(), expected_scene_count: z.int().nonnegative(), expected_required_beat_count: z.int().nonnegative() }),
  }),
  revision: z.strictObject({ number: revision, status: z.enum(['candidate', 'adopted']), note: z.string() }),
  sources: z.array(Source), characters: z.array(character), appearances: z.array(appearance), props: z.array(prop),
  locations: z.array(location), claims: z.array(Claim), episodes: z.array(episode), scenes: z.array(scene), beats: z.array(beat), lines: z.array(DialogueLine),
  renditions: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ ...identity, label: text, readiness: z.enum(['planned', 'ready']), kind: z.literal('video'), aspect_ratio: z.enum(['9:16', '16:9', '1:1', '4:3']) }),
    z.strictObject({ ...identity, label: text, readiness: z.enum(['planned', 'ready']), kind: z.literal('audio') }),
  ])),
  shots: z.array(Shot), panels: z.array(Keyframe),
  audio_tracks: z.array(z.strictObject({ ...identity, rendition_id: StableId, role: z.enum(['dialogue', 'narration', 'music', 'ambience', 'sfx']), allow_overlap: z.boolean() })),
  audio_cues: z.array(AudioCue), assets: z.array(Asset), asset_references: z.array(AssetReference), adaptation_decisions: z.array(AdaptationDecision),
  segments: z.array(Segment), shot_takes: z.array(ShotTake), plot_units: z.array(PlotUnit), episode_state_snapshots: z.array(EpisodeStateSnapshot),
  shot_lineage: z.array(z.strictObject({ from_ids: ids.min(1), to_ids: ids.min(1), revision })), locks: z.array(lock),
});
export type StoryboardPackage = z.infer<typeof StoryboardPackage>;

export const EditableCollection = z.enum([
  'sources', 'characters', 'appearances', 'props', 'locations', 'claims', 'episodes', 'scenes', 'beats', 'lines',
  'renditions', 'shots', 'panels', 'audio_tracks', 'audio_cues', 'assets', 'asset_references', 'adaptation_decisions',
  'segments', 'shot_takes', 'plot_units', 'episode_state_snapshots',
]);
export type EditableCollection = z.infer<typeof EditableCollection>;
const opBase = { op_id: StableId };
export const ChangeOp = z.discriminatedUnion('op', [
  z.strictObject({ ...opBase, op: z.literal('update'), collection: EditableCollection, target: StableId, set: z.record(text, z.unknown()) }),
  z.strictObject({ ...opBase, op: z.literal('replace'), collection: EditableCollection, target: StableId, value: z.record(text, z.unknown()) }),
  z.strictObject({ ...opBase, op: z.literal('add'), collection: EditableCollection, value: z.record(text, z.unknown()) }),
  z.strictObject({ ...opBase, op: z.literal('remove'), collection: EditableCollection, target: StableId }),
  z.strictObject({ ...opBase, op: z.literal('move'), target: StableId, before_id: StableId.nullable() }),
  z.strictObject({ ...opBase, op: z.literal('split'), target: StableId, into: z.array(Shot.omit({ version: true })).min(2) }),
  z.strictObject({ ...opBase, op: z.literal('merge'), targets: ids.min(2), into: Shot.omit({ version: true }) }),
  z.strictObject({ ...opBase, op: z.literal('lock'), lock_id: StableId, target: StableId, fields: z.array(text), reason: text }),
  z.strictObject({ ...opBase, op: z.literal('unlock'), lock_id: StableId, reason: text }),
  z.strictObject({ ...opBase, op: z.literal('unlock_line'), target: StableId, reason: text }),
]);
export type ChangeOp = z.infer<typeof ChangeOp>;
export const ChangeSet = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION), id: StableId, base_revision: revision,
  author: z.strictObject({ kind: z.enum(['user', 'agent_run', 'system']), id: StableId }),
  status: z.enum(['candidate', 'adopted', 'rejected', 'conflicted']), base_revisions: z.array(RevisionRef), ops: z.array(ChangeOp).min(1),
});
export type ChangeSet = z.infer<typeof ChangeSet>;

export function toJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(StoryboardPackage);
}

export function toChangeSetJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ChangeSet);
}

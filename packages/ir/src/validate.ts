import { StoryboardPackage } from './schema';
import type { ShotTake } from './schema';
import { add, compare, durationValue, rational, resolveTimeline, seconds, subtract } from '@camery/timeline';
import type { Rational } from '@camery/timeline';

const ZERO = rational(0n);
const SNAPSHOT_ROUNDING_LIMIT = seconds(1e-9);
const magnitude = (value: Rational): Rational => compare(value, ZERO) < 0 ? subtract(ZERO, value) : value;
const atBinaryPower = (value: bigint, power: number): Rational => power >= 0
  ? rational(value << BigInt(power)) : rational(value, 1n << BigInt(-power));

/** Numeric snapshots may round exact edit coordinates; bound that uncertainty from the actual IEEE value. */
function numericUncertainty(value: number): Rational {
  if (value === 0) return ZERO;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  const significand = (bits & ((1n << 52n) - 1n)) | (exponent === 0 ? 0n : 1n << 52n);
  const binary = atBinaryPower(significand, power);
  // JSON uses the shortest decimal, which may itself differ from the represented binary value.
  return add(atBinaryPower(1n, power - 1), magnitude(subtract(seconds(value), binary)));
}

function takeDuration(take: ShotTake, value: Rational): Rational {
  return rational(value.numerator * BigInt(take.playback_rate.denominator), value.denominator * BigInt(take.playback_rate.numerator));
}

export interface Issue { code: string; where: string; message: string }
export interface ValidationReport { valid: boolean; errors: Issue[]; warnings: Issue[]; meaning: string }
export interface ValidationOptions { stage?: 'planning' | 'delivery' }

/** 只检查声明数据；实际文件哈希和媒体探测由 Node 边界负责。 */
export function validatePackage(input: unknown, options: ValidationOptions = {}): ValidationReport {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const error = (code: string, where: string, message: string) => { errors.push({ code, where, message }); };
  const warn = (code: string, where: string, message: string) => { warnings.push({ code, where, message }); };
  const result = (): ValidationReport => ({
    valid: errors.length === 0, errors, warnings,
    meaning: '仅检查结构、引用、声明覆盖和时间；不代表文件已核验、事实准确、艺术质量或后期软件接受。',
  });
  const parsed = StoryboardPackage.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) error('SCHEMA', '/' + issue.path.join('/'), issue.message);
    return result();
  }
  const p = parsed.data;
  const seen = new Map<string, string>();
  const versions = new Map<string, number>();
  const versioned = new Map<string, { collection: string; value: Record<string, unknown> }>();
  const register = (id: string, where: string) => {
    const first = seen.get(id);
    if (first !== undefined) error('DUPLICATE_ID', where, `ID already declared at ${first}`);
    else seen.set(id, where);
  };
  register(p.package_id, '/package_id');
  register(p.project.id, '/project/id');
  for (const [name, rows] of Object.entries(p)) {
    if (!Array.isArray(rows)) continue;
    rows.forEach((row: { id?: string; version?: number }, i: number) => {
      if (row.id !== undefined) {
        register(row.id, `/${name}/${i}/id`);
        if (row.version !== undefined) {
          versions.set(row.id, row.version);
          versioned.set(row.id, { collection: name, value: row as Record<string, unknown> });
        }
      }
    });
  }
  p.locations.forEach((loc, i) => loc.spots.forEach((spot, j) => register(spot.id, `/locations/${i}/spots/${j}/id`)));
  function need<T extends { id: string }>(rows: readonly T[], id: string | null, where: string): T | undefined {
    if (id === null) return undefined;
    const row = rows.find(r => r.id === id);
    if (row === undefined) error('MISSING_REFERENCE', where, `Referenced object ${id} does not exist in the expected collection`);
    return row;
  }
  const scope = p.project.scope;
  if (p.episodes.length !== scope.expected_episode_count || p.scenes.length !== scope.expected_scene_count ||
      p.beats.filter(b => b.required).length !== scope.expected_required_beat_count) error('SCOPE', '/project/scope', 'Declared counts differ from package contents');
  p.project.source_ids.forEach((id, i) => need(p.sources, id, `/project/source_ids/${i}`));
  p.locks.forEach((lock, i) => {
    const target = versioned.get(lock.target);
    if (!target) { error('MISSING_REFERENCE', `/locks/${i}/target`, 'Lock target is not an existing versioned content object'); return; }
    if (target.collection === 'locks') { error('LOCK_TARGET', `/locks/${i}/target`, 'A lock cannot target lock metadata'); return; }
    for (const path of lock.fields) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path) || path.split('.').some(part => ['id', 'version', '__proto__', 'prototype', 'constructor'].includes(part))) {
        error('LOCK_FIELD', `/locks/${i}/fields`, 'Lock field is invalid or reserved'); continue;
      }
      let value: unknown = target.value;
      for (const part of path.split('.')) {
        if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) { error('LOCK_FIELD', `/locks/${i}/fields`, 'Locked field does not exist'); break; }
        value = (value as Record<string, unknown>)[part];
      }
    }
  });
  function checkOrders<T extends { order_key: string }>(rows: readonly T[], group: (row: T) => string, where: string): void {
    const keys = new Set<string>();
    rows.forEach((row, i) => {
      const key = group(row) + ':' + row.order_key;
      if (keys.has(key)) error('ORDER_KEY', `${where}/${i}/order_key`, 'Order keys must be unique within their sequence');
      keys.add(key);
    });
  }
  checkOrders(p.episodes, () => 'project', '/episodes');
  checkOrders(p.scenes, r => r.episode_id, '/scenes');
  checkOrders(p.beats, r => r.scene_id, '/beats');
  checkOrders(p.lines, r => r.beat_id, '/lines');
  checkOrders(p.shots, r => r.rendition_id + ':' + r.scene_id, '/shots');
  p.characters.forEach((c, i) => {
    const ref = need(p.asset_references, c.default_voice_ref_id, `/characters/${i}/default_voice_ref_id`);
    const asset = p.assets.find(a => a.id === ref?.asset_id);
    if (ref && (ref.purpose !== 'voice' || asset?.media_type !== 'audio')) error('VOICE_REFERENCE', `/characters/${i}`, 'Voice reference must resolve to audio with purpose=voice');
  });
  p.appearances.forEach((a, i) => {
    need(p.characters, a.character_id, `/appearances/${i}/character_id`);
    a.scene_ids.forEach(id => need(p.scenes, id, `/appearances/${i}/scene_ids`));
    a.reference_asset_ref_ids.forEach(id => need(p.asset_references, id, `/appearances/${i}/reference_asset_ref_ids`));
  });
  p.claims.forEach((c, i) => c.evidence.forEach(e => need(p.sources, e.source_id, `/claims/${i}/evidence`)));
  p.scenes.forEach((s, i) => {
    need(p.episodes, s.episode_id, `/scenes/${i}/episode_id`);
    need(p.locations, s.location_id, `/scenes/${i}/location_id`);
    s.character_ids.forEach((id, j) => need(p.characters, id, `/scenes/${i}/character_ids/${j}`));
  });
  p.beats.forEach((b, i) => {
    need(p.scenes, b.scene_id, `/beats/${i}/scene_id`);
    b.source_refs.forEach((ref, j) => {
      need(p.sources, ref.source_id, `/beats/${i}/source_refs/${j}`);
      if (!p.project.source_ids.includes(ref.source_id)) error('SOURCE_SCOPE', `/beats/${i}`, 'Source is outside project scope');
    });
    b.claim_ids.forEach((id, j) => need(p.claims, id, `/beats/${i}/claim_ids/${j}`));
  });
  p.lines.forEach((line, i) => {
    const b = need(p.beats, line.beat_id, `/lines/${i}/beat_id`);
    need(p.characters, line.speaker_id, `/lines/${i}/speaker_id`);
    const scene = p.scenes.find(s => s.id === b?.scene_id);
    if (scene && !scene.character_ids.includes(line.speaker_id)) error('SPEAKER_SCOPE', `/lines/${i}`, 'Speaker is not a scene participant');
    line.only_rendition_ids?.forEach((id, j) => need(p.renditions, id, `/lines/${i}/only_rendition_ids/${j}`));
  });
  p.shots.forEach((s, i) => {
    const where = `/shots/${i}`;
    const scene = need(p.scenes, s.scene_id, where + '/scene_id');
    const rendition = need(p.renditions, s.rendition_id, where + '/rendition_id');
    if (rendition?.kind === 'audio') error('TARGET', where, 'Visual shot requires a video rendition');
    s.beat_refs.forEach((id, j) => {
      const b = need(p.beats, id, where + `/beat_refs/${j}`);
      if (b && b.scene_id !== s.scene_id) error('SCENE_OWNERSHIP', where, 'Shot references a beat from another scene');
    });
    s.asset_ref_ids.forEach((id, j) => need(p.asset_references, id, where + `/asset_ref_ids/${j}`));
    for (const [edge, state] of [['start', s.start_state], ['end', s.end_state]] as const) state.characters.forEach((c, j) => {
      const at = where + `/${edge}_state/characters/${j}`;
      need(p.characters, c.character_id, at + '/character_id');
      const appearance = need(p.appearances, c.appearance_id, at + '/appearance_id');
      if (appearance && appearance.character_id !== c.character_id) error('APPEARANCE_OWNER', at, 'Appearance belongs to another character');
      const loc = p.locations.find(l => l.id === scene?.location_id);
      if (loc && !loc.spots.some(spot => spot.id === c.spot_id)) error('SPOT_SCOPE', at, 'Position is outside the scene location');
      c.holding.forEach((id, k) => need(p.props, id, at + `/holding/${k}`));
    });
  });
  p.assets.forEach((asset, i) => {
    if (asset.status === 'ready' && (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(asset.file.path) || asset.file.path.includes('\\') || asset.file.path.split('/').includes('..')))
      error('ASSET_PATH', `/assets/${i}/file/path`, 'Asset path must stay relative to its asset root');
    if (asset.generated_from_segment != null) {
      const segment = need(p.segments, asset.generated_from_segment.id, `/assets/${i}/generated_from_segment`);
      if (segment && segment.version !== asset.generated_from_segment.version) error('STALE_REFERENCE', `/assets/${i}/generated_from_segment`, 'Asset provenance uses a stale segment revision');
    }
    if (asset.derived_from != null) {
      const parent = need(p.assets, asset.derived_from.id, `/assets/${i}/derived_from`);
      if (parent && parent.version !== asset.derived_from.version) error('STALE_REFERENCE', `/assets/${i}/derived_from`, 'Derived material uses a stale source revision');
      const visited = new Set([asset.id]);
      let current = parent;
      while (current !== undefined) {
        if (visited.has(current.id)) { error('DERIVATION_CYCLE', `/assets/${i}/derived_from`, 'Material derivation cannot contain cycles'); break; }
        visited.add(current.id);
        current = p.assets.find(a => a.id === current?.derived_from?.id);
      }
    }
  });
  p.asset_references.forEach((ref, i) => {
    const asset = need(p.assets, ref.asset_id, `/asset_references/${i}/asset_id`);
    if (asset && ((ref.mode === 'actual') !== (asset.status === 'ready'))) error('ASSET_READINESS', `/asset_references/${i}`, 'Reference mode differs from declared asset readiness');
  });
  p.panels.forEach((panel, i) => {
    need(p.shots, panel.shot_id, `/panels/${i}/shot_id`);
    panel.candidate_asset_ref_ids.forEach(id => need(p.asset_references, id, `/panels/${i}/candidate_asset_ref_ids`));
    const ref = need(p.asset_references, panel.adopted_asset_ref_id, `/panels/${i}/adopted_asset_ref_id`);
    const asset = p.assets.find(a => a.id === ref?.asset_id);
    if (asset && asset.media_type !== 'image') error('PANEL_ASSET', `/panels/${i}`, 'Keyframe requires an image');
    if (ref && (ref.mode !== 'actual' || asset?.status !== 'ready')) error('PANEL_READINESS', `/panels/${i}`, 'Adopted keyframe requires a declared ready actual reference');
    if (panel.adopted_asset_ref_id !== null && !panel.candidate_asset_ref_ids.includes(panel.adopted_asset_ref_id)) error('PANEL_ADOPTION', `/panels/${i}`, 'Adopted image must be one of its candidates');
  });
  p.audio_tracks.forEach((track, i) => need(p.renditions, track.rendition_id, `/audio_tracks/${i}/rendition_id`));
  p.audio_cues.forEach((cue, i) => {
    const where = `/audio_cues/${i}`;
    need(p.renditions, cue.rendition_id, where + '/rendition_id');
    need(p.episodes, cue.episode_id, where + '/episode_id');
    const track = need(p.audio_tracks, cue.track_id, where + '/track_id');
    if (track && (track.rendition_id !== cue.rendition_id || track.role !== cue.kind)) error('TRACK_SCOPE', where, 'Track role and rendition must match the cue');
    cue.asset_ref_ids.forEach(id => need(p.asset_references, id, where + '/asset_ref_ids'));
    const anchorRows = [...p.shots, ...p.audio_cues, ...p.episodes, ...p.beats];
    const checkAnchor = (anchor: { ref: string }, path: string) => {
      const target = need<{ id: string; rendition_id?: string; episode_id?: string; scene_id?: string | null }>(anchorRows, anchor.ref, path);
      if (target?.rendition_id !== undefined && target.rendition_id !== cue.rendition_id) error('ANCHOR_SCOPE', path, 'Anchor crosses renditions');
      const episodeId = target?.episode_id ?? p.scenes.find(s => s.id === target?.scene_id)?.episode_id ?? (p.episodes.some(e => e.id === target?.id) ? target?.id : undefined);
      if (episodeId !== undefined && episodeId !== cue.episode_id) error('ANCHOR_SCOPE', path, 'Anchor crosses episode boundaries');
    };
    checkAnchor(cue.anchor, where + '/anchor');
    if (cue.extent.kind === 'until') checkAnchor(cue.extent.anchor, where + '/extent/anchor');
    if ('line_id' in cue) {
      const line = need(p.lines, cue.line_id, where + '/line_id');
      const b = p.beats.find(b => b.id === line?.beat_id);
      const scene = p.scenes.find(s => s.id === b?.scene_id);
      if (scene && scene.episode_id !== cue.episode_id) error('SCENE_OWNERSHIP', where, 'Cue line belongs to another episode');
      if (line && ((line.kind === 'narration') !== (cue.kind === 'narration') || (line.only_rendition_ids !== null && !line.only_rendition_ids.includes(cue.rendition_id)))) error('AUDIO_SCRIPT', where, 'Cue kind or rendition differs from canonical line');
    } else {
      const scene = need(p.scenes, cue.scene_id, where + '/scene_id');
      if (scene && scene.episode_id !== cue.episode_id) error('SCENE_OWNERSHIP', where, 'Cue scene belongs to another episode');
      cue.beat_refs.forEach(id => {
        const b = need(p.beats, id, where + '/beat_refs');
        if (b && ((cue.scene_id !== null && b.scene_id !== cue.scene_id) || p.scenes.find(s => s.id === b.scene_id)?.episode_id !== cue.episode_id))
          error('SCENE_OWNERSHIP', where, 'Cue beat belongs to another scene or episode');
      });
      const previous = need(p.audio_cues, cue.continues_from, where + '/continues_from');
      const previousEpisode = p.episodes.find(e => e.id === previous?.episode_id);
      const currentEpisode = p.episodes.find(e => e.id === cue.episode_id);
      if (previous && (previous.rendition_id !== cue.rendition_id || previous.kind !== cue.kind ||
          (previousEpisode && currentEpisode && previousEpisode.order_key >= currentEpisode.order_key)))
        error('CONTINUATION', where, 'Continuation must link a same-kind cue in an earlier episode of this rendition');
    }
  });
  p.adaptation_decisions.forEach((d, i) => {
    need(p.renditions, d.rendition_id, `/adaptation_decisions/${i}/rendition_id`);
    [...d.affected_beat_ids, ...d.replacement_beat_ids].forEach(id => need(p.beats, id, `/adaptation_decisions/${i}/beat_ids`));
    if (d.replacement_beat_ids.some(id => d.affected_beat_ids.includes(id)))
      error('DECISION_OVERLAP', `/adaptation_decisions/${i}/replacement_beat_ids`, 'A replacement cannot cite its own affected beat as replacement evidence');
  });
  p.plot_units.forEach((unit, i) => unit.episode_ids.forEach(id => need(p.episodes, id, `/plot_units/${i}/episode_ids`)));
  p.episode_state_snapshots.forEach((snap, i) => {
    const where = `/episode_state_snapshots/${i}`;
    need(p.episodes, snap.episode_id, where + '/episode_id');
    snap.based_on.forEach(ref => {
      if (!seen.has(ref.id)) error('MISSING_REFERENCE', where + '/based_on', 'Snapshot source object does not exist');
      else if (versions.get(ref.id) !== ref.version) error('STALE_REFERENCE', where + '/based_on', 'Snapshot source revision does not match the bound object');
    });
    snap.knowledge.forEach(k => need(p.characters, k.character_id, where + '/knowledge'));
    snap.characters.forEach(c => {
      need(p.characters, c.character_id, where + '/characters');
      const appearance = need(p.appearances, c.appearance_id, where + '/characters');
      if (appearance && appearance.character_id !== c.character_id) error('APPEARANCE_OWNER', where + '/characters', 'Snapshot appearance belongs to another character');
      need(p.locations.flatMap(l => l.spots), c.spot_id, where + '/characters/spot_id');
      c.holding.forEach(id => need(p.props, id, where + '/characters/holding'));
    });
    snap.plot_threads.forEach(t => {
      need(p.episodes, t.setup_episode_id, where + '/plot_threads/setup_episode_id');
      need(p.episodes, t.payoff_episode_id, where + '/plot_threads/payoff_episode_id');
    });
  });
  p.segments.forEach((segment, i) => {
    need(p.renditions, segment.rendition_id, `/segments/${i}/rendition_id`);
    if (compare(add(seconds(segment.handles.head), seconds(segment.handles.tail)), seconds(segment.planned_duration)) >= 0) error('SEGMENT_HANDLES', `/segments/${i}/handles`, 'Handles consume the whole planned segment');
    if (segment.continuity_from !== null) {
      const asset = need(p.assets, segment.continuity_from.id, `/segments/${i}/continuity_from`);
      if (asset && asset.version !== segment.continuity_from.version) error('STALE_REFERENCE', `/segments/${i}/continuity_from`, 'Continuity requires the bound material version');
      if (asset && (asset.media_type !== 'video' || asset.status !== 'ready')) error('CONTINUITY_MEDIA', `/segments/${i}`, 'Continuity requires a declared ready video');
    }
  });
  p.shot_takes.forEach((take, i) => {
    const where = `/shot_takes/${i}`;
    const shot = need(p.shots, take.shot_id, where + '/shot_id');
    const seg = need(p.segments, take.segment_revision_id.id, where + '/segment_revision_id');
    const asset = need(p.assets, take.media_asset_id.id, where + '/media_asset_id');
    if ((seg && seg.version !== take.segment_revision_id.version) || (asset && asset.version !== take.media_asset_id.version)) error('STALE_REFERENCE', where, 'Take must bind the declared segment and material revisions');
    if (asset && (asset.generated_from_segment?.id !== take.segment_revision_id.id || asset.generated_from_segment.version !== take.segment_revision_id.version)) error('TAKE_PROVENANCE', where, 'Material was not generated from the bound segment revision');
    if (seg && shot && seg.rendition_id !== shot.rendition_id) error('TARGET', where, 'Take and segment belong to different renditions');
    if (asset && (asset.status !== 'ready' || asset.media_type !== 'video' || asset.measured_seconds == null)) error('TAKE_MEDIA', where, 'Take requires declared ready video with measured duration');
    if (compare(seconds(take.source_out), seconds(take.source_in)) <= 0 || (seg && (compare(seconds(take.source_in), seconds(seg.handles.head)) < 0 || (asset?.measured_seconds != null && compare(seconds(take.source_out), subtract(seconds(asset.measured_seconds), seconds(seg.handles.tail))) > 0)))) error('TAKE_RANGE', where, 'Take lies outside the material usable interval');
    need(p.characters, take.visible_speaker_id, where + '/visible_speaker_id');
    if (take.visible_speaker_id !== null && shot && !p.lines.some(line => shot.beat_refs.includes(line.beat_id) && line.speaker_id === take.visible_speaker_id && line.kind === 'on_screen')) error('VISIBLE_SPEAKER', where, 'Visible speaking requires an on-screen line for this shot');
  });
  for (const [i, shot] of p.shots.entries()) {
    if (shot.production_tier === 'lipsync' && !p.lines.some(line => shot.beat_refs.includes(line.beat_id) && line.kind === 'on_screen')) error('LIPSYNC_SCOPE', `/shots/${i}`, 'Lip sync requires visible on-screen dialogue');
    const takes = p.shot_takes.filter(t => t.shot_id === shot.id && t.status === 'adopted').sort((a, b) => compare(seconds(a.timeline_offset), seconds(b.timeline_offset)));
    if (!takes.length && options.stage !== 'delivery') continue;
    let cursor = ZERO;
    let cursorUncertainty = ZERO;
    const sameBoundary = (actual: Rational, expected: Rational, uncertainty: Rational): boolean => {
      const difference = magnitude(subtract(actual, expected));
      if (compare(difference, ZERO) === 0) return true;
      // Preserve the edit serializer's <=1ns contract without treating every sub-nanosecond gap as rounding.
      if (compare(difference, SNAPSHOT_ROUNDING_LIMIT) > 0 || compare(difference, uncertainty) > 0) return false;
      warn('TAKE_TIME_ROUNDED', `/shots/${i}`, 'Take boundary differs only within its numeric snapshot rounding budget, capped at one nanosecond');
      return true;
    };
    for (const take of takes) {
      const offset = seconds(take.timeline_offset);
      if (!sameBoundary(offset, cursor, add(numericUncertainty(take.timeline_offset), cursorUncertainty))) error('TAKE_COVERAGE', `/shots/${i}`, 'Adopted take coverage has a gap or overlap');
      cursor = add(offset, takeDuration(take, subtract(seconds(take.source_out), seconds(take.source_in))));
      cursorUncertainty = add(numericUncertainty(take.timeline_offset), takeDuration(take, add(numericUncertainty(take.source_out), numericUncertainty(take.source_in))));
    }
    if (!sameBoundary(cursor, durationValue(shot.duration), add(cursorUncertainty, numericUncertainty(shot.duration.measured ?? shot.duration.planned)))) error('TAKE_COVERAGE', `/shots/${i}`, 'Adopted takes do not cover the shot duration');
  }
  if (options.stage === 'delivery') {
    if (p.revision.status !== 'adopted') error('DELIVERY_REVISION', '/revision/status', 'Delivery requires a declared adopted snapshot revision');
    if (p.episodes.length === 0) error('DELIVERY_CONTENT', '/episodes', 'Delivery requires at least one episode');
    if (p.renditions.length === 0) error('DELIVERY_TARGETS', '/renditions', 'Delivery requires at least one declared output rendition');
    p.episodes.forEach((episode, i) => {
      if (!p.scenes.some(scene => scene.episode_id === episode.id)) error('EPISODE_CONTENT', `/episodes/${i}`, 'A delivery episode must contain a scene occurrence');
    });
    const consumedReference = (id: string, where: string): void => {
      const reference = p.asset_references.find(reference => reference.id === id);
      const asset = p.assets.find(asset => asset.id === reference?.asset_id);
      if (reference && (reference.mode !== 'actual' || asset?.status !== 'ready'))
        error('DELIVERY_REFERENCE', where, 'A consumed delivery prerequisite must be an actual reference to declared ready media');
    };
    p.shots.forEach((shot, i) => shot.asset_ref_ids.forEach((id, j) => consumedReference(id, `/shots/${i}/asset_ref_ids/${j}`)));
    p.audio_cues.forEach((cue, i) => cue.asset_ref_ids.forEach((id, j) => consumedReference(id, `/audio_cues/${i}/asset_ref_ids/${j}`)));
    p.panels.forEach((panel, i) => { if (panel.adopted_asset_ref_id !== null) consumedReference(panel.adopted_asset_ref_id, `/panels/${i}/adopted_asset_ref_id`); });
    if (p.project.rights_status === 'unknown' || p.sources.some(s => s.usage_basis === 'unknown')) error('RIGHTS', '/project/rights_status', 'Delivery requires a declared adaptation usage basis');
    for (const [i, rendition] of p.renditions.entries()) {
      if (rendition.readiness !== 'ready') error('RENDITION_READINESS', `/renditions/${i}/readiness`, 'Delivery requires the rendition to be declared ready');
      for (const episode of p.episodes) {
        const hasContent = rendition.kind === 'video'
          ? p.shots.some(shot => shot.rendition_id === rendition.id && p.scenes.some(scene => scene.id === shot.scene_id && scene.episode_id === episode.id))
          : p.audio_cues.some(cue => cue.rendition_id === rendition.id && cue.episode_id === episode.id);
        if (!hasContent) error('RENDITION_CONTENT', `/renditions/${i}`, `Rendition has no ${rendition.kind} content for episode ${episode.id}`);
      }
      const covered = new Set(p.beats.filter(b => rendition.kind === 'video'
        ? p.shots.some(s => s.rendition_id === rendition.id && s.beat_refs.includes(b.id))
        : p.audio_cues.some(c => c.rendition_id === rendition.id && c.episode_id === p.scenes.find(s => s.id === b.scene_id)?.episode_id && ('line_id' in c ? p.lines.some(l => l.id === c.line_id && l.beat_id === b.id) : c.beat_refs.includes(b.id))))
        .map(b => b.id));
      const decisions = p.adaptation_decisions.filter(d => d.status === 'approved' && (d.rendition_id === null || d.rendition_id === rendition.id));
      // 固定点传播避免把 replace 当 omit，也避免替代关系循环或长链引发递归溢出。
      let previousSize: number;
      do {
        previousSize = covered.size;
        for (const d of decisions) if (d.action === 'omit' || d.replacement_beat_ids.every(id => covered.has(id)))
          d.affected_beat_ids.forEach(id => covered.add(id));
      } while (covered.size !== previousSize);
      for (const [i, b] of p.beats.entries()) if (b.required && !covered.has(b.id))
        error('BEAT_COVERAGE', `/beats/${i}`, `Required beat lacks ${rendition.id} coverage or a covered adaptation replacement`);
    }
  }
  const plannedAssets = p.assets.filter(asset => asset.status !== 'ready').length;
  if (plannedAssets) warn('PLANNED_MEDIA', '/assets', `${plannedAssets} media declarations remain planned or missing; media quality is not verified`);
  if (p.shots.some(shot => shot.duration.measured === null) || p.audio_cues.some(cue => cue.extent.kind === 'fixed' && cue.extent.duration.measured === null))
    warn('ESTIMATED_TIMING', '/timing', 'Some timing remains planned; measured values are declarations, not media-probe evidence');
  if (p.sources.some(source => source.capture_state !== 'provided' || source.coverage !== 'full_selected_content' || source.selected_content === null))
    warn('REFERENCE_ONLY', '/sources', 'Some selected sources are incomplete or reference-only; factual coverage is not verified');
  if (errors.length === 0) for (const issue of resolveTimeline(p).issues) error(issue.code, issue.where, issue.message);
  return result();
}

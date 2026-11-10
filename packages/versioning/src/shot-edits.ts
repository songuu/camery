import { Shot, StableId } from '@camery/ir';
import type { ChangeOp, ShotTake, StoryboardPackage } from '@camery/ir';
import { add, compare, durationValue, mergeClips, rational, seconds, splitClip, subtract, toSeconds } from '@camery/timeline';
import type { Rational } from '@camery/timeline';

type ShotEdit = Extract<ChangeOp, { op: 'split' | 'merge' }>;
type Panel = StoryboardPackage['panels'][number];
type Anchor = StoryboardPackage['audio_cues'][number]['anchor'];
interface Span { shot: Shot; start: Rational; end: Rational }
interface Warning { code: string; where: string; message: string }
interface Context { newId: () => string; warn?: (issue: Warning) => void }

export class ShotEditError extends Error {
  override readonly name = 'ShotEditError';
  constructor(readonly code: string, readonly where: string, message: string) { super(`${code} at ${where}: ${message}`); }
}

const ZERO = rational(0n);
const ONE = rational(1n);
const TOLERANCE = seconds(1e-9);
const multiply = (a: Rational, b: Rational): Rational => rational(a.numerator * b.numerator, a.denominator * b.denominator);
const divide = (a: Rational, b: Rational): Rational => rational(a.numerator * b.denominator, a.denominator * b.numerator);

function spans(shots: readonly Shot[]): Span[] {
  let cursor = ZERO;
  return shots.map(shot => {
    const start = cursor;
    cursor = add(cursor, durationValue(shot.duration));
    return { shot, start, end: cursor };
  });
}

function reservedIds(pkg: StoryboardPackage): Set<string> {
  const ids = new Set<string>([pkg.package_id]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'id' && typeof item === 'string') ids.add(item);
      else walk(item);
    }
  };
  walk(pkg);
  // Retired shot identities remain reserved even though no current row owns them.
  pkg.shot_lineage.forEach(entry => [...entry.from_ids, ...entry.to_ids].forEach(id => ids.add(id)));
  return ids;
}

/** Caller owns revision/lock/conflict policy; this routine atomically preserves shot-local references. */
export function applyShotEdit(pkg: StoryboardPackage, op: ShotEdit, context: Context): StoryboardPackage {
  const targetIds = op.op === 'split' ? [op.target] : op.targets;
  if (targetIds.length === 0) throw new ShotEditError('SHOT_TARGETS', '/targets', 'Shot edit requires existing targets');
  const targets = targetIds.map(id => {
    const shot = pkg.shots.find(row => row.id === id);
    if (shot === undefined) throw new ShotEditError('MISSING_SHOT', '/targets', `Shot ${id} does not exist`);
    return shot;
  });
  const first = targets[0]!;
  const draftRows = op.op === 'split' ? op.into : [op.into];
  const replacements = draftRows.map((row, index) => {
    const parsed = Shot.safeParse({ ...structuredClone(row), version: 1 });
    if (!parsed.success) throw new ShotEditError('SHOT_SCHEMA', `/into/${index}`, parsed.error.message);
    return parsed.data;
  });
  for (const shot of [...targets, ...replacements]) if (shot.scene_id !== first.scene_id || shot.rendition_id !== first.rendition_id)
    throw new ShotEditError('SHOT_SCOPE', '/targets', 'Shot split/merge must stay within one scene and rendition');
  const reserved = reservedIds(pkg);
  for (const shot of replacements) {
    if (reserved.has(shot.id)) throw new ShotEditError('SHOT_ID_CONFLICT', '/into/id', `Shot identity ${shot.id} is already active or historical`);
    reserved.add(shot.id);
  }
  const targetSet = new Set(targetIds);
  if (pkg.episode_state_snapshots.some(snapshot => snapshot.based_on.some(ref => targetSet.has(ref.id))))
    throw new ShotEditError('DEPENDENT_SNAPSHOT', '/episode_state_snapshots', 'Recompute or remove snapshots bound to replaced shot revisions in the same change set');
  const scoped = pkg.shots.filter(shot => shot.scene_id === first.scene_id && shot.rendition_id === first.rendition_id);
  const edited = op.op === 'split' ? splitClip(scoped, op.target, replacements) : mergeClips(scoped, op.targets, replacements[0]!);
  const sourceSpans = spans(targets);
  const replacementSpans = spans(replacements);
  const sourceById = new Map(sourceSpans.map(span => [span.shot.id, span]));
  const total = sourceSpans.at(-1)!.end;
  const warnings: Warning[] = [];

  const checkPrecision = (actual: Rational, expected: Rational, where: string): void => {
    let error = subtract(actual, expected);
    if (compare(error, ZERO) < 0) error = subtract(ZERO, error);
    if (compare(error, TOLERANCE) > 0) throw new ShotEditError('TIME_PRECISION', where, 'Numeric snapshot would move content by more than one nanosecond');
    if (compare(error, ZERO) > 0) warnings.push({ code: 'TIME_ROUNDED', where, message: 'Numeric snapshot rounded exact edit timing by at most one nanosecond' });
  };
  const numeric = (value: Rational, where: string, scale = ONE): number => {
    const result = toSeconds(value);
    checkPrecision(multiply(seconds(result), scale), multiply(value, scale), where);
    return result;
  };
  const allocate = (where: string): string => {
    const id = context.newId();
    if (!StableId.safeParse(id).success || reserved.has(id)) throw new ShotEditError('GENERATED_ID', where, 'Generated ID must be a fresh canonical ULID');
    reserved.add(id);
    return id;
  };
  const destination = (point: Rational, edge: Anchor['edge']): Span => {
    if (compare(point, ZERO) <= 0) return replacementSpans[0]!;
    for (let i = 0; i < replacementSpans.length; i++) {
      const span = replacementSpans[i]!;
      const relation = compare(point, span.end);
      if (relation < 0 || (relation === 0 && edge === 'end')) return span;
    }
    return replacementSpans.at(-1)!;
  };
  const remapAnchor = (anchor: Anchor, where: string): Anchor => {
    const old = sourceById.get(anchor.ref);
    if (old === undefined) return { ...anchor };
    const point = add(anchor.edge === 'start' ? old.start : old.end, seconds(anchor.offset));
    if (op.op === 'merge') {
      const edge = anchor.edge;
      return { ref: replacements[0]!.id, edge, offset: numeric(subtract(point, edge === 'start' ? ZERO : total), where + '/offset') };
    }
    const span = destination(point, anchor.edge);
    const edge = compare(point, ZERO) < 0 ? 'start' : compare(point, total) > 0 ? 'end' : anchor.edge;
    return { ref: span.shot.id, edge, offset: numeric(subtract(point, edge === 'start' ? span.start : span.end), where + '/offset') };
  };
  const panelAt = (panel: Panel): Panel => {
    const old = sourceById.get(panel.shot_id);
    if (old === undefined) return structuredClone(panel);
    const offset = panel.position === 'start' ? ZERO : panel.position === 'end' ? durationValue(old.shot.duration) : multiply(durationValue(old.shot.duration), seconds(panel.offset_ratio));
    const point = add(old.start, offset);
    const into = op.op === 'merge' ? replacementSpans[0]! : destination(point, 'start');
    const local = subtract(point, into.start);
    const duration = durationValue(into.shot.duration);
    const base = {
      id: panel.id, version: panel.version, shot_id: into.shot.id, description: panel.description,
      candidate_asset_ref_ids: [...panel.candidate_asset_ref_ids], adopted_asset_ref_id: panel.adopted_asset_ref_id,
    };
    if (compare(local, ZERO) === 0) return { ...base, position: 'start' };
    if (compare(local, duration) === 0) return { ...base, position: 'end' };
    const ratio = numeric(divide(local, duration), `/panels/${panel.id}/offset_ratio`, duration);
    // IEEE rounding can put a near-boundary point exactly on the edge; retain a valid slot.
    if (ratio === 1) return { ...base, position: 'end' };
    return { ...base, position: 'intermediate', offset_ratio: ratio };
  };
  const validateVisibility = (take: ShotTake, shot: Shot): void => {
    if (take.visible_speaker_id !== null && !pkg.lines.some(line => shot.beat_refs.includes(line.beat_id) && line.kind === 'on_screen' && line.speaker_id === take.visible_speaker_id))
      throw new ShotEditError('VISIBLE_SPEAKER', `/shot_takes/${take.id}`, 'New shot no longer declares the visible on-screen speech; an explicit dialogue/visibility edit is required');
  };
  const remapTake = (take: ShotTake): ShotTake[] => {
    const old = sourceById.get(take.shot_id);
    if (old === undefined) return [structuredClone(take)];
    const rate = rational(BigInt(take.playback_rate.numerator), BigInt(take.playback_rate.denominator));
    const start = seconds(take.timeline_offset);
    const end = add(start, divide(subtract(seconds(take.source_out), seconds(take.source_in)), rate));
    if (compare(start, ZERO) < 0 || compare(end, durationValue(old.shot.duration)) > 0 || compare(end, start) <= 0)
      throw new ShotEditError('TAKE_OUTSIDE_SHOT', `/shot_takes/${take.id}`, 'Cannot silently trim or discard a take extending outside its source shot');
    if (op.op === 'merge') {
      const shot = replacements[0]!;
      validateVisibility(take, shot);
      return [{ ...structuredClone(take), shot_id: shot.id, timeline_offset: numeric(add(old.start, start), `/shot_takes/${take.id}/timeline_offset`) }];
    }
    const overlaps = replacementSpans.map(span => ({ span, start: compare(start, span.start) > 0 ? start : span.start, end: compare(end, span.end) < 0 ? end : span.end }))
      .filter(overlap => compare(overlap.start, overlap.end) < 0);
    return overlaps.map(overlap => {
      const where = `/shot_takes/${take.id}`;
      validateVisibility(take, overlap.span.shot);
      const sourceIn = add(seconds(take.source_in), multiply(subtract(overlap.start, start), rate));
      const sourceOut = add(seconds(take.source_in), multiply(subtract(overlap.end, start), rate));
      const mapped: ShotTake = {
        ...structuredClone(take), id: overlaps.length > 1 ? allocate(where + '/id') : take.id,
        version: overlaps.length > 1 ? 1 : take.version, shot_id: overlap.span.shot.id,
        source_in: numeric(sourceIn, where + '/source_in'), source_out: numeric(sourceOut, where + '/source_out'),
        timeline_offset: numeric(subtract(overlap.start, overlap.span.start), where + '/timeline_offset'),
      };
      if (mapped.source_out <= mapped.source_in) throw new ShotEditError('TIME_PRECISION', where + '/source_out', 'Rounded source interval would collapse to zero');
      checkPrecision(divide(subtract(seconds(mapped.source_out), seconds(mapped.source_in)), rate), subtract(overlap.end, overlap.start), where + '/duration');
      return mapped;
    });
  };
  const result = structuredClone(pkg);
  const editedById = new Map(edited.map(shot => [shot.id, shot]));
  let inserted = false;
  result.shots = pkg.shots.flatMap(shot => {
    if (!targetSet.has(shot.id)) return [structuredClone(editedById.get(shot.id) ?? shot)];
    if (inserted) return [];
    inserted = true;
    return replacements.map(replacement => structuredClone(editedById.get(replacement.id)!));
  });
  result.panels = pkg.panels.map(panelAt);
  result.audio_cues = pkg.audio_cues.map(cue => {
    const mapped = { ...structuredClone(cue), anchor: remapAnchor(cue.anchor, `/audio_cues/${cue.id}/anchor`) };
    if (cue.extent.kind === 'until') mapped.extent = { kind: 'until', anchor: remapAnchor(cue.extent.anchor, `/audio_cues/${cue.id}/extent/anchor`) };
    return mapped;
  });
  result.shot_takes = pkg.shot_takes.flatMap(remapTake);
  result.shot_lineage.push({ from_ids: [...targetIds], to_ids: replacements.map(shot => shot.id), revision: pkg.revision.number + 1 });
  warnings.forEach(warning => context.warn?.(warning));
  return result;
}

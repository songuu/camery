import { TimelineError } from './errors';
import { compareKeys, generateOrderKeys, keyBetween } from './order';
import { durationValue, equal, seconds, sum } from './time';

export interface TimelineClip {
  readonly id: string;
  readonly order_key: string;
  readonly duration: { readonly planned: number; readonly measured: number | null };
}

function validateClip(clip: TimelineClip, where: string): void {
  if (typeof clip.id !== 'string' || clip.id.length === 0) throw new TimelineError('INVALID_ID', where + '/id', 'Clip ID must be a nonempty stable identifier');
  if (!Number.isFinite(clip.duration.planned) || clip.duration.planned <= 0 ||
      (clip.duration.measured !== null && (!Number.isFinite(clip.duration.measured) || clip.duration.measured <= 0))) {
    throw new TimelineError('INVALID_DURATION', where + '/duration', `Clip ${clip.id} requires finite positive planned/measured durations`);
  }
}

function sortedClips<T extends TimelineClip>(clips: readonly T[]): T[] {
  const identifiers = new Set<string>();
  const keys = new Set<string>();
  clips.forEach((clip, index) => {
    validateClip(clip, `/clips/${index}`);
    if (identifiers.has(clip.id)) throw new TimelineError('DUPLICATE_ID', `/clips/${index}/id`, `Clip ID ${clip.id} is duplicated`);
    if (keys.has(clip.order_key)) throw new TimelineError('DUPLICATE_ORDER_KEY', `/clips/${index}/order_key`, `Order key ${clip.order_key} is duplicated`);
    // Validate singleton sequences too; sorting alone need not invoke a comparator.
    compareKeys(clip.order_key, clip.order_key);
    identifiers.add(clip.id);
    keys.add(clip.order_key);
  });
  return [...clips].sort((a, b) => compareKeys(a.order_key, b.order_key));
}

function requireIndex(clips: readonly TimelineClip[], id: string, where: string): number {
  const index = clips.findIndex(c => c.id === id);
  if (index < 0) throw new TimelineError('MISSING_CLIP', where, `Clip ${id} does not exist in this sequence`);
  return index;
}

function validateNewClips(clips: readonly TimelineClip[], incoming: readonly TimelineClip[]): void {
  const identifiers = new Set(clips.map(c => c.id));
  incoming.forEach((clip, index) => {
    validateClip(clip, `/incoming/${index}`);
    if (identifiers.has(clip.id)) throw new TimelineError('DUPLICATE_ID', `/incoming/${index}/id`, `New clip ID ${clip.id} is already active`);
    identifiers.add(clip.id);
  });
}

function place<T extends TimelineClip>(clips: readonly T[], clip: T, at: number): T[] {
  const key = keyBetween(clips[at - 1]?.order_key ?? null, clips[at]?.order_key ?? null);
  const result = [...clips];
  result.splice(at, 0, key === null ? clip : { ...clip, order_key: key });
  if (key !== null) return result;
  // Prefix-adjacent keys (A/A0) have no legal intermediary; rebalance keys, never object IDs.
  const keys = generateOrderKeys(result.length);
  return result.map((row, index) => ({ ...row, order_key: keys[index]! }));
}

function assertConservation(source: readonly TimelineClip[], replacement: readonly TimelineClip[]): void {
  const planned = (rows: readonly TimelineClip[]) => sum(rows.map(c => seconds(c.duration.planned)));
  if (!equal(planned(source), planned(replacement))) throw new TimelineError('DURATION_MISMATCH', '/duration/planned', 'Split/merge must preserve total planned duration');
  const allMeasured = source.every(c => c.duration.measured !== null);
  if (replacement.some(c => (c.duration.measured !== null) !== allMeasured)) throw new TimelineError('MEASUREMENT_CONFLICT', '/duration/measured', 'Split/merge cannot invent or discard complete measured timing');
  // A mixed measured/planned merge may not silently discard a known duration correction.
  if (!equal(sum(source.map(c => durationValue(c.duration))), sum(replacement.map(c => durationValue(c.duration))))) {
    throw new TimelineError('MEASUREMENT_CONFLICT', '/duration/measured', 'Split/merge must preserve effective duration as well as planned duration');
  }
}

/** The incoming order_key is a draft; placement chooses its authoritative key. */
export function insertClip<T extends TimelineClip>(clips: readonly T[], clip: T, beforeId: string | null): T[] {
  const sorted = sortedClips(clips);
  validateNewClips(sorted, [clip]);
  const at = beforeId === null ? sorted.length : requireIndex(sorted, beforeId, '/before_id');
  return place(sorted, clip, at);
}

export function moveClip<T extends TimelineClip>(clips: readonly T[], id: string, beforeId: string | null): T[] {
  const sorted = sortedClips(clips);
  const source = requireIndex(sorted, id, '/target_id');
  const destination = beforeId === null ? sorted.length : requireIndex(sorted, beforeId, '/before_id');
  if (source === destination || source + 1 === destination) return sorted;
  const moving = sorted[source]!;
  sorted.splice(source, 1);
  return place(sorted, moving, destination > source ? destination - 1 : destination);
}

export function splitClip<T extends TimelineClip>(clips: readonly T[], targetId: string, pieces: readonly T[]): T[] {
  const sorted = sortedClips(clips);
  const index = requireIndex(sorted, targetId, '/target_id');
  if (pieces.length < 2) throw new TimelineError('SPLIT_PARTS', '/pieces', 'A split requires at least two replacement clips');
  validateNewClips(sorted, pieces);
  assertConservation([sorted[index]!], pieces);
  sorted.splice(index, 1);
  let result = sorted;
  pieces.forEach((piece, offset) => { result = place(result, piece, index + offset); });
  return result;
}

export function mergeClips<T extends TimelineClip>(clips: readonly T[], orderedTargetIds: readonly string[], into: T): T[] {
  const sorted = sortedClips(clips);
  if (orderedTargetIds.length < 2) throw new TimelineError('MERGE_TARGETS', '/target_ids', 'A merge requires at least two ordered adjacent targets');
  const indices = orderedTargetIds.map(id => requireIndex(sorted, id, '/target_ids'));
  const first = indices[0]!;
  if (indices.some((index, offset) => index !== first + offset)) throw new TimelineError('MERGE_ADJACENCY', '/target_ids', 'Merge targets must be unique, adjacent and in timeline order');
  validateNewClips(sorted, [into]);
  assertConservation(sorted.slice(first, first + indices.length), [into]);
  sorted.splice(first, indices.length);
  return place(sorted, into, first);
}

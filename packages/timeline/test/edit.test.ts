import { describe, expect, it } from 'vitest';
import { insertClip, mergeClips, moveClip, splitClip } from '../src/edit';
import type { TimelineClip } from '../src/edit';

const clip = (id: string, key: string, planned = 2, measured: number | null = null) => ({
  id, order_key: key, duration: { planned, measured }, payload: { label: id },
});
const baseline = () => Object.freeze([clip('a', 'A'), clip('b', 'B'), clip('c', 'C')].map(c => Object.freeze({ ...c, duration: Object.freeze(c.duration), payload: Object.freeze(c.payload) })));
const ids = (clips: readonly TimelineClip[]) => clips.map(c => c.id);

describe('pure clip insertion and movement', () => {
  it('inserts before a stable ID and retains payload', () => {
    const input = baseline();
    const result = insertClip(input, clip('x', 'ignored'), 'b');
    expect(ids(result)).toEqual(['a', 'x', 'b', 'c']);
    expect(result[1]!.payload).toEqual({ label: 'x' });
    expect(ids(input)).toEqual(['a', 'b', 'c']);
    expect(result[0]!.order_key).toBe('A');
    expect(result[2]!.order_key).toBe('B');
  });

  it('handles insertion into an empty sequence and appending', () => {
    expect(ids(insertClip([], clip('x', 'A'), null))).toEqual(['x']);
    expect(ids(insertClip(baseline(), clip('x', 'A'), null))).toEqual(['a', 'b', 'c', 'x']);
  });

  it('sorts unordered snapshots and moves without changing identity or duration', () => {
    const input = baseline();
    const result = moveClip([input[2]!, input[0]!, input[1]!], 'c', 'a');
    expect(ids(result)).toEqual(['c', 'a', 'b']);
    expect(result[0]!.duration).toEqual(input[2]!.duration);
    expect(ids(moveClip(input, 'a', null))).toEqual(['b', 'c', 'a']);
    expect(ids(input)).toEqual(['a', 'b', 'c']);
  });

  it('keeps keys stable for a move to the current slot', () => {
    expect(moveClip(baseline(), 'a', 'a')).toEqual(baseline());
    expect(moveClip(baseline(), 'a', 'b')).toEqual(baseline());
    expect(moveClip(baseline(), 'c', null)).toEqual(baseline());
  });

  it('rebalances exhausted keys while preserving order and identity', () => {
    const input = [clip('a', 'A'), clip('b', 'A0')];
    const result = insertClip(input, clip('x', 'A'), 'b');
    expect(ids(result)).toEqual(['a', 'x', 'b']);
    expect(new Set(result.map(c => c.order_key)).size).toBe(3);
    expect(input.map(c => c.order_key)).toEqual(['A', 'A0']);
    expect(ids(insertClip([clip('a', '0')], clip('x', 'A'), 'a'))).toEqual(['x', 'a']);
  });

  it.each([
    () => insertClip(baseline(), clip('a', 'Z'), null),
    () => insertClip(baseline(), clip('x', 'Z'), 'missing'),
    () => moveClip(baseline(), 'missing', null),
    () => moveClip(baseline(), 'a', 'missing'),
    () => insertClip([clip('a', 'A'), clip('a', 'B')], clip('x', 'X'), null),
    () => moveClip([clip('a', 'A'), clip('b', 'A')], 'a', null),
    () => insertClip(baseline(), clip('', 'A'), null),
    () => insertClip(baseline(), clip('x', 'A', 0), null),
    () => insertClip(baseline(), clip('x', 'A', Infinity), null),
    () => insertClip(baseline(), clip('x', 'A', 1, -1), null),
    () => insertClip(baseline(), clip('x', 'A', 1, NaN), null),
  ])('rejects invalid edits with contextual errors', edit => {
    expect(edit).toThrow();
    try { edit(); } catch (error) { expect(error).toHaveProperty('where'); }
  });
});

describe('duration-preserving split and merge', () => {
  it('splits using caller-provided new IDs and recombines adjacent pieces', () => {
    const input = baseline();
    const split = splitClip(input, 'b', [clip('b1', 'A', 0.5), clip('b2', 'A', 1.5)]);
    expect(ids(split)).toEqual(['a', 'b1', 'b2', 'c']);
    const merged = mergeClips(split, ['b1', 'b2'], clip('joined', 'A'));
    expect(ids(merged)).toEqual(['a', 'joined', 'c']);
    expect(merged[1]!.duration).toEqual(input[1]!.duration);
    expect(ids(input)).toEqual(['a', 'b', 'c']);
  });

  it('uses exact decimal sums rather than rejecting 0.1 + 0.2 = 0.3', () => {
    const source = [clip('a', 'A', 0.3, 0.3)];
    const parts = splitClip(source, 'a', [clip('a1', 'A', 0.1, 0.1), clip('a2', 'A', 0.2, 0.2)]);
    expect(mergeClips(parts, ['a1', 'a2'], clip('merged', 'A', 0.3, 0.3))[0]!.duration).toEqual(source[0]!.duration);
  });

  it('preserves separate planned and measured totals', () => {
    const parts = splitClip([clip('a', 'A', 4, 6)], 'a', [clip('a1', 'A', 1, 2), clip('a2', 'A', 3, 4)]);
    expect(mergeClips(parts, ['a1', 'a2'], clip('a3', 'A', 4, 6))[0]!.duration.measured).toBe(6);
  });

  it('does not invent measured timing from a partially measured merge', () => {
    const input = [clip('a', 'A', 2, 2), clip('b', 'B', 2)];
    expect(mergeClips(input, ['a', 'b'], clip('c', 'C', 4))[0]!.duration.measured).toBeNull();
    expect(() => mergeClips(input, ['a', 'b'], clip('c', 'C', 4, 4))).toThrow();
    expect(() => mergeClips([clip('a', 'A', 2, 3), clip('b', 'B', 2)], ['a', 'b'], clip('c', 'C', 4))).toThrow();
  });

  it.each([
    () => splitClip(baseline(), 'missing', [clip('x', 'A', 1), clip('y', 'A', 1)]),
    () => splitClip(baseline(), 'a', [clip('x', 'A')]),
    () => splitClip(baseline(), 'a', [clip('a', 'A', 1), clip('y', 'A', 1)]),
    () => splitClip(baseline(), 'a', [clip('x', 'A', 1), clip('x', 'A', 1)]),
    () => splitClip(baseline(), 'a', [clip('x', 'A', 1), clip('y', 'A', 2)]),
    () => splitClip(baseline(), 'a', [clip('x', 'A', 1, 1), clip('y', 'A', 1, 1)]),
    () => splitClip([clip('a', 'A', 2, 3)], 'a', [clip('x', 'A', 1), clip('y', 'A', 1)]),
    () => splitClip([clip('a', 'A', 2, 3)], 'a', [clip('x', 'A', 1, 1), clip('y', 'A', 1, 1)]),
    () => mergeClips(baseline(), ['a'], clip('x', 'A')),
    () => mergeClips(baseline(), ['a', 'missing'], clip('x', 'A', 4)),
    () => mergeClips(baseline(), ['a', 'a'], clip('x', 'A', 4)),
    () => mergeClips(baseline(), ['b', 'a'], clip('x', 'A', 4)),
    () => mergeClips(baseline(), ['a', 'c'], clip('x', 'A', 4)),
    () => mergeClips(baseline(), ['a', 'b'], clip('a', 'A', 4)),
    () => mergeClips(baseline(), ['a', 'b'], clip('c', 'A', 4)),
    () => mergeClips(baseline(), ['a', 'b'], clip('x', 'A', 3)),
  ])('rejects identity, adjacency or conservation violations', edit => {
    expect(edit).toThrow();
  });
});

import { expect, it } from 'vitest';
import { insertClip, mergeClips, moveClip, splitClip } from '../src/edit';
import { compareKeys } from '../src/order';

it('preserves identity, payload, order and duration over 10,000 seeded edit scenarios', () => {
  let state = 0x59d52e31;
  const random = (max: number) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % max;
  };
  let trials = 0;
  for (; trials < 10_000; trials++) {
    const measured = random(2) === 1;
    const make = (id: string, planned: number) => ({
      id, order_key: id, duration: { planned, measured: measured ? planned : null }, payload: { trial: trials, marker: id },
    });
    const original = [make('A', 2 + random(20)), make('B', 2 + random(20)), make('C', 2 + random(20))];
    const frozen = Object.freeze(original.map(c => Object.freeze({ ...c, duration: Object.freeze(c.duration), payload: Object.freeze(c.payload) })));
    const originalSeconds = original.reduce((total, c) => total + c.duration.planned, 0);
    const inserted = make('X', 2 + random(20));
    const insertIndex = random(4);
    let expected = original.map(c => c.id);
    let result = insertClip(frozen, inserted, expected[insertIndex] ?? null);
    expected.splice(insertIndex, 0, 'X');
    const source = random(4);
    const moving = expected[source]!;
    expected.splice(source, 1);
    const destination = random(4);
    result = moveClip(result, moving, expected[destination] ?? null);
    expected.splice(destination, 0, moving);
    expect(result.map(c => c.id), `seeded scenario ${trials}`).toEqual(expected);

    const splitting = random(4);
    const target = result[splitting]!;
    const left = make('Y', target.duration.planned / 2);
    const right = make('Z', target.duration.planned / 2);
    result = splitClip(result, target.id, [left, right]);
    expected.splice(splitting, 1, 'Y', 'Z');
    expect(result.map(c => c.id)).toEqual(expected);
    const combined = make('J', target.duration.planned);
    result = mergeClips(result, ['Y', 'Z'], combined);
    expected.splice(splitting, 2, 'J');

    expect(result.map(c => c.id)).toEqual(expected);
    expect(new Set(result.map(c => c.id)).size).toBe(result.length);
    expect([...result].sort((a, b) => compareKeys(a.order_key, b.order_key))).toEqual(result);
    expect(result.reduce((total, c) => total + c.duration.planned, 0)).toBe(originalSeconds + inserted.duration.planned);
    expect(result.every(c => measured ? c.duration.measured === c.duration.planned : c.duration.measured === null)).toBe(true);
    expect(result.every(c => c.payload.trial === trials && c.payload.marker === c.id)).toBe(true);
    expect(frozen.map(c => c.id)).toEqual(['A', 'B', 'C']);
  }
  expect(trials).toBe(10_000);
}, 30_000);

import { describe, expect, it } from 'vitest';
import { compareKeys, generateOrderKeys, keyBetween } from '../src/order';

describe('ASCII base62 order keys', () => {
  it('orders digits, uppercase and lowercase without locale collation', () => {
    expect(['a0', 'Z', 'A', '9', 'a', 'A0'].sort(compareKeys)).toEqual(['9', 'A', 'A0', 'Z', 'a', 'a0']);
    expect(compareKeys('A', 'A')).toBe(0);
  });

  it.each(['', '-', '中', 'a b', 'é'])('rejects malformed key %s', value => {
    expect(() => compareKeys(value, 'a')).toThrow();
    expect(() => compareKeys('a', value)).toThrow();
  });

  it.each([
    [null, null], [null, 'A'], [null, '0A'], ['a', null], ['A', 'B'], ['A', 'C'], ['A', 'AZ'], ['A', 'A00'], ['A0', 'A1'], ['AZ', 'B'],
  ] as const)('finds a key between %s and %s', (lower, upper) => {
    const key = keyBetween(lower, upper);
    expect(key).not.toBeNull();
    expect(key).toMatch(/^[0-9A-Za-z]+$/);
    if (lower !== null) expect(compareKeys(lower, key!)).toBeLessThan(0);
    if (upper !== null) expect(compareKeys(key!, upper)).toBeLessThan(0);
  });

  it('signals prefix exhaustion instead of returning a duplicate key', () => {
    expect(keyBetween(null, '0')).toBeNull();
    expect(keyBetween('A', 'A0')).toBeNull();
  });

  it.each([['B', 'A'], ['A', 'A']] as const)('rejects invalid bounds %s/%s', (lower, upper) => {
    expect(() => keyBetween(lower, upper)).toThrow();
  });

  it('generates deterministic, unique sorted rebalance keys', () => {
    const keys = generateOrderKeys(500);
    expect(keys).toHaveLength(500);
    expect(new Set(keys).size).toBe(500);
    expect([...keys].sort(compareKeys)).toEqual(keys);
    expect(generateOrderKeys(500)).toEqual(keys);
    expect(generateOrderKeys(0)).toEqual([]);
  });

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])('rejects invalid sequence size %s', count => {
    expect(() => generateOrderKeys(count)).toThrow();
  });
});

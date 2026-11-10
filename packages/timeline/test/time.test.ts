import { describe, expect, it } from 'vitest';
import { add, compare, durationValue, equal, rational, seconds, subtract, sum, toSeconds } from '../src/time';
import { TimelineError } from '../src/errors';

describe('exact relative time', () => {
  it('preserves decimal and rational time instead of accumulating float drift', () => {
    expect(equal(add(seconds(0.1), seconds(0.2)), seconds(0.3))).toBe(true);
    expect(rational(4n, -6n)).toEqual({ numerator: -2n, denominator: 3n });
    expect(rational(0n, -7n)).toEqual({ numerator: 0n, denominator: 1n });
    expect(compare(seconds(-1), seconds(0))).toBe(-1);
    expect(compare(seconds(1), seconds(0))).toBe(1);
    expect(compare(seconds(0), seconds(0))).toBe(0);
    expect(toSeconds(subtract(seconds(2), seconds(0.5)))).toBe(1.5);
    expect(toSeconds(sum([seconds(0.1), seconds(0.2)]))).toBe(0.3);
    expect(toSeconds(sum([]))).toBe(0);
  });

  it.each([1e-7, 1e21, -1e-21, Number.MIN_VALUE, Number.MAX_VALUE, -0])('round trips finite seconds %s', input => {
    expect(toSeconds(seconds(input))).toBe(input === 0 ? 0 : input);
  });

  it('keeps a small increment on a fraction beyond Number numerator range', () => {
    expect(toSeconds(add(seconds(0.1), seconds(Number.MIN_VALUE)))).toBe(0.1);
  });

  it.each([NaN, Infinity, -Infinity])('rejects nonfinite time %s', input => {
    expect(() => seconds(input)).toThrow(TimelineError);
  });

  it('rejects division by zero and lossy numeric export', () => {
    expect(() => rational(1n, 0n)).toThrow(/TIME_DENOMINATOR/);
    expect(() => toSeconds(add(seconds(Number.MAX_VALUE), seconds(Number.MAX_VALUE)))).toThrow(/TIME_OVERFLOW/);
    expect(() => toSeconds(rational(1n, 10n ** 1000n))).toThrow(/TIME_UNDERFLOW/);
    expect(() => toSeconds(rational((1n << 1024n) - (1n << 970n)))).toThrow(/TIME_OVERFLOW/);
  });

  it('rounds exact binary midpoints to even and preserves tiny remainders', () => {
    const scale = 10n ** 400n;
    const middle = rational((1n << 53n) + 1n, 1n << 53n);
    const epsilon = rational(1n, scale);
    expect(toSeconds(middle)).toBe(1);
    expect(toSeconds(add(middle, epsilon))).toBe(1 + Number.EPSILON);
    expect(toSeconds(subtract(middle, epsilon))).toBe(1);
    expect(toSeconds(rational((1n << 53n) + 3n, 1n << 53n))).toBe(1 + 2 * Number.EPSILON);
    expect(toSeconds(rational(-((1n << 53n) + 3n), 1n << 53n))).toBe(-1 - 2 * Number.EPSILON);
    const halfMinimum = rational(1n, 1n << 1075n);
    expect(() => toSeconds(halfMinimum)).toThrow(/TIME_UNDERFLOW/);
    expect(toSeconds(add(halfMinimum, rational(1n, 10n ** 500n)))).toBe(Number.MIN_VALUE);
  });

  it('uses measured duration when present and rejects invalid declared durations', () => {
    expect(toSeconds(durationValue({ planned: 5, measured: 3 }))).toBe(3);
    expect(toSeconds(durationValue({ planned: 5, measured: null }))).toBe(5);
    expect(() => durationValue({ planned: 0, measured: null })).toThrow(/DURATION/);
    expect(() => durationValue({ planned: 5, measured: 0 })).toThrow(/DURATION/);
    expect(() => durationValue({ planned: -5, measured: 3 })).toThrow(/DURATION/);
  });
});

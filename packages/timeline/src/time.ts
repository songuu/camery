import { TimelineError } from './errors';

export interface Rational { readonly numerator: bigint; readonly denominator: bigint }

export function rational(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new TimelineError('TIME_DENOMINATOR', '/time', 'A rational denominator cannot be zero');
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
  let a = numerator < 0n ? -numerator : numerator;
  let b = denominator;
  while (b !== 0n) { const rest = a % b; a = b; b = rest; }
  return { numerator: numerator / a, denominator: denominator / a };
}

/** 将边界声明的十进制秒精确转换，避免 0.1 + 0.2 引入累计漂移。 */
export function seconds(value: number): Rational {
  if (!Number.isFinite(value)) throw new TimelineError('TIME_FINITE', '/time', 'Seconds must be finite');
  const [mantissa, exponent = '0'] = value.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  const scale = fraction.length - Number(exponent);
  const numerator = BigInt(whole! + fraction);
  return scale >= 0 ? rational(numerator, 10n ** BigInt(scale)) : rational(numerator * 10n ** BigInt(-scale));
}

export function add(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}

export function subtract(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
}

export function compare(a: Rational, b: Rational): -1 | 0 | 1 {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function equal(a: Rational, b: Rational): boolean { return compare(a, b) === 0; }

export function sum(values: Iterable<Rational>): Rational {
  let total = rational(0n);
  for (const value of values) total = add(total, value);
  return total;
}

export function durationValue(duration: { planned: number; measured: number | null }): Rational {
  if (!(duration.planned > 0) || (duration.measured !== null && !(duration.measured > 0)))
    throw new TimelineError('DURATION', '/duration', 'Planned and supplied measured durations must be positive');
  seconds(duration.planned);
  return seconds(duration.measured ?? duration.planned);
}

/** 仅在展示/导出时转回 Number；精确舍入到 IEEE-754，不能截断十进制中点后的余量。 */
export function toSeconds(value: Rational): number {
  const normalized = rational(value.numerator, value.denominator);
  const sign = normalized.numerator < 0n ? -1 : 1;
  const n = normalized.numerator < 0n ? -normalized.numerator : normalized.numerator;
  if (n === 0n) return 0;
  const d = normalized.denominator;
  let exponent = n.toString(2).length - d.toString(2).length;
  if (exponent >= 0 ? n < (d << BigInt(exponent)) : (n << BigInt(-exponent)) < d) exponent--;
  if (exponent > 1023) throw new TimelineError('TIME_OVERFLOW', '/time', 'Exact time exceeds numeric export range');
  // 正常值为53位有效数；非正规值固定为2^-1074的整数倍。
  const power = Math.max(exponent, -1022) - 52;
  const numerator = power < 0 ? n << BigInt(-power) : n;
  const denominator = power < 0 ? d : d << BigInt(power);
  let significand = numerator / denominator;
  const twiceRemainder = 2n * (numerator % denominator);
  if (twiceRemainder > denominator || (twiceRemainder === denominator && significand % 2n !== 0n)) significand++;
  const result = sign * Number(significand) * 2 ** power;
  if (!Number.isFinite(result)) throw new TimelineError('TIME_OVERFLOW', '/time', 'Exact time exceeds numeric export range');
  if (result === 0) throw new TimelineError('TIME_UNDERFLOW', '/time', 'Exact time would be lost at numeric export');
  return result;
}

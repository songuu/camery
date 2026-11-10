import { TimelineError } from './errors';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function assertKey(value: string): void {
  if (!/^[0-9A-Za-z]+$/.test(value)) throw new TimelineError('INVALID_ORDER_KEY', '/order_key', `Expected a nonempty base62 order key, got ${JSON.stringify(value)}`);
}

/** Keys use binary/ASCII order; locale collation would reorder otherwise identical snapshots. */
export function compareKeys(left: string, right: string): number {
  assertKey(left);
  assertKey(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** null means the lexical space is exhausted, so the caller must rebalance the sequence. */
export function keyBetween(lower: string | null, upper: string | null): string | null {
  if (lower !== null) assertKey(lower);
  if (upper !== null) assertKey(upper);
  if (lower === null && upper === null) return 'U';
  if (upper === null) return lower + 'U';
  if (lower === null) {
    const first = ALPHABET.indexOf(upper[0]!);
    if (first > 0) return ALPHABET[Math.floor(first / 2)]!;
    return upper.length > 1 ? '0' : null;
  }
  if (compareKeys(lower, upper) >= 0) throw new TimelineError('ORDER_BOUNDS', '/order_key', 'Lower order key must precede the upper key');
  if (upper.startsWith(lower)) {
    const suffix = upper.slice(lower.length);
    const first = ALPHABET.indexOf(suffix[0]!);
    if (first > 0) return lower + ALPHABET[Math.floor(first / 2)]!;
    return suffix.length > 1 ? lower + '0' : null;
  }
  let index = 0;
  while (lower[index] === upper[index]) index++;
  const low = ALPHABET.indexOf(lower[index]!);
  const high = ALPHABET.indexOf(upper[index]!);
  if (high - low > 1) return lower.slice(0, index) + ALPHABET[Math.floor((low + high) / 2)]!;
  return lower + 'U';
}

/** Eight base62 digits leave spacing even at JavaScript's maximum representable array length. */
export function generateOrderKeys(count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > 0xffffffff) throw new TimelineError('INVALID_SEQUENCE_SIZE', '/clips', 'Sequence size must be a nonnegative JavaScript array length');
  const capacity = 62n ** 8n;
  const stride = capacity / (BigInt(count) + 1n);
  return Array.from({ length: count }, (_unused, index) => {
    let rank = (BigInt(index) + 1n) * stride;
    let key = '';
    for (let digit = 0; digit < 8; digit++) {
      key = ALPHABET[Number(rank % 62n)]! + key;
      rank /= 62n;
    }
    return key;
  });
}

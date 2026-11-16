import { expect, it } from 'vitest';
import { canonicalJson, jsonValue, name, parseJson } from '../src/json.js';
it('clones canonical finite JSON without invoking getters, symbols or exotic objects', () => {
  expect(canonicalJson({ z: [-0, false, null], a: '中' })).toBe('{"a":"中","z":[0,false,null]}');
  const shared = { value: 1 }; expect(jsonValue([shared, shared])).toEqual([{ value: 1 }, { value: 1 }]);
  expect(jsonValue(Object.assign(Object.create(null), { valid: 1 }))).toEqual({ valid: 1 });
  let invoked = false; const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked = true; return 1; } });
  const arrayAccessor = Object.defineProperty([1], '0', { get() { invoked = true; return 1; } });
  const sparse = new Array(1); const misleading = new Array(1); Object.assign(misleading, { extra: 1 });
  const cycle: unknown[] = []; cycle.push(cycle); let deep: unknown = null; for (let i = 0; i < 66; i++) deep = [deep];
  for (const value of [getter, arrayAccessor, sparse, misleading, cycle, deep, Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('x')]: 1 }, NaN, Infinity, undefined, 1n, new Date(), new Map(), { toJSON() { invoked = true; return {}; } }, JSON.parse('{"__proto__":1}')]) expect(() => jsonValue(value)).toThrow();
  expect(invoked).toBe(false);
});
it('rejects duplicate wire keys and unsafe names without interpolating input into errors', () => {
  expect(() => parseJson('{"value":1,"value":2}', 'test decode', 'unknown')).toThrow();
  for (const value of ['', ' ', 'x'.repeat(201), 'x\n', 1]) expect(() => name(value, 'name')).toThrow();
});

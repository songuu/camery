import { describe, expect, it } from 'vitest';
import { canonicalJson, validateActor, validateDuration, validateEnqueue, validateJson, validateKey, validateLease, validateName, validateReconcile, validateSignal, validateStep } from '../src/validation.js';
import { makeTask } from './support.js';

describe('durable boundary values', () => {
  it('canonicalizes JSON, detaches inputs, preserves array order and normalizes negative zero', () => {
    const input = { z: [null, true, false, -0, 2.5], a: { b: 'text' } };
    expect(canonicalJson(input)).toBe('{"a":{"b":"text"},"z":[null,true,false,0,2.5]}');
    expect(validateJson(input)).toEqual(JSON.parse(canonicalJson(input)));
    expect(validateJson(input)).not.toBe(input);
    expect(validateJson(Object.assign(Object.create(null), { ok: 1 }))).toEqual({ ok: 1 });
  });
  it.each([undefined, NaN, Infinity, -Infinity, 1n, () => 0, Symbol('x'), new Date(), new Map(), new Set(), /x/])('rejects non JSON value %s', value => {
    expect(() => validateJson(value)).toThrow();
  });
  it('rejects cycles, sparse arrays, accessors, symbol keys, hidden fields, prototype keys and excessive data', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    let accessed = false;
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { accessed = true; return 1; } });
    for (const value of [cycle, new Array(2), getter, { [Symbol('x')]: 1 }, Object.defineProperty({}, 'x', { value: 1 }), JSON.parse('{"__proto__":1}'), { constructor: 1 }, { prototype: 1 }, 'x'.repeat(1_048_577)]) {
      expect(() => validateJson(value)).toThrow();
    }
    expect(accessed).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 70; i++) deep = [deep];
    expect(() => validateJson(deep)).toThrow();
    const extra = [1]; Object.assign(extra, { hidden: 2 });
    expect(() => validateJson(extra)).toThrow();
  });
  it.each(['', 'a'.repeat(201), 'new\nline', 'tab\t', ' nul\0', 42, null])('rejects invalid names %s', value => {
    expect(() => validateName(value, 'worker')).toThrow();
  });
  it('validates all execution commands and finite dates', () => {
    const task = makeTask();
    validateEnqueue(task); validateKey(task); validateActor('human');
    validateLease({ ...task, owner: 'worker', fence: 1 });
    validateDuration(1, 'delay'); validateDuration(86_400_000, 'delay');
    const spec = { key: 'step', position: 0, kind: 'external' as const, input: {}, fingerprint: 'a'.repeat(64), idempotencyKey: 'camery_x' };
    validateStep(spec);
    validateSignal({ ...task, gateKey: 'gate', signalId: 'signal', actorId: 'human', value: false });
    validateReconcile({ ...task, stepKey: 'step', actorId: 'human', resolution: { kind: 'completed', output: null } });
    validateReconcile({ ...task, stepKey: 'step', actorId: 'human', resolution: { kind: 'retry', reason: 'provider confirmed never accepted' } });
    for (const value of [0, -1, 1.5, NaN, Infinity, 86_400_001, '1']) expect(() => validateDuration(value, 'delay')).toThrow();
    for (const maxAttempts of [0, 101, 1.2]) expect(() => validateEnqueue({ ...task, maxAttempts })).toThrow();
    for (const version of [0, 2_147_483_648, 1.2]) expect(() => validateEnqueue({ ...task, version })).toThrow();
    for (const availableAt of [new Date(NaN), '2026-01-01', null]) expect(() => validateEnqueue({ ...task, availableAt })).toThrow();
    for (const fence of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateLease({ ...task, owner: 'w', fence })).toThrow();
    expect(() => validateKey({ ...task, taskId: '' })).toThrow();
    expect(() => validateActor('')).toThrow();
    expect(() => validateLease({ ...task, owner: '', fence: 1 })).toThrow();
    for (const patch of [{ position: -1 }, { position: 10001 }, { position: .5 }, { kind: 'other' }, { fingerprint: 'oops' }, { idempotencyKey: '' }, { input: undefined }]) expect(() => validateStep({ ...spec, ...patch })).toThrow();
    let coerced = false;
    expect(() => validateStep({ ...spec, kind: { toString() { coerced = true; return 'external'; } } })).toThrow();
    expect(coerced).toBe(false);
    expect(() => validateSignal({ ...task, gateKey: '', signalId: 's', actorId: 'a', value: null })).toThrow();
    expect(() => validateSignal({ ...task, gateKey: 'g', signalId: '', actorId: 'a', value: null })).toThrow();
    expect(() => validateReconcile({ ...task, stepKey: 's', actorId: 'a', resolution: { kind: 'retry', reason: '' } })).toThrow();
    expect(() => validateReconcile({ ...task, stepKey: 's', actorId: 'a', resolution: { kind: 'bad' } })).toThrow();
  });
});

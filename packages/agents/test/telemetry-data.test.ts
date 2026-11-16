import { expect, it } from 'vitest';
import { digest } from '@camery/methods';
import { sanitizeTraceAttributes, traceScopeHashes } from '../src/telemetry-data.js';
it('retains only valid scalar counters, unknown flags and digests, preserving zero and false', () => {
  const input = { 'camery.input_hash': digest('private'), 'camery.tokens': 0, 'camery.cost_known': false, 'camery.charged_cost_micros': Number.MAX_SAFE_INTEGER, 'camery.agent_pin_hash': digest({ pin: 'a'.repeat(64) }), 'camery.execution': 'journal', 'camery.currency': 'CNY', source: 'private' };
  const expected = { ...input } as Record<string, unknown>; delete expected['source']; expect(sanitizeTraceAttributes(input)).toEqual(expected); expect(Object.isFrozen(sanitizeTraceAttributes(input))).toBe(true);
});
it('never evaluates attribute accessors or serializes unknown object values and diagnostics', () => {
  let accessed = 0; const input = Object.defineProperty({ unknown: { toString() { throw new Error('private'); } } }, 'camery.input_hash', { enumerable: true, get: () => { accessed++; return 'private'; } });
  expect(sanitizeTraceAttributes(input)).toEqual({}); expect(accessed).toBe(0); expect(sanitizeTraceAttributes(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); } }))).toEqual({});
  for (const value of [null, undefined, 'private', 1, []]) expect(sanitizeTraceAttributes(value)).toEqual({});
});
it('drops malformed identity, enum, boolean and numeric values rather than coercing them', () => {
  expect(sanitizeTraceAttributes({ 'camery.input_hash': 'private', 'camery.tokens': -1, 'camery.cost_micros': Infinity, 'camery.tokens_known': 'true', 'camery.execution': 'untrusted', 'camery.currency': 'private', 'camery.behavior_steps': Number.MAX_SAFE_INTEGER + 1 })).toEqual({});
});
it('binds project hashes to tenant and rejects malformed scope without invoking accessors', () => {
  expect(traceScopeHashes({ tenantId: 'one', projectId: 'same' }).projectHash).not.toBe(traceScopeHashes({ tenantId: 'two', projectId: 'same' }).projectHash);
  for (const scope of [{ tenantId: '', projectId: 'project' }, { tenantId: 'tenant', projectId: '' }]) expect(() => traceScopeHashes(scope)).toThrow('INVALID_TRACE_SCOPE');
  let accessed = 0; const scope = Object.defineProperty({ projectId: 'project' }, 'tenantId', { enumerable: true, get: () => { accessed++; return 'tenant'; } }); expect(() => traceScopeHashes(scope as never)).toThrow('INVALID_TRACE_SCOPE'); expect(accessed).toBe(0);
});

import { DurableError } from './types.js';
import type { EnqueueTask, Json, Lease, ReconcileInput, SignalInput, StepSpec, TaskKey } from './types.js';

function invalid(label: string): never { throw new DurableError('INVALID_INPUT', `Invalid ${label}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(label);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || !descriptor.enumerable) invalid(label);
  }
  if (Object.getOwnPropertySymbols(value).length) invalid(label);
  return value as Record<string, unknown>;
}
export function validateName(value: unknown, label: string): asserts value is string {
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) invalid(label);
}
export function validateActor(value: unknown): asserts value is string { validateName(value, 'trusted actor identity'); }
export function validateDuration(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 86_400_000) invalid(label);
}
function integer(value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(label);
}
export function validateDate(value: unknown, label: string): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) invalid(label);
}
export function validateJson(value: unknown): Json {
  const seen = new Set<object>();
  function copy(current: unknown, depth: number): Json {
    if (depth > 64) invalid('JSON depth (maximum 64)');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number' && Number.isFinite(current)) return current === 0 ? 0 : current;
    if (typeof current !== 'object' || current === null || seen.has(current)) invalid('finite, acyclic JSON');
    seen.add(current);
    let result: Json;
    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || Object.getOwnPropertySymbols(current).length || Object.keys(current).length !== current.length) invalid('JSON array');
      result = Array.from({ length: current.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(current, index);
        if (!descriptor || !('value' in descriptor)) invalid('dense JSON array');
        return copy(descriptor.value, depth + 1);
      });
    } else {
      const record = object(current, 'plain JSON object');
      const output: { [key: string]: Json } = {};
      for (const key of Object.keys(record).sort()) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid('JSON property name');
        output[key] = copy(record[key], depth + 1);
      }
      result = output;
    }
    seen.delete(current);
    return result;
  }
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_048_576) invalid('JSON size (maximum 1 MiB)');
  return result;
}
export function canonicalJson(value: unknown): string { return JSON.stringify(validateJson(value)); }
export function validateKey(value: unknown): asserts value is TaskKey {
  const input = object(value, 'task key'); validateName(input['tenantId'], 'tenant ID'); validateName(input['taskId'], 'task ID');
}
export function validateEnqueue(value: unknown): asserts value is EnqueueTask {
  validateKey(value); const input = object(value, 'enqueue');
  validateName(input['workflow'], 'workflow'); integer(input['version'], 1, 2_147_483_647, 'workflow version');
  integer(input['maxAttempts'], 1, 100, 'maxAttempts'); validateDate(input['availableAt'], 'availableAt'); validateJson(input['input']);
}
export function validateLease(value: unknown): asserts value is Lease {
  validateKey(value); const input = object(value, 'lease'); validateName(input['owner'], 'worker ID');
  integer(input['fence'], 1, Number.MAX_SAFE_INTEGER, 'lease fence');
}
export function validateStep(value: unknown): asserts value is StepSpec {
  const input = object(value, 'step'); validateName(input['key'], 'step key'); integer(input['position'], 0, 10000, 'step position');
  if (typeof input['kind'] !== 'string' || !['replayable', 'external', 'gate', 'timer'].includes(input['kind'])) invalid('step kind');
  if (typeof input['fingerprint'] !== 'string' || !/^[a-f0-9]{64}$/.test(input['fingerprint'])) invalid('step fingerprint');
  validateName(input['idempotencyKey'], 'idempotency key'); validateJson(input['input']);
}
export function validateSignal(value: unknown): asserts value is SignalInput {
  validateKey(value); const input = object(value, 'signal'); validateName(input['gateKey'], 'gate key');
  validateName(input['signalId'], 'signal ID'); validateActor(input['actorId']); validateJson(input['value']);
}
export function validateReconcile(value: unknown): asserts value is ReconcileInput {
  validateKey(value); const input = object(value, 'reconciliation'); validateName(input['stepKey'], 'step key'); validateActor(input['actorId']);
  const resolution = object(input['resolution'], 'reconciliation resolution');
  if (resolution['kind'] === 'completed') validateJson(resolution['output']);
  else if (resolution['kind'] === 'retry') validateName(resolution['reason'], 'evidence for retry after reconciliation');
  else invalid('reconciliation kind');
}

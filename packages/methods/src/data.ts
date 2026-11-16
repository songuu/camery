import { createHash } from 'node:crypto';
import { parseStrictJson } from '@camery/ir/node';
import type { CallContext, Json, Outcome } from '@camery/model-modes';
export class MethodError extends Error {
  override readonly name = 'MethodError';
  constructor(readonly code: string, readonly operation: string, readonly outcome: Outcome = 'not_applicable') { super(`${code}: ${operation} (${outcome})`); }
}
/** Keep method identities independent of object insertion order, accessors and caller mutation. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): Json => {
    if (depth > 48) throw new MethodError('INVALID_JSON', 'method data depth');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item === 0 ? 0 : item;
    if (!item || typeof item !== 'object' || seen.has(item)) throw new MethodError('INVALID_JSON', 'method data');
    if (Object.getOwnPropertySymbols(item).length || (Array.isArray(item) ? Object.getPrototypeOf(item) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) throw new MethodError('INVALID_JSON', 'method data prototype');
    seen.add(item); const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.entries(descriptors).some(([key, descriptor]) => !(Array.isArray(item) && key === 'length') && (!descriptor.enumerable || !('value' in descriptor)))) throw new MethodError('INVALID_JSON', 'method data properties');
    let result: Json;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) throw new MethodError('INVALID_JSON', 'method data array');
      result = Array.from({ length: item.length }, (_, index) => {
        const entry = descriptors[index]; if (!entry || !('value' in entry)) throw new MethodError('INVALID_JSON', 'method sparse array');
        return visit(entry.value, depth + 1);
      });
    } else {
      const record: Record<string, Json> = {};
      for (const key of Object.keys(descriptors).sort()) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new MethodError('INVALID_JSON', 'method property');
        record[key] = visit(descriptors[key]!.value, depth + 1);
      }
      result = record;
    }
    seen.delete(item); return result;
  };
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text) > 2_097_152) throw new MethodError('DATA_LIMIT', 'method data');
  return text;
}
export function jsonCopy<T>(value: T): T { return parseStrictJson(canonical(value)) as T; }
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function captureContext(supplied: CallContext, operation: string): Readonly<CallContext> {
  const captured = { tenantId: supplied.tenantId, connectionId: supplied.connectionId, modeDigest: supplied.modeDigest, idempotencyKey: supplied.idempotencyKey, signal: supplied.signal };
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
  if ([captured.tenantId, captured.connectionId, captured.idempotencyKey].some(value => typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) || !/^[a-f0-9]{64}$/.test(captured.modeDigest) || !(captured.signal instanceof AbortSignal)) throw new MethodError('INVALID_CONTEXT', operation);
  return Object.freeze(captured);
}
export function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}

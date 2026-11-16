import { createHash } from 'node:crypto';
import { parseStrictJson } from '@camery/ir/node';
import { ModelError } from './types.js';
import type { Json, JsonObject, HttpReply, Outcome } from './types.js';

export function jsonValue(value: unknown): Json {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): Json => {
    if (depth > 64) throw new ModelError('INVALID_JSON', 'input depth', 'not_sent');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item === 0 ? 0 : item;
    if (typeof item !== 'object' || !item || seen.has(item)) throw new ModelError('INVALID_JSON', 'input value', 'not_sent');
    seen.add(item);
    const array = Array.isArray(item);
    if ((!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) || (array && Object.getPrototypeOf(item) !== Array.prototype) || Object.getOwnPropertySymbols(item).length) throw new ModelError('INVALID_JSON', 'input prototype', 'not_sent');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Object.keys(item);
    if ((array && keys.length !== item.length) || Object.entries(descriptors).some(([key, d]) => !(array && key === 'length') && (!d.enumerable || !('value' in d)))) throw new ModelError('INVALID_JSON', 'input properties', 'not_sent');
    let result: Json;
    if (array) result = Array.from({ length: item.length }, (_, index) => {
      const d = descriptors[index];
      if (!d || !('value' in d)) throw new ModelError('INVALID_JSON', 'sparse array', 'not_sent');
      return visit(d.value, depth + 1);
    });
    else {
      const record: JsonObject = {};
      for (const key of keys.sort()) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ModelError('INVALID_JSON', 'input property', 'not_sent');
        record[key] = visit(descriptors[key]!.value, depth + 1);
      }
      result = record;
    }
    seen.delete(item); return result;
  };
  return visit(value, 0);
}
export const canonicalJson = (value: unknown): string => JSON.stringify(jsonValue(value));
export const digest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function parseJson(text: string, operation: string, outcome: Outcome): Json {
  try { return jsonValue(parseStrictJson(text)); }
  catch { throw new ModelError('INVALID_JSON', operation, outcome); }
}
export function object(value: Json, operation: string, outcome: Outcome): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ModelError('INVALID_RESPONSE', operation, outcome);
  return value;
}
export function name(value: unknown, operation: string): asserts value is string {
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new ModelError('INVALID_INPUT', operation, 'not_sent');
}
export function responseJson(reply: HttpReply, operation: string, effect: 'read' | 'submit'): Json {
  if (reply.status < 200 || reply.status >= 300) {
    const code = reply.status === 429 ? 'RATE_LIMITED' : reply.status === 401 || reply.status === 403 ? 'AUTH_FAILED' : reply.status >= 500 ? 'REMOTE_FAILURE' : 'HTTP_ERROR';
    throw new ModelError(code, operation, effect === 'read' ? 'not_applicable' : reply.status >= 400 && reply.status < 500 ? 'rejected' : 'unknown', reply.status);
  }
  if (reply.body.kind !== 'json') throw new ModelError('INVALID_RESPONSE', operation, effect === 'read' ? 'not_applicable' : 'unknown');
  return jsonValue(reply.body.value);
}

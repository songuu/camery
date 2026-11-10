import type { StoryboardPackage } from '@camery/ir';
import { VersioningError } from './errors';
import type { VersionState } from './types';

export interface VersionedObject extends Record<string, unknown> { id: string; version: number }
export interface LocatedObject { collection: string; value: VersionedObject }

/** 仅枚举 schema 已验证的版本对象，位置 spot 等非版本 ID 仍由全包唯一性检查保护。 */
export function objects(pkg: StoryboardPackage): Map<string, LocatedObject> {
  const result = new Map<string, LocatedObject>();
  for (const [collection, rows] of Object.entries(pkg)) if (Array.isArray(rows)) for (const value of rows) {
    if (value !== null && typeof value === 'object' && 'id' in value && 'version' in value)
      result.set(value.id, { collection, value: value as VersionedObject });
  }
  return result;
}

export function identityOwners(pkg: StoryboardPackage): Map<string, string> {
  const result = new Map([...objects(pkg)].map(([id, row]) => [id, row.collection]));
  result.set(pkg.package_id, 'package'); result.set(pkg.project.id, 'project');
  for (const location of pkg.locations) for (const spot of location.spots) result.set(spot.id, 'locations/' + location.id + '/spots');
  return result;
}

export function historicalIds(state: VersionState): Set<string> {
  const result = new Set(identityOwners(state.head).keys());
  for (const revision of state.revisions) {
    result.add(revision.object_id);
    if (revision.collection === 'locations' && Array.isArray(revision.value?.spots)) for (const spot of revision.value.spots) {
      if (spot && typeof spot === 'object' && 'id' in spot && typeof spot.id === 'string') result.add(spot.id);
    }
  }
  return result;
}

export function jsonSignature(input: unknown): string {
  const keys = new Set<string>();
  const queue: unknown[] = [input];
  const seen = new Set<object>();
  for (let i = 0; i < queue.length; i++) {
    const value = queue[i];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    if (typeof value !== 'object' || value === null) throw new VersioningError('NON_JSON', '/change', 'Change values must be finite JSON data');
    if (seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) { for (const item of value) queue.push(item); continue; }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new VersioningError('NON_JSON', '/change', 'Change values must be plain JSON objects');
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new VersioningError('UNSAFE_FIELD', '/change', 'Prototype-related fields are forbidden');
      keys.add(key); queue.push(item);
    }
  }
  // 字段白名单仅用于稳定排序；已收集整棵树的字段，不丢弃原请求数据。
  try { return JSON.stringify(input, [...keys].sort()); }
  catch { throw new VersioningError('NON_JSON', '/change', 'Cyclic or excessively nested values cannot be serialized as a ChangeSet'); }
}

export function changedFields(before: unknown, after: unknown, prefix = ''): string[] {
  if (jsonSignature(before) === jsonSignature(after)) return [];
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object' || Array.isArray(before) || Array.isArray(after)) return [prefix];
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!(key in left) || !(key in right)) fields.push(path);
    else fields.push(...changedFields(left[key], right[key], path));
  }
  return fields;
}

export function overlapsField(lock: string, changed: string): boolean {
  return changed === '' || lock === changed || lock.startsWith(changed + '.') || changed.startsWith(lock + '.');
}

export function nextVersion(value: number): number {
  if (!Number.isSafeInteger(value + 1)) throw new VersioningError('VERSION_OVERFLOW', '/version', 'Revision exceeds the safe integer range');
  return value + 1;
}

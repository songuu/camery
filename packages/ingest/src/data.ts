import { createHash } from 'node:crypto';
import { ImportError } from './types.js';
import type { ImportUnit } from './types.js';
export const MAX_DOCUMENT_CHARACTERS = 16_000_000;
export const MAX_BATCH_CHARACTERS = 1_000_000;
/** Shared references can still explode when serialized; count logical projection strings before appending units. */
export function createProjectionBudget(): (unit: ImportUnit) => ImportUnit {
  let characters = 0;
  return unit => {
    characters += unit.title.length + (unit.speaker?.length ?? 0);
    for (const [key, value] of Object.entries(unit.fields ?? {})) characters += key.length + value.length;
    if (characters > MAX_DOCUMENT_CHARACTERS) throw new ImportError('INPUT_LIMIT', 'projection metadata');
    return unit;
  };
}
export function textDigest(input: string | Uint8Array): string { return createHash('sha256').update(input).digest('hex'); }
export function validateText(input: unknown, operation = 'text', max = MAX_DOCUMENT_CHARACTERS): asserts input is string {
  if (typeof input !== 'string' || !input.length || !input.isWellFormed() || input.includes('\0')) throw new ImportError('INVALID_INPUT', operation);
  if (input.length > max) throw new ImportError('INPUT_LIMIT', operation);
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

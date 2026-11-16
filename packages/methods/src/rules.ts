import type { Json } from '@camery/model-modes';
import { digest } from './data.js';
import type { MethodPack } from './schema.js';
export function validateMethodRules(pack: MethodPack, input: Json, output: Json): boolean {
  return pack.rules.every(rule => rule.kind === 'chapter-coverage' && chapterCoverage(input, output));
}
function chapterCoverage(input: Json, output: Json): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input['text'] !== 'string' || !output || typeof output !== 'object' || Array.isArray(output) || !Array.isArray(output['chapters'])) return false;
  if (output['sourceDigest'] !== digest(input['text']) || output['offsetUnit'] !== 'utf16') return false;
  let position = 0;
  for (const value of output['chapters']) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value['start'] !== position || !Number.isSafeInteger(value['end']) || typeof value['end'] !== 'number' || value['end'] <= position || value['end'] > input['text'].length) return false;
    position = value['end'];
  }
  return position === input['text'].length && output['chapters'].length > 0;
}

import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseStrictJson } from '@camery/ir/node';
import { jsonCopy, MethodError } from '../data.js';
import { validateEvaluationSuite } from '../evaluation.js';
import { MethodRegistry } from '../registry.js';
import { Pack } from '../schema.js';
import type { MethodPack } from '../schema.js';

const FILE_LIMIT = 1_048_576;
const BUNDLE_LIMIT = 2_097_152;
const paths = (category: string) => z.array(z.string().regex(new RegExp(`^${category}/[A-Za-z0-9][A-Za-z0-9_.-]*\\.json$`))).max(32).refine(files => new Set(files).size === files.length);
const FileManifest = z.strictObject({
  ...Pack.shape.manifest.shape,
  files: z.strictObject({ instructions: z.literal('instructions.md'), rules: paths('rules'), examples: paths('examples'), cards: paths('cards'), evals: paths('evals') }),
});
function within(root: string, actual: string): boolean {
  const relative = path.relative(root, actual);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.ino > 0n && left.dev >= 0n; }
function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean { return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs; }
export function parseDataJson(source: string): unknown {
  try { return parseStrictJson(source); }
  catch { throw new MethodError('PACK_JSON', 'method pack JSON'); }
}

/** Shared bounded reader. Identity checks detect observed races; this is not an OS sandbox against hostile directory rewrites. */
export async function dataDirectoryReader(directory: string): Promise<{ readonly root: string; read(relative: string): Promise<string> }> {
  let root: string;
  try { root = await realpath(directory); if (!(await stat(root)).isDirectory()) throw new Error(); }
  catch { throw new MethodError('PACK_ROOT', 'method pack directory'); }
  let total = 0;
  const ancestors = async (relative: string): Promise<void> => {
    let current = root;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      if ((await lstat(current)).isSymbolicLink()) throw new MethodError('PACK_PATH', 'method pack asset');
    }
  };
  const read = async (relative: string): Promise<string> => {
    try {
      if (typeof relative !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/.test(relative)) throw new MethodError('PACK_PATH', 'method pack relative asset');
      const candidate = path.join(root, relative);
      await ancestors(relative);
      const actual = await realpath(candidate);
      if (!within(root, actual)) throw new MethodError('PACK_PATH', 'method pack asset');
      if (!(await lstat(actual)).isFile()) throw new MethodError('PACK_FILE', 'method pack asset');
      const handle = await open(actual, 'r');
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.ino <= 0n || before.dev < 0n) throw new MethodError('PACK_FILE', 'method pack asset identity');
        if (before.size > BigInt(FILE_LIMIT)) throw new MethodError('PACK_FILE_LIMIT', 'method pack asset');
        if (BigInt(total) + before.size > BigInt(BUNDLE_LIMIT)) throw new MethodError('PACK_BUNDLE_LIMIT', 'method pack bundle');
        const atOpen = await realpath(candidate);
        if (!within(root, atOpen) || !sameIdentity(before, await stat(atOpen, { bigint: true }))) throw new MethodError('PACK_CHANGED', 'method pack asset identity');
        let size = 0; const chunks: Buffer[] = [];
        // No encoding is configured: Node emits byte buffers, so byte limits remain independent of Unicode length.
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65_536 })) {
          size += chunk.length; total += chunk.length;
          if (size > FILE_LIMIT) throw new MethodError('PACK_FILE_LIMIT', 'method pack asset');
          if (total > BUNDLE_LIMIT) throw new MethodError('PACK_BUNDLE_LIMIT', 'method pack bundle');
          chunks.push(chunk);
        }
        await ancestors(relative);
        const afterPath = await realpath(candidate); const after = await handle.stat({ bigint: true });
        if (!within(root, afterPath) || !sameSnapshot(before, after) || !sameIdentity(after, await stat(afterPath, { bigint: true })) || BigInt(size) !== before.size) throw new MethodError('PACK_CHANGED', 'method pack asset snapshot');
        try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
        catch { throw new MethodError('PACK_UTF8', 'method pack asset encoding'); }
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof MethodError) throw error;
      throw new MethodError('PACK_FILE', 'method pack asset');
    }
  };
  return Object.freeze({ root, read });
}

/** Method files retain their narrower allowlist when sharing the data-directory IO boundary. */
export async function methodPackReader(directory: string): Promise<{ readonly root: string; read(relative: string): Promise<string> }> {
  const reader = await dataDirectoryReader(directory);
  return Object.freeze({ root: reader.root, async read(relative: string): Promise<string> {
    if (typeof relative !== 'string' || !/^(?:pack\.yaml|instructions\.md|(?:rules|examples|cards|evals)\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json)$/.test(relative)) throw new MethodError('PACK_PATH', 'method pack relative asset');
    return reader.read(relative);
  } });
}

/** Loads only declared method data, using the same boundary as baseline reads. */
export async function loadMethodPack(directory: string): Promise<MethodPack> {
  const reader = await methodPackReader(directory);
  const read = reader.read.bind(reader);
  const manifestResult = FileManifest.safeParse(jsonCopy(parseDataJson(await read('pack.yaml'))));
  if (!manifestResult.success) throw new MethodError('INVALID_PACK_FILE', 'method pack metadata');
  const { files, ...manifest } = manifestResult.data;
  const instructions = await read(files.instructions);
  const arrays = async (filenames: string[]): Promise<unknown[]> => {
    const entries: unknown[] = [];
    for (const filename of filenames) {
      const value = jsonCopy(parseDataJson(await read(filename)));
      if (!Array.isArray(value) || entries.length + value.length > 100) throw new MethodError('INVALID_PACK_FILE', 'method pack content array');
      entries.push(...value);
    }
    return entries;
  };
  const rules = await arrays(files.rules); const examples = await arrays(files.examples); const cards = await arrays(files.cards);
  const evals = [];
  for (const filename of files.evals) evals.push(validateEvaluationSuite(parseDataJson(await read(filename))));
  const parsed = Pack.safeParse(jsonCopy({ manifest, instructions, rules, examples, cards, evals }));
  if (!parsed.success) throw new MethodError('INVALID_PACK_FILE', 'method pack content');
  const registry = new MethodRegistry(); const pin = registry.register(parsed.data);
  return registry.resolve(pin);
}

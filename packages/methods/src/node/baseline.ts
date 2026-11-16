import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parseStrictJson } from '@camery/ir/node';
import { canonical, MethodError } from '../data.js';
import { methodPackReader } from './loader.js';

const FILE_LIMIT = 1_048_576;
function sameIdentity(before: BigIntStats, after: BigIntStats): boolean { return before.ino > 0n && before.dev >= 0n && before.ino === after.ino && before.dev === after.dev; }
function sameSnapshot(before: BigIntStats, after: BigIntStats): boolean { return sameIdentity(before, after) && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs; }
function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }

export async function readGoldenBaseline(directory: string): Promise<unknown> {
  const reader = await methodPackReader(directory);
  const source = await reader.read('evals/baseline.json');
  try { return parseStrictJson(source); }
  catch { throw new MethodError('PACK_JSON', 'golden baseline JSON'); }
}

/** File fsync followed by atomic replacement; hardlink aliases are not modified in place.
 * Identity checks detect observed races, but cannot sandbox hostile concurrent directory rewrites. */
export async function writeGoldenBaseline(directory: string, value: unknown): Promise<void> {
  const content = Buffer.from(canonical(value) + '\n', 'utf8');
  if (content.length > FILE_LIMIT) throw new MethodError('BASELINE_LIMIT', 'golden baseline output');
  let temporary: string | undefined; let handle: FileHandle | undefined; let created = false; let installed = false; let failure: unknown;
  let assertParents: (() => Promise<void>) | undefined;
  try {
    const { root } = await methodPackReader(directory);
    const evals = path.join(root, 'evals'); const filename = path.join(evals, 'baseline.json');
    const rootBefore = await lstat(root, { bigint: true }); const evalsBefore = await lstat(evals, { bigint: true });
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !evalsBefore.isDirectory() || evalsBefore.isSymbolicLink()) throw new MethodError('BASELINE_PATH', 'golden baseline directory');
    assertParents = async (): Promise<void> => {
      for (const [name, before] of [[root, rootBefore], [evals, evalsBefore]] as const) {
        const current = await lstat(name, { bigint: true });
        if (current.isSymbolicLink() || !current.isDirectory() || !sameIdentity(before, current) || path.relative(name, await realpath(name)) !== '') throw new MethodError('BASELINE_CHANGED', 'golden baseline directory identity');
      }
    };
    const target = async (): Promise<BigIntStats | null> => {
      let current: BigIntStats;
      try { current = await lstat(filename, { bigint: true }); }
      catch (error) { if (missing(error)) return null; throw error; }
      if (current.isSymbolicLink()) throw new MethodError('BASELINE_PATH', 'golden baseline target');
      if (!current.isFile() || current.ino <= 0n || current.dev < 0n) throw new MethodError('BASELINE_FILE', 'golden baseline target');
      return current;
    };
    await assertParents(); const before = await target();
    temporary = path.join(evals, `.baseline-${randomUUID()}.tmp`);
    handle = await open(temporary, 'wx', 0o600); created = true;
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.ino <= 0n || opened.dev < 0n) throw new MethodError('BASELINE_CHANGED', 'golden baseline temporary identity');
    await assertParents();
    let offset = 0;
    while (offset < content.length) {
      const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > content.length - offset) throw new MethodError('BASELINE_WRITE', 'golden baseline byte write');
      offset += bytesWritten;
    }
    await handle.sync(); const written = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, written) || written.nlink !== 1n || written.size !== BigInt(content.length)) throw new MethodError('BASELINE_CHANGED', 'golden baseline temporary snapshot');
    await handle.close(); handle = undefined;
    await assertParents(); const current = await target();
    if (before ? !current || !sameSnapshot(before, current) : current !== null) throw new MethodError('BASELINE_CHANGED', 'golden baseline prior snapshot');
    const atTemporary = await lstat(temporary, { bigint: true });
    if (atTemporary.isSymbolicLink() || !atTemporary.isFile() || !sameSnapshot(written, atTemporary)) throw new MethodError('BASELINE_CHANGED', 'golden baseline temporary path');
    await rename(temporary, filename); installed = true;
  } catch (error) { failure = error; }
  finally {
    if (handle) { try { await handle.close(); } catch (error) { failure ??= error; } }
    if (created && !installed && temporary && assertParents) {
      try { await assertParents(); await unlink(temporary); }
      catch (error) { if (!missing(error)) failure = new MethodError('BASELINE_CLEANUP', 'golden baseline temporary cleanup'); }
    }
  }
  if (failure) throw failure instanceof MethodError ? failure : new MethodError('BASELINE_WRITE', 'golden baseline replacement');
}

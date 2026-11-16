import { link, lstat, mkdtemp, mkdir, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { readGoldenBaseline, writeGoldenBaseline } from '../src/node/baseline.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename), lstat: vi.fn(original.lstat), unlink: vi.fn(original.unlink) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.mocked(open).mockReset().mockImplementation(actual.open); vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(lstat).mockReset().mockImplementation(actual.lstat); vi.mocked(unlink).mockReset().mockImplementation(actual.unlink);
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('camery-baseline-')) throw new Error('Unexpected baseline temporary directory');
    await rm(resolved, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'camery-baseline-')); roots.push(root);
  const evals = path.join(root, 'evals'); await mkdir(evals);
  return { root, evals, filename: path.join(evals, 'baseline.json') };
}
it('creates and atomically updates a bounded JSON baseline', async () => {
  const { root, evals, filename } = await fixture();
  await writeGoldenBaseline(root, { version: 1, value: 'old' }); expect(await readGoldenBaseline(root)).toEqual({ version: 1, value: 'old' });
  await writeGoldenBaseline(root, { version: 1, value: 'new' }); expect(await readGoldenBaseline(root)).toEqual({ version: 1, value: 'new' });
  expect(await readFile(filename, 'utf8')).toBe('{"value":"new","version":1}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it('replaces an existing hardlink directory entry without changing its alias', async () => {
  const { root, filename } = await fixture(); const alias = path.join(root, 'retained.json');
  await writeFile(alias, '{"value":"old"}\n'); await link(alias, filename);
  await writeGoldenBaseline(root, { value: 'new' });
  expect(await readFile(alias, 'utf8')).toBe('{"value":"old"}\n'); expect(await readGoldenBaseline(root)).toEqual({ value: 'new' });
});
it('rejects a linked baseline leaf for both reading and writing', async () => {
  const { root, filename } = await fixture(); const outside = await fixture();
  await writeFile(outside.filename, '{"outside":true}\n');
  await symlink(outside.evals, filename, 'junction');
  await expect(readGoldenBaseline(root)).rejects.toMatchObject({ code: 'PACK_PATH' });
  await expect(writeGoldenBaseline(root, { changed: true })).rejects.toMatchObject({ code: 'BASELINE_PATH' });
  expect(await readFile(outside.filename, 'utf8')).toBe('{"outside":true}\n');
});
it('rejects a redirected evals parent and leaves the external baseline untouched', async () => {
  const { root, evals } = await fixture(); const outside = await fixture();
  await writeFile(outside.filename, '{"outside":true}\n');
  if (path.dirname(path.resolve(evals)) !== path.resolve(root)) throw new Error('Unexpected evals path');
  await rm(evals, { recursive: true }); await symlink(outside.evals, evals, 'junction');
  await expect(readGoldenBaseline(root)).rejects.toMatchObject({ code: 'PACK_PATH' });
  await expect(writeGoldenBaseline(root, { changed: true })).rejects.toMatchObject({ code: 'BASELINE_PATH' });
  expect(await readFile(outside.filename, 'utf8')).toBe('{"outside":true}\n');
});
it('rejects oversized or malformed input before changing an old baseline', async () => {
  const { root, filename } = await fixture(); await writeFile(filename, '{"old":true}\n');
  await expect(writeGoldenBaseline(root, 'x'.repeat(1_048_576))).rejects.toMatchObject({ code: 'BASELINE_LIMIT' });
  await expect(writeGoldenBaseline(root, { executable: () => {} })).rejects.toMatchObject({ code: 'INVALID_JSON' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n');
});
it.each(['oversized', 'invalid-json', 'duplicate-key', 'invalid-utf8'])('rejects unsafe baseline reads: %s', async kind => {
  const { root, filename } = await fixture();
  const data = kind === 'oversized' ? Buffer.alloc(1_048_577, 32) : kind === 'invalid-json' ? '{bad}' : kind === 'duplicate-key' ? '{"id":1,"id":2}' : Buffer.from([255]);
  await writeFile(filename, data); await expect(readGoldenBaseline(root)).rejects.toThrow();
});
it('retains the previous oracle and removes the temporary file when atomic replacement fails', async () => {
  const { root, filename, evals } = await fixture(); await writeFile(filename, '{"old":true}\n');
  vi.mocked(rename).mockRejectedValueOnce(new Error('sensitive filesystem detail'));
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_WRITE' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it('rejects failed sync without truncating the prior oracle', async () => {
  const { root, filename, evals } = await fixture(); await writeFile(filename, '{"old":true}\n');
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === 'wx') vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sensitive sync detail'));
    return handle;
  });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_WRITE' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it('rejects non-file baseline targets without rewriting them', async () => {
  const { root, filename } = await fixture(); await mkdir(filename);
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_FILE' });
});
it('does not let the shared reader escape its package through arbitrary relative paths', async () => {
  const { methodPackReader } = await import('../src/node/loader.js'); const { root } = await fixture(); const reader = await methodPackReader(root);
  for (const relative of ['../outside.json', '/etc/passwd', 'evals/../../outside.json', 'evals\\baseline.json', 'file:///etc/passwd']) await expect(reader.read(relative)).rejects.toMatchObject({ code: 'PACK_PATH' });
});
function changedMetadata(value: BigIntStats, changes: Partial<BigIntStats>): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(value)), value, changes) as BigIntStats;
}
function changeTemporary(change: (handle: FileHandle, filename: string) => Promise<void>): void {
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (args[1] === 'wx') await change(handle, String(args[0]));
    return handle;
  });
}
it('finishes real short writes rather than treating the first write as complete', async () => {
  const { root } = await fixture(); let writes = 0;
  changeTemporary(async handle => {
    const write = handle.write.bind(handle);
    const shortWrite = async (buffer: Buffer, offset: number, length: number, position: number) => { writes++; return write(buffer, offset, Math.min(3, length), position); };
    vi.spyOn(handle, 'write').mockImplementation(shortWrite as FileHandle['write']);
  });
  await writeGoldenBaseline(root, { value: 'complete' }); expect(writes).toBeGreaterThan(1); expect(await readGoldenBaseline(root)).toEqual({ value: 'complete' });
});
it('rejects a zero-byte write and removes the incomplete temporary file', async () => {
  const { root, filename, evals } = await fixture(); await writeFile(filename, '{"old":true}\n');
  changeTemporary(async handle => {
    const noWrite = async <T extends NodeJS.ArrayBufferView | string>(buffer: T) => ({ bytesWritten: 0, buffer });
    vi.spyOn(handle, 'write').mockImplementation(noWrite);
  });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_WRITE' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it.each([false, true])('preserves a concurrent writer instead of overwriting it (existing: %s)', async exists => {
  const { root, filename, evals } = await fixture(); if (exists) await writeFile(filename, '{"old":true}\n');
  changeTemporary(async handle => {
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); await writeFile(filename, '{"concurrent":true}\n'); });
  });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  expect(await readFile(filename, 'utf8')).toBe('{"concurrent":true}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it('rejects an unverified temporary handle and a replaced temporary directory entry', async () => {
  const { root, filename, evals } = await fixture(); await writeFile(filename, '{"old":true}\n');
  changeTemporary(async handle => { const metadata = await handle.stat({ bigint: true }); vi.spyOn(handle, 'stat').mockResolvedValue(changedMetadata(metadata, { ino: 0n })); });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  vi.restoreAllMocks();
  changeTemporary(async (handle, temporary) => {
    const close = handle.close.bind(handle);
    vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); await actual.unlink(temporary); await writeFile(temporary, '{"changed":true}\n'); });
  });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it('rejects temporary metadata changes and extra hardlink aliases before replacement', async () => {
  const { root, filename, evals } = await fixture(); await writeFile(filename, '{"old":true}\n');
  changeTemporary(async handle => {
    const metadata = await handle.stat({ bigint: true }); const spy = vi.spyOn(handle, 'stat');
    spy.mockResolvedValueOnce(metadata).mockResolvedValue(changedMetadata(metadata, { size: 999n }));
  });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  vi.restoreAllMocks();
  const alias = path.join(root, 'temporary-alias.json');
  changeTemporary(async (handle, temporary) => {
    const sync = handle.sync.bind(handle); vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); await link(temporary, alias); });
  });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it('detects directory identity changes and cleans only within the verified directory', async () => {
  const { root, evals, filename } = await fixture(); await writeFile(filename, '{"old":true}\n'); let observations = 0;
  vi.mocked(lstat).mockImplementation(async (...args) => {
    const metadata = await actual.lstat(...args);
    if (path.basename(String(args[0])) === 'evals' && 'mtimeNs' in metadata && ++observations === 3) return changedMetadata(metadata, { ino: metadata.ino + 1n });
    return metadata;
  });
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_CHANGED' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n'); expect(await readdir(evals)).toEqual(['baseline.json']);
});
it('reports cleanup failure explicitly and never removes or rewrites the old baseline', async () => {
  const { root, filename } = await fixture(); await writeFile(filename, '{"old":true}\n');
  vi.mocked(rename).mockRejectedValueOnce(new Error('replacement failed')); vi.mocked(unlink).mockRejectedValueOnce(new Error('cleanup failed'));
  await expect(writeGoldenBaseline(root, { next: true })).rejects.toMatchObject({ code: 'BASELINE_CLEANUP' });
  expect(await readFile(filename, 'utf8')).toBe('{"old":true}\n');
});

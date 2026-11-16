import { expect, it, vi } from 'vitest';
import { closeServer, releaseResources } from '../src/shutdown.js';
import { mkdtemp, writeFile, access, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
it('drains the application before releasing the pool', async () => {
  const order: string[] = [];
  expect(await closeServer({ close: async () => { order.push('app'); } }, { end: async () => { order.push('pool'); } })).toBe(true);
  expect(order).toEqual(['app', 'pool']);
  expect(await closeServer()).toBe(true);
});
it('still closes the pool after an application shutdown failure and reports both failures safely', async () => {
  const end = vi.fn(async () => {});
  expect(await closeServer({ close: async () => { throw new Error('private hook'); } }, { end })).toBe(false);
  expect(end).toHaveBeenCalledOnce();
  expect(await closeServer(undefined, { end: async () => { throw new Error('private db'); } })).toBe(false);
});
it('attempts secret removal even when preceding resource cleanup fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camery-cleanup-')); const path = join(directory, 'secret');
  try {
    await writeFile(path, 'synthetic-private-credential', { mode: 0o600 });
    expect(await releaseResources([async () => { throw new Error('private pool diagnostic'); }, () => rm(path)])).toBe(false);
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await releaseResources([])).toBe(true);
  } finally { await rm(path, { force: true }); await rmdir(directory); }
});

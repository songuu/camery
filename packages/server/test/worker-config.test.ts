import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readWorkerConfig } from '../src/worker-config.js';
const env = { CAMERY_TENANT_ID: 'tenant-a', CAMERY_DATABASE_URL: 'postgresql://worker:synthetic-secret@localhost/camery', CAMERY_WORKER_PROJECT_ID: 'project-a', CAMERY_WORKER_TREE_ID: 'tree-a', CAMERY_WORKER_ID: 'worker-a' };
it('requires an explicit deployment tree and retains only detached runtime configuration', async () => {
  expect(await readWorkerConfig(env)).toMatchObject({ tenantId: 'tenant-a', projectId: 'project-a', treeId: 'tree-a', workerId: 'worker-a', databaseUrl: env.CAMERY_DATABASE_URL });
  expect(await readWorkerConfig({ ...env, CAMERY_WORKER_CONTENT_DIRECTORY: '/trusted/content' })).toMatchObject({ contentDirectory: '/trusted/content' });
});
it('rejects missing, malformed and accessor scope fields with a fixed worker configuration error', async () => {
  let invoked = false;
  for (const value of [{}, { ...env, CAMERY_WORKER_PROJECT_ID: '' }, { ...env, CAMERY_WORKER_TREE_ID: 'tree\n' }, { ...env, CAMERY_WORKER_CONTENT_DIRECTORY: '' }, Object.defineProperty({ ...env }, 'CAMERY_WORKER_ID', { get() { invoked = true; throw new Error('private'); } })]) {
    await expect(readWorkerConfig(value)).rejects.toThrow('Invalid worker configuration');
  }
  expect(invoked).toBe(false);
});
it('freezes all identity fields before waiting for the database secret', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'camery-worker-config-')); const path = join(directory, 'url');
  try {
    await writeFile(path, env.CAMERY_DATABASE_URL, { mode: 0o600 });
    const value: Record<string, string | undefined> = { ...env, CAMERY_DATABASE_URL: undefined, CAMERY_DATABASE_URL_FILE: path };
    const pending = readWorkerConfig(value); value['CAMERY_WORKER_PROJECT_ID'] = 'changed'; value['CAMERY_WORKER_TREE_ID'] = 'changed'; value['CAMERY_TENANT_ID'] = 'changed';
    expect(await pending).toMatchObject({ tenantId: 'tenant-a', projectId: 'project-a', treeId: 'tree-a' });
  } finally { await rm(path, { force: true }); await rmdir(directory); }
});

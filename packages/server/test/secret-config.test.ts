import { mkdtemp, writeFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readRuntimeConfig } from '../src/secret-config.js';
const paths: string[] = [];
const directories: string[] = [];
async function secret(contents: string) {
  const directory = await mkdtemp(join(tmpdir(), 'camery-config-')); directories.push(directory);
  const path = join(directory, 'database-url'); paths.push(path); await writeFile(path, contents, { mode: 0o600 }); return path;
}
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { force: true }); for (const directory of directories.splice(0)) await rmdir(directory); });
const url = 'postgresql://runtime:synthetic-secret@127.0.0.1/camery';
it('supports direct protected environment configuration and detached file secrets', async () => {
  const request = { CAMERY_TENANT_ID: 't', CAMERY_DATABASE_URL_FILE: await secret(url + '\r\n'), CAMERY_API_HOST: '0.0.0.0' };
  const result = await readRuntimeConfig(request);
  expect(result).toEqual({ tenantId: 't', databaseUrl: url, port: 3000, host: '0.0.0.0' });
  expect(request).not.toHaveProperty('CAMERY_DATABASE_URL');
  expect((await readRuntimeConfig({ CAMERY_TENANT_ID: 't', CAMERY_DATABASE_URL: url })).databaseUrl).toBe(url);
});
it('rejects ambiguous sources, malformed/oversized secrets and unreadable paths with one safe error', async () => {
  const path = await secret(url);
  for (const config of [
    { CAMERY_DATABASE_URL: url, CAMERY_DATABASE_URL_FILE: path },
    { CAMERY_DATABASE_URL_FILE: '' }, { CAMERY_DATABASE_URL_FILE: path + '-missing' },
    { CAMERY_DATABASE_URL_FILE: await secret('x'.repeat(8193)) },
    { CAMERY_DATABASE_URL_FILE: await secret(url + '\n\n') },
    { CAMERY_DATABASE_URL_FILE: await secret('not-a-url') },
    { CAMERY_DATABASE_URL_FILE: directories[0] },
  ]) {
    await expect(readRuntimeConfig({ CAMERY_TENANT_ID: 't', ...config })).rejects.toThrow('Invalid server configuration');
  }
});
it('captures deployment identity before asynchronous file I/O and never invokes config accessors', async () => {
  const env: Record<string, string | undefined> = { CAMERY_TENANT_ID: 'original', CAMERY_DATABASE_URL_FILE: await secret(url), CAMERY_API_HOST: '127.0.0.1', CAMERY_API_PORT: '3456' };
  const reading = readRuntimeConfig(env);
  env['CAMERY_TENANT_ID'] = 'changed'; env['CAMERY_API_HOST'] = '0.0.0.0'; env['CAMERY_API_PORT'] = '9876';
  expect(await reading).toEqual({ tenantId: 'original', databaseUrl: url, host: '127.0.0.1', port: 3456 });
  let invoked = false;
  const accessor = Object.defineProperty({}, 'CAMERY_TENANT_ID', { get() { invoked = true; throw new Error('private diagnostic'); } });
  for (const value of [accessor, { CAMERY_TENANT_ID: 42 }, new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private proxy'); } })]) {
    await expect(readRuntimeConfig(value as Record<string, string>)).rejects.toThrow('Invalid server configuration');
  }
  expect(invoked).toBe(false);
});

import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { prepareRuntime } from '../scripts/prepare-runtime.mjs';

it('removes bundled workspace sources and development metadata from the portable runtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'camery-runtime-package-'));
  try {
    const internal = path.join(root, 'node_modules/.pnpm/access/node_modules/@camery/access');
    const link = path.join(root, 'node_modules/@camery/access');
    await mkdir(internal, { recursive: true }); await mkdir(path.dirname(link), { recursive: true });
    await writeFile(path.join(internal, 'private-source.ts'), 'private internal source');
    await writeFile(path.join(internal, 'package.json'), JSON.stringify({ name: '@camery/access' }));
    await symlink(internal, link, 'junction');
    await mkdir(path.join(root, 'node_modules/pg'), { recursive: true });
    await writeFile(path.join(root, 'node_modules/pg/index.js'), 'external production dependency');
    await writeFile(path.join(root, 'node_modules/pg/package.json'), JSON.stringify({ name: 'pg', version: '8.23.1' }));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@camery/server', version: '0.1.0', type: 'module', dependencies: { '@camery/access': 'workspace:*', pg: '^8.23.1' }, devDependencies: { tsx: '*' }, scripts: { start: 'tsx src/main.ts' } }));
    await prepareRuntime(root);
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))).toEqual({ name: '@camery/server', version: '0.1.0', private: true, type: 'module', scripts: { start: 'node main.mjs', 'start:worker': 'node worker.mjs' }, dependencies: { pg: '^8.23.1' } });
    await expect(access(internal)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(link)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'node_modules/pg/index.js'), 'utf8')).toContain('external production');
  } finally {
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('camery-runtime-package-')) throw new Error('Unsafe temporary package target');
    await rm(root, { recursive: true, force: true });
  }
});

async function packageAt(directory: string, name: string, dependencies: Record<string, string> = {}, version = '0.1.0') {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name, version, dependencies }));
  await writeFile(path.join(directory, 'index.js'), `export const name=${JSON.stringify(name)};`);
  return directory;
}
async function linkAt(directory: string, name: string, target: string) {
  const link = path.join(directory, 'node_modules', name);
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(target, link, 'junction');
}

it('removes every internal deploy copy while exposing the same transitive third-party bindings to both entrypoints', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'camery-runtime-package-'));
  try {
    const agentWrapper = path.join(root, 'node_modules/.pnpm/agents');
    const methodWrapper = path.join(root, 'node_modules/.pnpm/methods');
    const agents = await packageAt(path.join(agentWrapper, 'node_modules/@camery/agents'), '@camery/agents', { '@camery/methods': 'workspace:*', '@opentelemetry/api': '1.10.0' });
    const methods = await packageAt(path.join(methodWrapper, 'node_modules/@camery/methods'), '@camery/methods', { zod: '^4.6.7' });
    const orphan = await packageAt(path.join(root, 'node_modules/.pnpm/methods-peer/node_modules/@camery/methods'), '@camery/methods');
    const api = await packageAt(path.join(root, 'node_modules/.pnpm/otel/node_modules/@opentelemetry/api'), '@opentelemetry/api', {}, '1.10.0');
    const zod = await packageAt(path.join(root, 'node_modules/.pnpm/zod/node_modules/zod'), 'zod', {}, '4.6.7');
    await linkAt(root, '@camery/agents', agents);
    await linkAt(agentWrapper, '@camery/methods', methods);
    await linkAt(agentWrapper, '@opentelemetry/api', api);
    await linkAt(methodWrapper, 'zod', zod);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@camery/server', version: '0.1.0', dependencies: { '@camery/agents': 'workspace:*' } }));
    await prepareRuntime(root);
    for (const internal of [agents, methods, orphan]) await expect(access(internal)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, 'node_modules/@opentelemetry/api/index.js'), 'utf8')).toContain('@opentelemetry/api');
    expect(await readFile(path.join(root, 'node_modules/zod/index.js'), 'utf8')).toContain('zod');
    expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).dependencies).toEqual({ '@opentelemetry/api': '1.10.0', zod: '4.6.7' });
  } finally {
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('camery-runtime-package-')) throw new Error('Unsafe temporary package target');
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses incompatible third-party bindings before removing any workspace copy', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'camery-runtime-package-'));
  try {
    const wrappers = ['agents', 'methods'].map(name => path.join(root, 'node_modules/.pnpm', name));
    for (const [index, name] of ['agents', 'methods'].entries()) {
      const wrapper = wrappers[index]!;
      const internal = await packageAt(path.join(wrapper, `node_modules/@camery/${name}`), `@camery/${name}`, { zod: '*' });
      const version = index === 0 ? '4.6.7' : '3.0.0';
      const external = await packageAt(path.join(root, `node_modules/.pnpm/zod-${version}/node_modules/zod`), 'zod', {}, version);
      await linkAt(root, `@camery/${name}`, internal); await linkAt(wrapper, 'zod', external);
    }
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@camery/server', dependencies: { '@camery/agents': 'workspace:*', '@camery/methods': 'workspace:*' } }));
    await expect(prepareRuntime(root)).rejects.toThrow('Ambiguous runtime dependency');
    for (const name of ['agents', 'methods']) expect(await readFile(path.join(root, `node_modules/@camery/${name}/index.js`), 'utf8')).toContain(name);
  } finally {
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('camery-runtime-package-')) throw new Error('Unsafe temporary package target');
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses a workspace source directory or an external symlink target before deleting files', async () => {
  await expect(prepareRuntime(path.resolve(import.meta.dirname, '..'))).rejects.toThrow('Unsafe runtime target');
  const root = await mkdtemp(path.join(tmpdir(), 'camery-runtime-package-'));
  try {
    const outside = path.join(root, 'outside'); const runtime = path.join(root, 'runtime');
    await mkdir(outside); await writeFile(path.join(outside, 'source.ts'), 'preserve this');
    await mkdir(path.join(runtime, 'node_modules/@camery'), { recursive: true });
    await symlink(outside, path.join(runtime, 'node_modules/@camery/access'), 'junction');
    await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: '@camery/server', dependencies: { '@camery/access': 'workspace:*' } }));
    await expect(prepareRuntime(runtime)).rejects.toThrow('Unsafe workspace dependency target');
    expect(await readFile(path.join(outside, 'source.ts'), 'utf8')).toBe('preserve this');
  } finally {
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('camery-runtime-package-')) throw new Error('Unsafe temporary package target');
    await rm(root, { recursive: true, force: true });
  }
});

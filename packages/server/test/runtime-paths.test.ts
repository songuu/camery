import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { prepareRuntime } from '../scripts/prepare-runtime.mjs';

// Attack probes observe deletion attempts but never let the old implementation remove an external path.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(), rm: vi.fn(async () => {}),
}));
const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
async function fixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'camery-runtime-boundary-'));
  const runtime = path.join(root, 'runtime');
  const internal = path.join(runtime, 'node_modules/.pnpm/access/node_modules/@camery/access');
  await mkdir(internal, { recursive: true });
  await writeFile(path.join(internal, 'package.json'), JSON.stringify({ name }));
  await writeFile(path.join(internal, 'source.ts'), 'preserve internal source on invalid input');
  await writeFile(path.join(runtime, 'package.json'), JSON.stringify({ name: '@camery/server', dependencies: { [name]: 'workspace:*' } }));
  return { root, runtime, internal };
}
async function cleanup(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('camery-runtime-boundary-')) throw new Error('Unsafe test fixture target');
  await originalFs.rm(root, { recursive: true, force: true });
}

it('rejects traversal dependency names before resolving or removing their external link', async () => {
  vi.mocked(rm).mockClear();
  const name = '@camery/../../../outside-link';
  const { root, runtime, internal } = await fixture(name);
  try {
    const outsideLink = path.join(root, 'outside-link');
    await symlink(internal, outsideLink, 'junction');
    await expect(prepareRuntime(runtime)).rejects.toThrow('Invalid workspace dependency name');
    expect(rm).not.toHaveBeenCalled();
    expect(await realpath(outsideLink)).toBe(await realpath(internal));
    expect(await readFile(path.join(internal, 'source.ts'), 'utf8')).toContain('preserve');
    expect(Object.hasOwn(JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8')).dependencies, name)).toBe(true);
  } finally { await cleanup(root); }
});

it.each(['@camery/..\\..\\outside-link', '@camery//access', '@camery/access/child', '@camery/access\n', '@camery/.', '@camery/..', '@camery/access%2fchild'])('rejects malformed workspace package key %s before filesystem removal', async name => {
  vi.mocked(rm).mockClear();
  const { root, runtime } = await fixture(name);
  try {
    await expect(prepareRuntime(runtime)).rejects.toThrow('Invalid workspace dependency name');
    expect(rm).not.toHaveBeenCalled();
  } finally { await cleanup(root); }
});

it('rejects a scope symlink outside the runtime even when the package resolves back inside it', async () => {
  vi.mocked(rm).mockClear();
  const { root, runtime, internal } = await fixture('@camery/access');
  try {
    const outsideScope = path.join(root, 'outside-scope');
    await mkdir(outsideScope);
    await symlink(internal, path.join(outsideScope, 'access'), 'junction');
    await symlink(outsideScope, path.join(runtime, 'node_modules/@camery'), 'junction');
    await expect(prepareRuntime(runtime)).rejects.toThrow('Unsafe workspace dependency target');
    expect(rm).not.toHaveBeenCalled();
    expect(await realpath(path.join(outsideScope, 'access'))).toBe(await realpath(internal));
  } finally { await cleanup(root); }
});

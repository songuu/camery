import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const workspaceName = /^@camery\/[a-z0-9][a-z0-9._-]{0,205}$(?![\s\S])/;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$(?![\s\S])/;
function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validateName(name) {
  if (name.startsWith('@camery/') && !workspaceName.test(name)) throw new Error('Invalid workspace dependency name');
  if (name.length > 214 || !packageName.test(name)) throw new Error('Invalid runtime dependency name');
}
async function readPackage(modules, link, name) {
  validateName(name);
  if (!contains(modules, link)) throw new Error('Unsafe workspace dependency target');
  // Resolve the containing scope too: a scope symlink may leave the runtime and then point back in.
  const scope = await realpath(path.dirname(link));
  if (scope !== modules && !contains(modules, scope)) throw new Error('Unsafe workspace dependency target');
  const resolved = await realpath(link);
  if (!contains(modules, resolved)) throw new Error('Unsafe workspace dependency target');
  const manifest = JSON.parse(await readFile(path.join(resolved, 'package.json'), 'utf8'));
  if (manifest.name !== name) throw new Error('Unexpected workspace dependency');
  return { resolved, manifest };
}
async function optionalScope(modules, scope) {
  try {
    const resolved = await realpath(scope);
    if (!contains(modules, resolved)) throw new Error('Unsafe workspace dependency target');
    return await readdir(scope, { withFileTypes: true });
  } catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
}
async function discoverWorkspaceCopies(modules) {
  const scopes = [path.join(modules, '@camery')];
  const store = path.join(modules, '.pnpm');
  let entries = [];
  try {
    if (!contains(modules, await realpath(store))) throw new Error('Unsafe deploy store');
    entries = await readdir(store, { withFileTypes: true });
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  scopes.push(path.join(store, 'node_modules/@camery'));
  for (const entry of entries) if (entry.isDirectory()) scopes.push(path.join(store, entry.name, 'node_modules/@camery'));
  const copies = new Map();
  for (const scope of scopes) {
    for (const entry of await optionalScope(modules, scope)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error('Unexpected workspace scope entry');
      const name = `@camery/${entry.name}`; const link = path.join(scope, entry.name);
      const value = await readPackage(modules, link, name);
      let copy = copies.get(value.resolved);
      if (!copy) { copy = { ...value, links: new Set() }; copies.set(value.resolved, copy); }
      copy.links.add(link);
    }
  }
  return copies;
}
async function installedPackage(modules, from, name) {
  validateName(name);
  const paths = createRequire(path.join(from, 'package.json')).resolve.paths(name) ?? [];
  for (const directory of paths) {
    const link = path.join(directory, name);
    if (!contains(modules, link)) continue;
    try { return await readPackage(modules, link, name); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  throw new Error('Missing runtime dependency');
}

/** pnpm deploy preserves its locked production closure; bundled workspace packages need not ship twice. */
export async function prepareRuntime(directory) {
  const root = await realpath(directory);
  if (root === path.parse(root).root || root === workspaceRoot || contains(workspaceRoot, root)) throw new Error('Unsafe runtime target');
  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.name !== '@camery/server') throw new Error('Unexpected runtime package');
  const modules = path.join(root, 'node_modules');
  const dependencies = Object.entries(manifest.dependencies ?? {});
  for (const [name] of dependencies) validateName(name);
  if (path.relative(modules, await realpath(modules)) !== '') throw new Error('Unsafe deploy modules');
  const copies = await discoverWorkspaceCopies(modules);
  const external = new Map();
  for (const source of [{ resolved: root, manifest }, ...copies.values()]) {
    for (const [name] of Object.entries(source.manifest.dependencies ?? {})) {
      const installed = await installedPackage(modules, source.resolved, name);
      if (name.startsWith('@camery/')) {
        if (!copies.has(installed.resolved)) throw new Error('Unrecognized workspace dependency');
      } else {
        if (typeof installed.manifest.version !== 'string') throw new Error('Invalid runtime dependency version');
        const prior = external.get(name);
        if (prior && prior.resolved !== installed.resolved) throw new Error('Ambiguous runtime dependency');
        external.set(name, installed);
      }
    }
  }
  const links = [];
  for (const [name, value] of external) {
    if ([...copies.keys()].some(directory => directory === value.resolved || contains(directory, value.resolved))) throw new Error('Runtime dependency would be removed');
    const link = path.join(modules, name);
    const parent = path.dirname(link);
    try { const scope = await realpath(parent); if (scope !== modules && !contains(modules, scope)) throw new Error('Unsafe runtime dependency scope'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    try {
      if ((await readPackage(modules, link, name)).resolved !== value.resolved) throw new Error('Ambiguous runtime dependency');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      links.push({ link, resolved: value.resolved });
    }
  }
  // Hoist the exact already-installed bindings, without resolving new packages or flattening different peers.
  for (const { link, resolved } of links) {
    await mkdir(path.dirname(link), { recursive: true });
    await symlink(process.platform === 'win32' ? resolved : path.relative(path.dirname(link), resolved), link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  // Validate every target before any recursive removal; never operate on the source workspace.
  for (const { links, resolved } of copies.values()) {
    await rm(resolved, { recursive: true, force: true });
    for (const link of links) if (link !== resolved) await rm(link, { recursive: true, force: true });
  }
  await writeFile(manifestPath, `${JSON.stringify({
    name: manifest.name, version: manifest.version, private: true, type: 'module',
    scripts: { start: 'node main.mjs', 'start:worker': 'node worker.mjs','start:bible-worker':'node bible-worker.mjs','start:development-worker':'node development-worker.mjs' },
    dependencies: Object.fromEntries([...external].map(([name, value]) => [name, manifest.dependencies?.[name] ?? value.manifest.version])),
  }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Provide one isolated pnpm deploy target');
  await prepareRuntime(process.argv[2]);
  console.log('Prepared production runtime package.');
}

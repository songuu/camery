import { build } from 'esbuild';
import { copyFile, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const workspaceRoot = path.resolve(packageRoot, '../..');
const contentFiles = [
  'agents/producer/agent.yaml', 'agents/producer/instructions.md',
  'method-packs/chapter-segmentation/pack.yaml', 'method-packs/chapter-segmentation/instructions.md',
  'method-packs/chapter-segmentation/rules/quality.json', 'method-packs/chapter-segmentation/examples/basic.json',
  'method-packs/chapter-segmentation/cards/source.json', 'method-packs/chapter-segmentation/evals/chapter-golden.json',
];

function dependencyName(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (name.length > 214 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$(?![\s\S])/.test(name)) throw new Error('Invalid build dependency');
  return name;
}
async function dependencyRoot(importer, specifier, name) {
  let directory = path.dirname(await realpath(createRequire(importer).resolve(specifier)));
  while (true) {
    try {
      if (JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).name === name) return directory;
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Missing build dependency package');
    directory = parent;
  }
}
async function localDependencyLinks(outputDirectory, metafile) {
  const needed = new Set(Object.values(metafile.outputs).flatMap(file => file.imports.filter(item => item.external && !isBuiltin(item.path)).map(item => dependencyName(item.path))));
  const bindings = new Map();
  for (const [input, metadata] of Object.entries(metafile.inputs)) {
    for (const item of metadata.imports.filter(item => item.external && !isBuiltin(item.path))) {
      // esbuild records synthetic helper imports in input metadata; they are absent from emitted runtime imports.
      if (item.path === '<runtime>') continue;
      const name = dependencyName(item.path);
      if (!needed.has(name)) continue;
      if (name.startsWith('@camery/')) throw new Error('Workspace code was not bundled');
      const resolved = await dependencyRoot(path.resolve(packageRoot, input), item.path, name);
      if (bindings.has(name) && bindings.get(name) !== resolved) throw new Error('Ambiguous build dependency');
      bindings.set(name, resolved);
    }
  }
  if (bindings.size !== needed.size) throw new Error('Incomplete build dependency bindings');
  const root = await realpath(outputDirectory);
  const modules = path.join(root, 'node_modules');
  const ensureDirectory = async directory => {
    try { await mkdir(directory); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe build dependency directory');
  };
  await ensureDirectory(modules);
  for (const [name, resolved] of bindings) {
    const link = path.join(modules, name);
    if (name.startsWith('@')) await ensureDirectory(path.dirname(link));
    try {
      if (await realpath(link) !== resolved) throw new Error('Built dependency binding changed; clean the generated output directory');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await symlink(process.platform === 'win32' ? resolved : path.relative(path.dirname(link), resolved), link, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
}

/** Bundle application/workspace code, retaining only declared third-party runtime packages. */
export async function buildServer(outputDirectory = path.join(packageRoot, 'dist')) {
  outputDirectory = path.resolve(outputDirectory);
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: { main: path.join(packageRoot, 'src/main.ts'), worker: path.join(packageRoot, 'src/worker-main.ts'), 'bible-worker':path.join(packageRoot,'src/bible-worker-main.ts') }, outdir: outputDirectory,
    outExtension: { '.js': '.mjs' },
    tsconfig: path.join(packageRoot, 'tsconfig.json'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22.15',
    packages: 'external',
    plugins: [{ name: 'bundle-workspace', setup(builder) {
      builder.onResolve({ filter: /^@camery\// }, args => ({
        path: createRequire(path.join(args.resolveDir, 'package.json')).resolve(args.path), external: false,
      }));
    } }],
    sourcemap: false, metafile: true, legalComments: 'eof', logLevel: 'silent',
  });
  // Preserve the pinned content bytes without copying unrelated fixtures, baselines or repository material.
  for (const relative of contentFiles) {
    const target = path.join(outputDirectory, 'content', relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(workspaceRoot, relative), target);
  }
  // Local dist uses the same installed bindings as each workspace importer; production images use portable pnpm deploy instead.
  await localDependencyLinks(outputDirectory, result.metafile);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildServer();
  console.log('Built API/worker JavaScript bundles and pinned content.');
}

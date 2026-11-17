import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { buildServer } from '../scripts/build.mjs';
import { loadMethodPack } from '@camery/methods/node';
import { loadAgentDefinition } from '@camery/agents/node';

it('builds native API/worker entrypoints with pinned data, no internal package imports and safe configuration failure', async () => {
  const distribution = path.resolve(import.meta.dirname, '../dist');
  await mkdir(distribution, { recursive: true });
  const directory = await mkdtemp(path.join(distribution, 'camery-server-build-'));
  try {
    const result = await buildServer(directory);
    const outputs = await Promise.all(['main.mjs', 'worker.mjs','bible-worker.mjs','development-worker.mjs'].map(name => readFile(path.join(directory, name), 'utf8')));
    const externalImports = Object.values(result.metafile.outputs).flatMap(file => file.imports.filter(item => item.external).map(item => item.path));
    expect(externalImports.some(item => item.startsWith('@camery/'))).toBe(false);
    for (const output of outputs) expect(output).not.toContain('sourceMappingURL');
    const root = path.resolve(import.meta.dirname, '../../..');
    expect(await loadMethodPack(path.join(directory, 'content/method-packs/chapter-segmentation'))).toEqual(await loadMethodPack(path.join(root, 'method-packs/chapter-segmentation')));
    expect(await loadAgentDefinition(path.join(directory, 'content/agents/producer'))).toEqual(await loadAgentDefinition(path.join(root, 'agents/producer')));
    const contentFiles = (await readdir(path.join(directory, 'content'), { recursive: true, withFileTypes: true })).filter(item => item.isFile()).map(item => path.relative(path.join(directory, 'content'), path.join(item.parentPath, item.name)).replaceAll('\\', '/')).sort();
    expect(contentFiles).toEqual([
      'agents/producer/agent.yaml', 'agents/producer/instructions.md',
      'method-packs/chapter-segmentation/cards/source.json', 'method-packs/chapter-segmentation/evals/chapter-golden.json',
      'method-packs/chapter-segmentation/examples/basic.json', 'method-packs/chapter-segmentation/instructions.md',
      'method-packs/chapter-segmentation/pack.yaml', 'method-packs/chapter-segmentation/rules/quality.json',
    ]);
    // Resolution remains at the server package: output needs only production packages, never tsx.
    const executions = await Promise.all(['main.mjs', 'worker.mjs','bible-worker.mjs','development-worker.mjs'].map(entry => new Promise<{ entry: string; code: number | null; output: string; killed: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(directory, entry)], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, CAMERY_TENANT_ID: '', CAMERY_DATABASE_URL: '', CAMERY_DATABASE_URL_FILE: '' },
        // Bound startup independently; a timeout-killed child never counts as success.
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
      });
      let messages = ''; child.stdout.on('data', data => { messages += String(data); }); child.stderr.on('data', data => { messages += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ entry, code, output: messages, killed: child.killed }));
    })));
    const harnessKeys = Object.keys(process.env).filter(key => key.startsWith('VITEST') || ['NODE_OPTIONS', 'NODE_V8_COVERAGE', 'NODE_CHANNEL_FD', 'NODE_UNIQUE_ID'].includes(key));
    for (const execution of executions) {
      expect(execution, JSON.stringify({ harnessKeys })).toMatchObject({ code: 1, killed: false });
      expect(execution.output).toContain(execution.entry === 'main.mjs' ? 'API startup failed' :execution.entry==='bible-worker.mjs'?'Bible worker unavailable':execution.entry==='development-worker.mjs'?'Development worker unavailable': 'Worker startup failed');
      expect(execution.output).not.toMatch(/Cannot find|ERR_MODULE|\.ts:/);
    }
  } finally {
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(directory) !== distribution || !path.basename(directory).startsWith('camery-server-build-')) throw new Error('Unsafe temporary build target');
    // Windows can briefly retain handles to newly linked dependency directories after the child closes.
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 30000);

it('keeps bundles, content and dependency bindings together for a relative output from another working directory', async () => {
  const packageRoot = path.resolve(import.meta.dirname, '..');
  const workspaceRoot = path.resolve(packageRoot, '../..');
  const distribution = path.join(packageRoot, 'dist');
  await mkdir(distribution, { recursive: true });
  const directory = await mkdtemp(path.join(distribution, 'camery-server-relative-'));
  const relative = path.relative(workspaceRoot, directory);
  const legacyDirectory = path.resolve(packageRoot, relative);
  try {
    // Both directories are on the workspace drive; path.relative must remain relative to exercise the regression.
    expect(path.isAbsolute(relative)).toBe(false);
    expect(relative.startsWith('..')).toBe(false);
    const execution = await new Promise<{ code: number | null; output: string; killed: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', 'const {buildServer}=await import(process.argv[1]); await buildServer(process.argv[2]);', pathToFileURL(path.join(packageRoot, 'scripts/build.mjs')).href, relative], {
        cwd: workspaceRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
      });
      let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
      child.on('error', reject); child.on('close', code => resolve({ code, output, killed: child.killed }));
    });
    expect(execution).toMatchObject({ code: 0, killed: false });
    expect(await readFile(path.join(directory, 'main.mjs'), 'utf8')).toContain('API startup failed');
    expect(await readFile(path.join(directory, 'worker.mjs'), 'utf8')).toContain('Worker startup failed');
    expect((await loadAgentDefinition(path.join(directory, 'content/agents/producer'))).id).toBe('producer');
    expect((await readdir(path.join(directory, 'node_modules'))).length).toBeGreaterThan(0);
  } finally {
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(directory) !== distribution || !path.basename(directory).startsWith('camery-server-relative-')) throw new Error('Unsafe relative build target');
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(legacyDirectory) !== path.join(packageRoot, 'packages/server/dist') || path.basename(legacyDirectory) !== path.basename(directory)) throw new Error('Unsafe legacy build target');
    // Windows may briefly retain a build subprocess handle after close; retry only the validated test directory.
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    // The pre-fix compiler wrote this unique test directory under packageRoot instead of the subprocess cwd.
    await rm(legacyDirectory, { recursive: true, force: true });
  }
}, 30000);

it('refuses an external generated-dependency directory instead of writing through its alias', async () => {
  const distribution = path.resolve(import.meta.dirname, '../dist');
  await mkdir(distribution, { recursive: true });
  const directory = await mkdtemp(path.join(distribution, 'camery-server-build-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'camery-build-dependency-'));
  try {
    await writeFile(path.join(outside, 'sentinel.txt'), 'preserve external files');
    await symlink(outside, path.join(directory, 'node_modules'), 'junction');
    await expect(buildServer(directory)).rejects.toThrow('Unsafe build dependency directory');
    expect(await readdir(outside)).toEqual(['sentinel.txt']);
    expect(await readFile(path.join(outside, 'sentinel.txt'), 'utf8')).toBe('preserve external files');
  } finally {
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(directory) !== distribution || !path.basename(directory).startsWith('camery-server-build-')) throw new Error('Unsafe temporary build target');
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Refuse unsafe or failed cleanup even when the test body failed.
    if (path.dirname(outside) !== tmpdir() || !path.basename(outside).startsWith('camery-build-dependency-')) throw new Error('Unsafe dependency fixture target');
    // Windows briefly retains handles after esbuild's failed link validation, as in the successful build cases above.
    await rm(directory, { recursive: true, force: true,maxRetries:3,retryDelay:100 });
    await rm(outside, { recursive: true, force: true });
  }
}, 30000);

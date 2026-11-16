import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceInvocation } from './workspace.mjs';

const config = await readFile(new URL('../turbo.json', import.meta.url), 'utf8');
const probe = `import {readFileSync,writeFileSync} from 'node:fs';
const action=process.argv[2];
let counts={}; try { counts=JSON.parse(readFileSync('.counts.json','utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
counts[action]=(counts[action]??0)+1; writeFileSync('.counts.json',JSON.stringify(counts));
if(readFileSync('source.ts','utf8').includes('invalid')) { console.error('PROBE_INVALID_SOURCE'); process.exitCode=1; }
else console.log('PROBE_COMPLETED',action);
`;

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'camery-workspace-'));
  try {
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'cache-fixture', private: true, packageManager: 'pnpm@12.3.4' }));
  // Probe commands use only Node built-ins: never implicitly install into this dependency-free fixture.
  await writeFile(path.join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\nverifyDepsBeforeRun: false\n');
  await writeFile(path.join(directory, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .: {}
  packages/base: {}
  packages/consumer:
    dependencies:
      '@camery/base':
        specifier: workspace:*
        version: link:../base
`);
  await writeFile(path.join(directory, '.gitignore'), '.turbo/\n**/.counts.json\n');
  await writeFile(path.join(directory, 'turbo.json'), config);
  await writeFile(path.join(directory, 'tsconfig.base.json'), '{}\n');
  await mkdir(path.join(directory, 'method-packs/example'), { recursive: true });
  await writeFile(path.join(directory, 'method-packs/example/content.json'), '{"version":1}\n');
  for (const name of ['base', 'consumer']) {
    const target = path.join(directory, 'packages', name);
    await mkdir(target, { recursive: true });
    const scripts = Object.fromEntries(['typecheck', 'test', 'test:coverage', 'eval:check', 'build'].map(action => [action, `node probe.mjs ${action}`]));
    await writeFile(path.join(target, 'package.json'), JSON.stringify({ name: `@camery/${name}`, version: '0.0.0', private: true, scripts,
      dependencies: name === 'consumer' ? { '@camery/base': 'workspace:*' } : {},
    }));
    await writeFile(path.join(target, 'probe.mjs'), probe);
    await writeFile(path.join(target, 'source.ts'), 'export const value = 1;\n');
  }
    return directory;
  } catch (error) {
    // The caller cannot register cleanup until fixture initialization has returned.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function run(directory, task, options = [], environment = process.env) {
  const command = workspaceInvocation([task, ...options], environment, directory);
  const result = spawnSync(command.command, command.args, { ...command.options, stdio: 'pipe', encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}
const counts = async (directory, name) => JSON.parse(await readFile(path.join(directory, 'packages', name, '.counts.json'), 'utf8'));

test('real Turbo cache hits and invalidation follow source, upstream, root config, content and runtime', { timeout: 120000 }, async () => {
  const directory = await fixture();
  try {
    const check = (environment = process.env) => {
      const result = run(directory, 'typecheck', [], environment);
      assert.equal(result.status, 0, result.output);
    };
    check(); check();
    assert.equal((await counts(directory, 'base')).typecheck, 1);
    assert.equal((await counts(directory, 'consumer')).typecheck, 1);
    await writeFile(path.join(directory, 'packages/base/source.ts'), 'export const value = 2;\n'); check();
    assert.equal((await counts(directory, 'base')).typecheck, 2);
    assert.equal((await counts(directory, 'consumer')).typecheck, 2);
    await writeFile(path.join(directory, 'packages/consumer/source.ts'), 'export const local = 2;\n'); check();
    assert.equal((await counts(directory, 'base')).typecheck, 2);
    assert.equal((await counts(directory, 'consumer')).typecheck, 3);
    await writeFile(path.join(directory, 'tsconfig.base.json'), '{"compilerOptions":{"strict":true}}\n'); check();
    assert.equal((await counts(directory, 'base')).typecheck, 3);
    assert.equal((await counts(directory, 'consumer')).typecheck, 4);
    await writeFile(path.join(directory, 'method-packs/example/content.json'), '{"version":2}\n'); check();
    assert.equal((await counts(directory, 'base')).typecheck, 4);
    assert.equal((await counts(directory, 'consumer')).typecheck, 5);
    // Preserve valid caller flags while guaranteeing a different cache input, even if this flag is already set.
    check({ ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --no-warnings` });
    assert.equal((await counts(directory, 'base')).typecheck, 5);
    assert.equal((await counts(directory, 'consumer')).typecheck, 6);
    await writeFile(path.join(directory, 'packages/base/source.ts'), 'invalid source\n');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = run(directory, 'typecheck');
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /PROBE_INVALID_SOURCE/);
    }
    assert.equal((await counts(directory, 'base')).typecheck, 7);
    assert.equal((await counts(directory, 'consumer')).typecheck, 6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real test, coverage, evaluation and build tasks execute on every invocation', { timeout: 120000 }, async () => {
  const directory = await fixture();
  try {
    for (const task of ['test', 'test:coverage', 'eval:check', 'build']) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = run(directory, task);
        assert.equal(result.status, 0, result.output);
      }
      for (const name of ['base', 'consumer']) assert.equal((await counts(directory, name))[task], 2);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

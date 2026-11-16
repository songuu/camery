import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const tasks = new Set(['typecheck', 'test', 'test:coverage', 'eval:check', 'build']);

/** Turbo's JS shim can auto-install missing optional binaries; execute only the installed native dependency. */
export function resolveTurboBinary(resolve = specifier => createRequire(require.resolve('turbo/package.json')).resolve(specifier), platform = process.platform, architecture = process.arch) {
  const system = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const cpu = { x64: '64', arm64: 'arm64' }[architecture];
  if (!system || !cpu) throw new Error('Unsupported Turbo platform or architecture');
  try { return resolve(`@turbo/${system}-${cpu}/bin/turbo${platform === 'win32' ? '.exe' : ''}`); }
  catch { throw new Error('Locked Turbo native binary is unavailable; run pnpm install --frozen-lockfile explicitly'); }
}

/** Keep runtime-specific results local; callers cannot turn checks into remote cache or service operations. */
export function workspaceInvocation(argv, environment = process.env, directory = root) {
  const [task, ...options] = argv;
  if (!tasks.has(task)) throw new Error('Usage: workspace.mjs <typecheck|test|test:coverage|eval:check|build> [--fresh] [--dry=json] [--filter=@camery/name]');
  if (options.some(option => option !== '--fresh' && option !== '--dry=json' && !/^--filter=@camery\/[a-z][a-z0-9-]*$/.test(option)))
    throw new Error('Unsupported workspace option');
  for (const option of options.filter(option => option.startsWith('--filter='))) {
    const name = option.slice('--filter=@camery/'.length);
    let manifest;
    try { manifest = JSON.parse(readFileSync(path.join(directory, 'packages', name, 'package.json'), 'utf8')); }
    catch { throw new Error('Unsupported workspace package filter'); }
    if (manifest.name !== `@camery/${name}` || typeof manifest.scripts?.[task] !== 'string') throw new Error('Unsupported workspace task for package filter');
  }
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.toUpperCase().startsWith('TURBO_') && key.toUpperCase() !== 'CAMERY_TASK_RUNTIME'));
  env.CAMERY_TASK_RUNTIME = createHash('sha256').update(JSON.stringify({
    node: process.version, versions: process.versions, platform: process.platform, architecture: process.arch, directory: realpathSync(directory),
  })).digest('hex');
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.DO_NOT_TRACK = '1';
  const args = ['run', task, '--skip-infer', '--env-mode=strict', '--framework-inference=false', '--no-update-notifier', '--ui=stream',
    options.includes('--fresh') ? '--cache=local:w' : '--cache=local:rw',
    ...options.filter(option => option !== '--fresh'),
  ];
  // Windows coverage collection needs package serialization; keep one rule for every platform.
  if (task === 'test:coverage') args.push('--concurrency=1');
  if (task === 'test') args.push('--concurrency=4');
  return { command: resolveTurboBinary(), args, options: { cwd: directory, env, stdio: 'inherit' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const invocation = workspaceInvocation(process.argv.slice(2));
    const result = spawnSync(invocation.command, invocation.args, invocation.options);
    if (result.error || result.signal || result.status === null) {
      console.error('Workspace task could not finish; check the locked Turbo installation and child process status');
      process.exitCode = 1;
    } else process.exitCode = result.status;
  } catch {
    console.error('Workspace task configuration failed; use a supported task/filter and explicitly install locked dependencies before running');
    process.exitCode = 2;
  }
}

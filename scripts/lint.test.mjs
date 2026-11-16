import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'node_modules/oxlint/bin/oxlint');
const config = path.join(root, '.oxlintrc.json');

async function lint(source, extension) {
  const directory = await mkdtemp(path.join(tmpdir(), 'camery-lint-'));
  try {
    const filename = path.join(directory, `example.${extension}`);
    await writeFile(filename, source);
    await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2023', strict: true }, include: ['*.ts'],
    }));
    const result = spawnSync(process.execPath, [cli, '--config', config, '--deny-warnings', filename], {
      cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'Lint process must finish naturally');
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    // mkdtemp creates this exact test-owned directory; never remove a caller path.
    await rm(directory, { recursive: true, force: true });
  }
}

await test('lint rejects JavaScript correctness errors with actionable diagnostics', async () => {
  const result = await lint('const value = 1; value = 2; console.log(value);\n', 'mjs');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no-const-assign/);
});

await test('lint rejects an unhandled TypeScript promise using actual type analysis', async () => {
  const result = await lint('async function save(): Promise<void> {}\nsave();\n', 'ts');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no-floating-promises/);
});

await test('lint rejects an async callback assigned to a synchronous contract', async () => {
  const result = await lint('const save: () => void = async () => {};\nsave();\n', 'ts');
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no-misused-promises/);
});

await test('lint accepts explicitly handled promises and valid JavaScript', async () => {
  const typed = await lint('async function save(): Promise<void> {}\nvoid save().catch(() => {});\n', 'ts');
  assert.equal(typed.status, 0, typed.output);
  const script = await lint('const value = 1; console.log(value);\n', 'mjs');
  assert.equal(script.status, 0, script.output);
});

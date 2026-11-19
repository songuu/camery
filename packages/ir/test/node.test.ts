import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSchemas, parseStrictJson, runCli, validatePackageFile, validatePackageFiles } from '../src/node/index';
import { makePackage, mutate } from './fixtures';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), open: vi.fn(actual.open) };
});

let directory: string;
const content = Buffer.from('fixture image bytes');
const digest = createHash('sha256').update(content).digest('hex');

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'camery-ir-node-'));
  await mkdir(path.join(directory, 'img'));
  await writeFile(path.join(directory, 'img/a.png'), content);
});

afterEach(async () => {
  vi.mocked(fsPromises.stat).mockReset();
  vi.mocked(fsPromises.open).mockReset();
  vi.restoreAllMocks();
  // Delete only the exact task-created directory, never an arbitrary test input.
  if (!path.basename(directory).startsWith('camery-ir-node-') || path.dirname(directory) !== os.tmpdir()) {
    throw new Error(`Unsafe test cleanup path: ${directory}`);
  }
  await rm(directory, { recursive: true, force: true });
});

const pkg = () => mutate(makePackage(), draft => { if (draft.assets[0]!.status === 'ready') draft.assets[0]!.file.sha256 = digest; });

describe('strict JSON boundary', () => {
  it('accepts nested objects, arrays, escaped strings and repeated keys in different objects', () => {
    const text = String.raw`{"a":[{"key":"braces } [ , and quote \""},{"key":2}],"b":{"nested":true},"n":null}`;
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
    expect(parseStrictJson('42')).toBe(42);
    expect(parseStrictJson('[]')).toEqual([]);
    expect(parseStrictJson('{}')).toEqual({});
  });

  it.each([
    '{"id":1,"id":2}',
    '{"outer":[{"a":1,"\\u0061":2}]}',
    '{"a\\\"b":1,"a\\\"b":2}',
    '{"value":1e400}',
    '-1e400',
    '{broken}',
    'NaN',
  ])('rejects ambiguous or invalid JSON: %s', text => {
    expect(() => parseStrictJson(text)).toThrow(SyntaxError);
  });
});

describe('actual asset validation', () => {
  it('verifies real ready files, with planned assets requiring no file access', async () => {
    const report = await validatePackageFiles(pkg(), { assetRoot: directory });
    expect(report).toMatchObject({ valid: true, errors: [] });
    expect(report.meaning).toContain('不代表');
  });

  it('returns schema failures without dereferencing untrusted input', async () => {
    const report = await validatePackageFiles(null, { assetRoot: path.join(directory, 'missing') });
    expect(report.errors.map(error => error.code)).toEqual(['SCHEMA']);
  });

  it('reports nonexistent and non-directory roots', async () => {
    for (const assetRoot of [path.join(directory, 'missing'), path.join(directory, 'img/a.png')]) {
      const report = await validatePackageFiles(pkg(), { assetRoot });
      expect(report.errors.some(error => error.code === 'ASSET_ROOT')).toBe(true);
    }
  });

  it('reports missing files and actual hash mismatch with asset context', async () => {
    const absent = mutate(pkg(), draft => { if (draft.assets[0]!.status === 'ready') draft.assets[0]!.file.path = 'missing.png'; });
    const missing = await validatePackageFiles(absent, { assetRoot: directory });
    expect(missing.errors).toContainEqual(expect.objectContaining({ code: 'ASSET_FILE', where: '/assets/0/file' }));
    const mismatch = await validatePackageFiles(makePackage(), { assetRoot: directory });
    expect(mismatch.errors).toContainEqual(expect.objectContaining({ code: 'ASSET_HASH', where: '/assets/0/file/sha256' }));
  });

  it('rejects directories advertised as files', async () => {
    const input = mutate(pkg(), draft => { if (draft.assets[0]!.status === 'ready') draft.assets[0]!.file.path = 'img'; });
    expect((await validatePackageFiles(input, { assetRoot: directory })).errors.some(error => error.code === 'ASSET_FILE')).toBe(true);
  });

  it.each(['../escape.png', '/absolute.png', 'C:/absolute.png', 'C:\\absolute.png', 'https://example.com/a.png', 'img/../../escape.png', 'img\u0000/a.png'])('rejects unsafe path %s before file reads', async filename => {
    const input = mutate(pkg(), draft => { if (draft.assets[0]!.status === 'ready') draft.assets[0]!.file.path = filename; });
    const report = await validatePackageFiles(input, { assetRoot: directory });
    expect(report.errors.some(error => error.code === 'ASSET_PATH')).toBe(true);
  });

  it('rejects symlink escapes after resolving the actual path', async () => {
    const root = path.join(directory, 'assets');
    await mkdir(root);
    await symlink(path.join(directory, 'img'), path.join(root, 'img'), process.platform === 'win32' ? 'junction' : 'dir');
    const report = await validatePackageFiles(pkg(), { assetRoot: root });
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'ASSET_PATH', where: '/assets/0/file/path' }));
  });

  it('allows symlinks whose resolved targets stay within the asset root', async () => {
    await symlink(path.join(directory, 'img'), path.join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const input = mutate(pkg(), draft => { if (draft.assets[0]!.status === 'ready') draft.assets[0]!.file.path = 'alias/a.png'; });
    expect((await validatePackageFiles(input, { assetRoot: directory })).valid).toBe(true);
  });

  it('does not accept an external file substituted after the initial path check', async () => {
    const root = path.join(directory, 'assets');
    const internal = path.join(root, 'img');
    await mkdir(internal, { recursive: true });
    await writeFile(path.join(internal, 'a.png'), 'different internal bytes');
    const checkedAsset = await fsPromises.realpath(path.join(internal, 'a.png'));
    const originalStat = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).stat;
    const statSpy = vi.mocked(fsPromises.stat);
    statSpy.mockImplementation(async (...args) => {
      const result = await originalStat(...args);
      if (args[0] === checkedAsset) {
        await fsPromises.rename(internal, path.join(root, 'old-img'));
        await symlink(path.join(directory, 'img'), internal, process.platform === 'win32' ? 'junction' : 'dir');
      }
      return result;
    });
    const report = await validatePackageFiles(pkg(), { assetRoot: root });
    expect(report.valid).toBe(false);
    expect(report.errors.some(error => error.code === 'ASSET_HASH' || error.code === 'ASSET_FILE')).toBe(true);
  });

  it('rejects a directory-junction swap before opening, without reading the external handle', async () => {
    const root = path.join(directory, 'assets');
    const internal = path.join(root, 'img');
    await mkdir(internal, { recursive: true });
    await writeFile(path.join(internal, 'a.png'), content);
    const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    let readWasAttempted = false;
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      await fsPromises.rename(internal, path.join(root, 'old-img'));
      await symlink(path.join(directory, 'img'), internal, process.platform === 'win32' ? 'junction' : 'dir');
      const handle = await actualOpen(...args);
      const originalRead = handle.createReadStream.bind(handle);
      vi.spyOn(handle, 'createReadStream').mockImplementation(options => { readWasAttempted = true; return originalRead(options); });
      return handle;
    });
    const report = await validatePackageFiles(pkg(), { assetRoot: root });
    expect(report.errors.some(error => error.code === 'ASSET_PATH')).toBe(true);
    expect(readWasAttempted).toBe(false);
  });

  it('rejects replacement by a different in-root inode after opening', async () => {
    const filename = path.join(directory, 'img/a.png');
    const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      await fsPromises.rename(filename, path.join(directory, 'img/old.png'));
      await writeFile(filename, content);
      return handle;
    });
    const report = await validatePackageFiles(pkg(), { assetRoot: directory });
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'ASSET_FILE', message: expect.stringContaining('identity changed') }));
  });

  it('refuses to certify a filesystem that cannot identify the opened file', async () => {
    const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      const metadata = await handle.stat({ bigint: true });
      metadata.ino = 0n;
      vi.spyOn(handle, 'stat').mockResolvedValue(metadata);
      return handle;
    });
    const report = await validatePackageFiles(pkg(), { assetRoot: directory });
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'ASSET_FILE', message: expect.stringContaining('usable file identity') }));
  });

  it('detects a concurrent write even when the bytes already read had the declared hash', async () => {
    const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);
      const originalRead = handle.createReadStream.bind(handle);
      vi.spyOn(handle, 'createReadStream').mockImplementation(options => {
        const stream = originalRead(options);
        stream.once('end', () => { appendFileSync(path.join(directory, 'img/a.png'), 'concurrent append'); });
        return stream;
      });
      return handle;
    });
    const report = await validatePackageFiles(pkg(), { assetRoot: directory });
    expect(report.errors).toContainEqual(expect.objectContaining({ code: 'ASSET_FILE', message: expect.stringContaining('changed while its hash') }));
  });

  it('propagates delivery-stage semantic failures', async () => {
    const report = await validatePackageFiles(pkg(), { assetRoot: directory, stage: 'delivery' });
    expect(report.errors.some(error => error.code === 'TAKE_COVERAGE')).toBe(true);
  });
});

describe('file and CLI boundaries', () => {
  async function packageFile() {
    const filename = path.join(directory, 'package.json');
    await writeFile(filename, JSON.stringify(pkg()));
    return filename;
  }

  it('loads strict JSON from disk and defaults the asset root to the package directory', async () => {
    const filename = await packageFile();
    expect((await validatePackageFile(filename)).valid).toBe(true);
    expect((await validatePackageFile(filename, { assetRoot: directory, stage: 'planning' })).valid).toBe(true);
  });

  it('reports JSON parsing and file reading separately', async () => {
    const filename = path.join(directory, 'invalid.json');
    await writeFile(filename, '{"same":1,"same":2}');
    expect((await validatePackageFile(filename)).errors[0]?.code).toBe('JSON_PARSE');
    expect((await validatePackageFile(path.join(directory, 'absent.json'))).errors[0]?.code).toBe('PACKAGE_FILE');
    await writeFile(filename, Buffer.from([0xff]));
    expect((await validatePackageFile(filename)).errors[0]?.code).toBe('PACKAGE_FILE');
  });

  it('prints JSON reports and returns nonzero for invalid packages', async () => {
    const filename = await packageFile();
    let output = '';
    expect(await runCli([filename, '--asset-root', directory], text => { output = text; })).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ valid: true });
    expect(await runCli(['--delivery', filename], text => { output = text; })).toBe(1);
    expect(JSON.parse(output)).toMatchObject({ valid: false });
  });

  it.each([[], ['--unknown'], ['one.json', 'two.json'], ['--asset-root'], ['--asset-root', '--delivery'], ['--asset-root', 'assets', '--asset-root', 'assets']].map(args => ({ args })))('rejects malformed CLI arguments: $args', async ({ args }) => {
    let output = '';
    expect(await runCli(args, text => { output = text; })).toBe(2);
    expect(JSON.parse(output).errors[0].code).toBe('CLI_USAGE');
  });

  it('returns machine-readable help', async () => {
    let output = '';
    expect(await runCli(['--help'], text => { output = text; })).toBe(0);
    expect(JSON.parse(output).usage).toContain('--asset-root');
  });

  it('runs the actual CLI entry point with JSON stdout and process exit codes', async () => {
    const filename = await packageFile();
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const execute = promisify(execFile);
    const success = await execute(process.execPath, ['--import', 'tsx', 'src/node/cli-entry.ts', filename], { cwd });
    expect(JSON.parse(success.stdout)).toMatchObject({ valid: true });
    await expect(execute(process.execPath, ['--import', 'tsx', 'src/node/cli-entry.ts', filename, '--delivery'], { cwd })).rejects.toMatchObject({
      code: 1, stdout: expect.stringContaining('"valid":false'),
    });
  });
});

it('writes the schema from the canonical source into an explicit output directory', async () => {
  const output = path.join(directory, 'schemas');
  const generated = await generateSchemas(output);
  expect(generated).toEqual([path.join(output, 'storyboard-package.schema.json'), path.join(output, 'changeset.schema.json')]);
  expect(JSON.parse(await readFile(generated[0]!, 'utf8'))).toMatchObject({oneOf:[{type:'object',additionalProperties:false},{type:'object',additionalProperties:false},{type:'object',additionalProperties:false},{type:'object',additionalProperties:false}]});
  const changeSchema = JSON.parse(await readFile(generated[1]!, 'utf8'));
  expect(changeSchema.oneOf).toHaveLength(4);
  for(const branch of changeSchema.oneOf){expect(branch.required).toContain('base_revisions');expect(branch.additionalProperties).toBe(false);}
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/generate-schemas.ts', output], { cwd });
  expect(result.stdout).toContain(generated[0]);
});

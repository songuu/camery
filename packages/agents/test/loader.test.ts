import { mkdtemp, mkdir, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { dataDirectoryReader, methodPackReader } from '@camery/methods/node';
import { AgentRegistry } from '../src/registry.js';
import { loadAgentDefinition } from '../src/node/loader.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.mocked(open).mockReset().mockImplementation(actual.open); vi.mocked(realpath).mockReset().mockImplementation(actual.realpath);
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('camery-agent-loader-')) throw new Error('Unexpected temporary directory');
    await rm(resolved, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'camery-agent-loader-')); roots.push(root);
  const metadata = { id: 'research', version: '1.0.0', tools: [], methods: [], modelTier: 'deterministic', writeKinds: ['chapter'],
    budget: { maxSteps: 3, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' },
    outputSchema: { type: 'object', properties: { candidate: { type: 'string' } }, required: ['candidate'], additionalProperties: false }, files: { instructions: 'instructions.md' } };
  await writeFile(path.join(root, 'agent.yaml'), JSON.stringify(metadata)); await writeFile(path.join(root, 'instructions.md'), 'Use the pinned method; propose a candidate only.');
  return { root, metadata };
}
it('loads strict JSON metadata plus declared instructions into an immutable registered definition', async () => {
  const { root, metadata } = await fixture(); const loaded = await loadAgentDefinition(root);
  const { files: _files, ...definition } = metadata;
  expect(loaded).toEqual({ ...definition, instructions: 'Use the pinned method; propose a candidate only.' });
  expect(Object.isFrozen(loaded)).toBe(true); expect(Object.isFrozen(loaded.budget)).toBe(true);
  const first = new AgentRegistry().register(loaded);
  await writeFile(path.join(root, 'instructions.md'), 'Changed instructions.');
  expect(new AgentRegistry().register(await loadAgentDefinition(root)).digest).not.toBe(first.digest);
});
it.each(['script', 'inline-instructions', 'extra-file', 'wrong-instructions', 'missing-files', 'invalid-schema', 'invalid-budget'] as const)('rejects non-data or malformed agent declarations: %s', async kind => {
  const { root, metadata } = await fixture(); let value: unknown = metadata;
  if (kind === 'script') value = { ...metadata, script: 'process.exit()' };
  if (kind === 'inline-instructions') value = { ...metadata, instructions: 'Override file instructions.' };
  if (kind === 'extra-file') value = { ...metadata, files: { ...metadata.files, execute: 'run.js' } };
  if (kind === 'wrong-instructions') value = { ...metadata, files: { instructions: '../outside.md' } };
  if (kind === 'missing-files') { const { files: _files, ...rest } = metadata; value = rest; }
  if (kind === 'invalid-schema') value = { ...metadata, outputSchema: { type: 'object', $ref: 'https://other.test/schema' } };
  if (kind === 'invalid-budget') value = { ...metadata, budget: { ...metadata.budget, maxSteps: 0 } };
  await writeFile(path.join(root, 'agent.yaml'), JSON.stringify(value)); await expect(loadAgentDefinition(root)).rejects.toThrow();
});
it.each(['id: research\nversion: 1.0.0', '{"id":"research","id":"other"}', '{bad-json}'])('rejects YAML syntax, duplicate JSON keys and malformed JSON', async value => {
  const { root } = await fixture(); await writeFile(path.join(root, 'agent.yaml'), value);
  await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_JSON' });
});
it.each(['agent.yaml', 'instructions.md'])('rejects invalid UTF8 in %s', async file => {
  const { root } = await fixture(); await writeFile(path.join(root, file), Buffer.from([255]));
  await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_UTF8' });
});
it('rejects missing roots, regular-file roots, missing assets and directory assets', async () => {
  const { root } = await fixture();
  await expect(loadAgentDefinition(path.join(root, 'absent'))).rejects.toMatchObject({ code: 'PACK_ROOT' });
  await expect(loadAgentDefinition(path.join(root, 'agent.yaml'))).rejects.toMatchObject({ code: 'PACK_ROOT' });
  await rm(path.join(root, 'instructions.md')); await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_FILE' });
  await mkdir(path.join(root, 'instructions.md')); await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_FILE' });
});
it('rejects a linked instruction leaf and preserves the outside directory', async () => {
  const { root } = await fixture(); const outside = await fixture();
  await rm(path.join(root, 'instructions.md')); await symlink(outside.root, path.join(root, 'instructions.md'), 'junction');
  await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_PATH' });
  expect(await readFile(path.join(outside.root, 'instructions.md'), 'utf8')).toBe('Use the pinned method; propose a candidate only.');
});
it('rejects a junction ancestor in a generic data directory', async () => {
  const { root } = await fixture(); const outside = await fixture();
  await symlink(outside.root, path.join(root, 'linked'), 'junction'); const reader = await dataDirectoryReader(root);
  await expect(reader.read('linked/instructions.md')).rejects.toMatchObject({ code: 'PACK_PATH' });
});
it.each(['../instructions.md', '/etc/passwd', 'C:/outside.md', 'nested/../instructions.md', 'nested\\instructions.md', 'nested//instructions.md', '.hidden', 'nested/%2e%2e.md', 'nested/foo:bar.md', 'nested/\u0000.md'])('rejects unsafe generic asset paths: %s', async relative => {
  const { root } = await fixture(); const reader = await dataDirectoryReader(root);
  await expect(reader.read(relative)).rejects.toMatchObject({ code: 'PACK_PATH' });
});
it('retains the method pack reader allowlist while the generic reader supports agent assets', async () => {
  const { root } = await fixture(); expect(await (await dataDirectoryReader(root)).read('agent.yaml')).toContain('research');
  await expect((await methodPackReader(root)).read('agent.yaml')).rejects.toMatchObject({ code: 'PACK_PATH' });
});
it('rejects a resolved asset outside the directory boundary', async () => {
  const { root } = await fixture(); const outside = await fixture();
  vi.mocked(realpath).mockImplementation(async filename => path.basename(String(filename)) === 'instructions.md' && path.basename(path.dirname(String(filename))) === path.basename(root) ? path.join(outside.root, 'instructions.md') : actual.realpath(filename));
  await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_PATH' });
});
it('enforces the 1MiB file limit and cumulative 2MiB read limit', async () => {
  const { root } = await fixture(); await writeFile(path.join(root, 'instructions.md'), Buffer.alloc(1_048_577, 32));
  await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_FILE_LIMIT' });
  await writeFile(path.join(root, 'asset.json'), ' '.repeat(800000)); const reader = await dataDirectoryReader(root);
  await reader.read('asset.json'); await reader.read('asset.json'); await expect(reader.read('asset.json')).rejects.toMatchObject({ code: 'PACK_BUNDLE_LIMIT' });
});
function injectHandle(change: (handle: FileHandle) => Promise<void>): void {
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args); if (String(args[0]).endsWith(path.sep + 'instructions.md')) await change(handle); return handle;
  });
}
function metadata(value: BigIntStats, changes: Partial<BigIntStats>): BigIntStats { return Object.assign(Object.create(Object.getPrototypeOf(value)), value, changes) as BigIntStats; }
it.each(['missing-identity', 'replaced-before-read', 'changed-during-read'] as const)('rejects untrustworthy file evidence: %s', async scenario => {
  const { root } = await fixture();
  injectHandle(async handle => {
    const before = await handle.stat({ bigint: true }); const spy = vi.spyOn(handle, 'stat');
    if (scenario === 'missing-identity') spy.mockResolvedValue(metadata(before, { ino: 0n }));
    else if (scenario === 'replaced-before-read') spy.mockResolvedValue(metadata(before, { ino: before.ino + 1n }));
    else spy.mockResolvedValueOnce(before).mockResolvedValue(metadata(before, { mtimeNs: before.mtimeNs + 1n }));
  });
  await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: scenario === 'missing-identity' ? 'PACK_FILE' : 'PACK_CHANGED' });
});
it('enforces byte limits while reading growth after the initial stat', async () => {
  const { root } = await fixture();
  injectHandle(async handle => { vi.spyOn(handle, 'createReadStream').mockReturnValue(Readable.from([Buffer.alloc(1_048_577, 32)]) as ReturnType<FileHandle['createReadStream']>); });
  await expect(loadAgentDefinition(root)).rejects.toMatchObject({ code: 'PACK_FILE_LIMIT' });
});

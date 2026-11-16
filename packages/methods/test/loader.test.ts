import { mkdtemp, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { chapterPack, MethodRegistry } from '../src/index.js';
import { loadMethodPack } from '../src/node/loader.js';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});
const realOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(open).mockReset().mockImplementation(realOpen);
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith('camery-method-loader-')) throw new Error('Unexpected temporary directory');
    await rm(resolved, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'camery-method-loader-')); roots.push(root);
  const files = { instructions: 'instructions.md', rules: ['rules/quality.json'], examples: ['examples/examples.json'], cards: ['cards/cards.json'], evals: ['evals/golden.json'] };
  const metadata = { ...chapterPack.manifest, files };
  for (const directory of ['rules', 'examples', 'cards', 'evals']) await mkdir(path.join(root, directory));
  await writeFile(path.join(root, 'pack.yaml'), JSON.stringify(metadata));
  await writeFile(path.join(root, 'instructions.md'), chapterPack.instructions);
  await writeFile(path.join(root, files.rules[0]!), JSON.stringify(chapterPack.rules));
  await writeFile(path.join(root, files.examples[0]!), JSON.stringify(chapterPack.examples));
  await writeFile(path.join(root, files.cards[0]!), JSON.stringify(chapterPack.cards));
  const suite = { id: 'loader-golden', version: '1.0.0', cases: [{ id: 'one', input: { text: '第一章 出发\n正文' }, assertions: [{ id: 'offline', category: 'process', kind: 'offline' }] }] };
  await writeFile(path.join(root, files.evals[0]!), JSON.stringify(suite));
  return { root, metadata, suite };
}
it('loads JSON-subset pack metadata, all content classes and evaluation cases into the pinned bundle', async () => {
  const { root, suite } = await fixture(); const pack = await loadMethodPack(root);
  expect(pack).toMatchObject({ manifest: chapterPack.manifest, instructions: chapterPack.instructions, rules: chapterPack.rules, examples: chapterPack.examples, cards: chapterPack.cards, evals: [suite] });
  const first = new MethodRegistry().register(pack);
  await writeFile(path.join(root, 'instructions.md'), chapterPack.instructions + '\n补充说明。');
  const second = new MethodRegistry().register(await loadMethodPack(root)); expect(second.digest).not.toBe(first.digest);
});
it.each(['../outside.json', '/etc/passwd', 'rules/../outside.json', 'rules\\outside.json', 'https://other.test/a.json', 'rules/%2e%2e.json', 'rules/foo:bar.json'])('rejects unsafe declared asset path %s', async filename => {
  const { root, metadata } = await fixture(); metadata.files.rules = [filename];
  await writeFile(path.join(root, 'pack.yaml'), JSON.stringify(metadata));
  await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'INVALID_PACK_FILE' });
});
it('rejects duplicate declarations, unknown metadata and non-JSON YAML or duplicate keys', async () => {
  const { root, metadata } = await fixture();
  for (const text of [JSON.stringify({ ...metadata, extra: true }), JSON.stringify({ ...metadata, files: { ...metadata.files, rules: ['rules/quality.json', 'rules/quality.json'] } }), 'id: chapter-segmentation\nversion: 1.0.0', '{"id":"a","id":"b"}']) {
    await writeFile(path.join(root, 'pack.yaml'), text); await expect(loadMethodPack(root)).rejects.toThrow();
  }
});
it('rejects invalid JSON content, incorrect category shapes and invalid evaluation cases', async () => {
  const { root, metadata } = await fixture();
  for (const text of ['[ {"id":"a","id":"b"} ]', '{}', '[{"id":"broken","kind":"run-script","code":"process.exit()"}]']) {
    await writeFile(path.join(root, metadata.files.rules[0]!), text); await expect(loadMethodPack(root)).rejects.toThrow();
  }
  await writeFile(path.join(root, metadata.files.rules[0]!), JSON.stringify(chapterPack.rules));
  await writeFile(path.join(root, metadata.files.evals[0]!), '{"id":"bad"}'); await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'INVALID_SUITE' });
});
it('rejects non-UTF8 instructions and files over the byte limit', async () => {
  const { root } = await fixture();
  await writeFile(path.join(root, 'instructions.md'), Buffer.from([255])); await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_UTF8' });
  await writeFile(path.join(root, 'instructions.md'), Buffer.alloc(1_048_577, 32)); await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_FILE_LIMIT' });
});
it('bounds the total bytes read across declared files', async () => {
  const { root, metadata } = await fixture(); metadata.files.rules = ['rules/a.json', 'rules/b.json', 'rules/c.json'];
  await writeFile(path.join(root, 'pack.yaml'), JSON.stringify(metadata));
  for (const file of metadata.files.rules) await writeFile(path.join(root, file), '[]' + ' '.repeat(799998));
  await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_BUNDLE_LIMIT' });
});
it('rejects missing roots, missing assets and directory assets', async () => {
  const { root } = await fixture();
  await expect(loadMethodPack(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'PACK_ROOT' });
  await expect(loadMethodPack(path.join(root, 'pack.yaml'))).rejects.toMatchObject({ code: 'PACK_ROOT' });
  await rm(path.join(root, 'instructions.md')); await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_FILE' });
  await mkdir(path.join(root, 'instructions.md')); await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_FILE' });
});
it('rejects a declared category directory redirected outside the package by a junction', async () => {
  const { root } = await fixture(); const outside = await fixture();
  const rules = path.resolve(root, 'rules');
  if (path.dirname(rules) !== path.resolve(root)) throw new Error('Unexpected rules directory');
  await rm(rules, { recursive: true });
  await symlink(path.join(outside.root, 'rules'), rules, 'junction');
  await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_PATH' });
  expect(await readFile(path.join(outside.root, 'rules/quality.json'), 'utf8')).toBe(JSON.stringify(chapterPack.rules));
});
function injectHandle(filename: string, change: (handle: FileHandle) => Promise<void>): void {
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]).endsWith(path.sep + filename)) await change(handle);
    return handle;
  });
}
function metadata(value: BigIntStats, changes: Partial<BigIntStats>): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(value)), value, changes) as BigIntStats;
}
it.each(['missing-identity', 'replaced-before-read', 'changed-during-read'])('rejects unverifiable or changing filesystem evidence: %s', async scenario => {
  const { root } = await fixture();
  injectHandle('instructions.md', async handle => {
    const original = await handle.stat({ bigint: true }); const spy = vi.spyOn(handle, 'stat');
    if (scenario === 'missing-identity') spy.mockResolvedValue(metadata(original, { ino: 0n }));
    else if (scenario === 'replaced-before-read') spy.mockResolvedValue(metadata(original, { ino: original.ino + 1n }));
    else spy.mockResolvedValueOnce(original).mockResolvedValue(metadata(original, { mtimeNs: original.mtimeNs + 1n }));
  });
  await expect(loadMethodPack(root)).rejects.toMatchObject({ code: scenario === 'missing-identity' ? 'PACK_FILE' : 'PACK_CHANGED' });
});
it('enforces file byte limits while reading even if a file grows after stat', async () => {
  const { root } = await fixture();
  injectHandle('instructions.md', async handle => {
    vi.spyOn(handle, 'createReadStream').mockReturnValue(Readable.from([Buffer.alloc(1_048_577, 32)]) as ReturnType<FileHandle['createReadStream']>);
  });
  await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_FILE_LIMIT' });
});
it('enforces aggregate bytes while reading a file that grew after its precheck', async () => {
  const { root, metadata: manifest } = await fixture();
  await writeFile(path.join(root, 'instructions.md'), ' '.repeat(900000));
  await writeFile(path.join(root, manifest.files.rules[0]!), '[]' + ' '.repeat(899998));
  injectHandle('examples.json', async handle => {
    vi.spyOn(handle, 'createReadStream').mockReturnValue(Readable.from([Buffer.alloc(400000, 32)]) as ReturnType<FileHandle['createReadStream']>);
  });
  await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'PACK_BUNDLE_LIMIT' });
});
it('pins evaluation content as part of the bundle and caps per-class object counts', async () => {
  const { root, metadata: manifest, suite } = await fixture(); const first = new MethodRegistry().register(await loadMethodPack(root));
  await writeFile(path.join(root, manifest.files.evals[0]!), JSON.stringify({ ...suite, version: '1.0.1' }));
  const second = new MethodRegistry().register(await loadMethodPack(root)); expect(second.digest).not.toBe(first.digest);
  await writeFile(path.join(root, manifest.files.cards[0]!), JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ id: `card-${index}`, title: 'title', text: 'card' }))));
  await expect(loadMethodPack(root)).rejects.toMatchObject({ code: 'INVALID_PACK_FILE' });
});

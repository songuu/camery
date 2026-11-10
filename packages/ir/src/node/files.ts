import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { StoryboardPackage } from '../schema';
import { validatePackage } from '../validate';
import type { Issue, ValidationOptions, ValidationReport } from '../validate';
import { parseStrictJson } from './strict-json';

export interface FileValidationOptions extends ValidationOptions { assetRoot?: string }
export interface AssetValidationOptions extends ValidationOptions { assetRoot: string }

const meaning = '检查结构、引用、声明覆盖、时间及本次读取的就绪素材文件/哈希；不代表事实、艺术、媒体内容质量或外部软件接受。';

export function boundaryFailure(code: string, where: string, message: string): ValidationReport {
  return { valid: false, errors: [{ code, where, message }], warnings: [], meaning };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function staysWithin(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function unsafePath(filename: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(filename) || filename.includes('\\') || filename.includes('\0') || filename.split('/').includes('..');
}

function usableIdentity(metadata: BigIntStats): boolean {
  return metadata.ino > 0n && metadata.dev >= 0n;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function validatePackageFiles(input: unknown, options: AssetValidationOptions): Promise<ValidationReport> {
  const report = validatePackage(input, options);
  const parsed = StoryboardPackage.safeParse(input);
  if (!parsed.success) return report;
  const errors: Issue[] = [...report.errors];
  const failure = (code: string, where: string, message: string) => { errors.push({ code, where, message }); };
  const result = (): ValidationReport => ({ ...report, valid: errors.length === 0, errors, meaning });

  let root: string;
  try {
    root = await realpath(options.assetRoot);
    if (!(await stat(root)).isDirectory()) throw new Error('Asset root is not a directory.');
  } catch (error) {
    failure('ASSET_ROOT', '/asset_root', `Cannot use asset root ${JSON.stringify(options.assetRoot)}: ${errorMessage(error)}`);
    return result();
  }

  for (const [index, asset] of parsed.data.assets.entries()) {
    if (asset.status !== 'ready') continue;
    const where = `/assets/${index}/file`;
    const filename = asset.file.path;
    if (unsafePath(filename)) {
      if (!errors.some(issue => issue.code === 'ASSET_PATH' && issue.where === where + '/path')) {
        failure('ASSET_PATH', where + '/path', `Asset ${asset.id} has an unsafe relative path ${JSON.stringify(filename)}.`);
      }
      continue;
    }
    try {
      const candidate = path.resolve(root, filename);
      const actual = await realpath(candidate);
      if (!staysWithin(root, actual)) {
        failure('ASSET_PATH', where + '/path', `Asset ${asset.id} resolves outside the asset root: ${JSON.stringify(filename)}.`);
        continue;
      }
      const handle = await open(actual, 'r');
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) throw new Error('Expected a regular file.');
        if (!usableIdentity(before)) throw new Error('Filesystem did not provide a usable file identity; containment cannot be verified.');

        // Re-resolve after open: hashing must use this handle, never reopen a checked pathname.
        // These consistency checks are not an OS sandbox against hostile concurrent directory rewrites.
        const afterOpenPath = await realpath(candidate);
        if (!staysWithin(root, afterOpenPath)) {
          failure('ASSET_PATH', where + '/path', `Asset ${asset.id} resolved outside the root after opening: ${JSON.stringify(filename)}.`);
          continue;
        }
        const atPath = await stat(afterOpenPath, { bigint: true });
        if (!usableIdentity(atPath) || !sameIdentity(before, atPath)) throw new Error('Asset path identity changed after opening.');

        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat({ bigint: true });
        if (!sameSnapshot(before, after)) throw new Error('Asset changed while its hash was being verified.');
        if (hash.digest('hex') !== asset.file.sha256) {
          failure('ASSET_HASH', where + '/sha256', `Asset ${asset.id} hash differs from the file at ${JSON.stringify(filename)}.`);
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      failure('ASSET_FILE', where, `Cannot verify asset ${asset.id} at ${JSON.stringify(filename)}: ${errorMessage(error)}`);
    }
  }
  return result();
}

export async function validatePackageFile(filename: string, options: FileValidationOptions = {}): Promise<ValidationReport> {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(filename));
  } catch (error) {
    return boundaryFailure('PACKAGE_FILE', filename, `Cannot read package: ${errorMessage(error)}`);
  }
  let input: unknown;
  try {
    input = parseStrictJson(source);
  } catch (error) {
    return boundaryFailure('JSON_PARSE', filename, `Invalid package JSON: ${errorMessage(error)}`);
  }
  return validatePackageFiles(input, { ...options, assetRoot: options.assetRoot ?? path.dirname(path.resolve(filename)) });
}

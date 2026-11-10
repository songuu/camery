import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRECTORIES = new Set(['.git', '.claude', '.agents', '.codex', 'node_modules', 'coverage', 'dist']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** This deliberately checks a small, explicit policy; TypeScript performs type checking separately. */
export function findPolicyViolations(filename, source) {
  const violations = [];
  const extension = path.extname(filename);
  if (!CODE_EXTENSIONS.has(extension) && extension !== '.json') return violations;

  const lines = source.split(/\r?\n/);
  for (const [offset, line] of lines.entries()) {
    if (/^(?:<{7}|={7}|>{7})(?:\s|$)/.test(line)) {
      violations.push({ line: offset + 1, rule: 'merge-conflict', message: 'Unresolved merge conflict marker.' });
    }
    if (CODE_EXTENSIONS.has(extension) && /(?:\/\/|\/\*)\s*@ts-(?:ignore|nocheck)\b/.test(line)) {
      violations.push({ line: offset + 1, rule: 'typescript-suppression', message: 'Use a typed fix instead of disabling TypeScript checking.' });
    }
  }

  if (extension === '.json') {
    try {
      JSON.parse(source);
    } catch (error) {
      violations.push({ line: 1, rule: 'invalid-json', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return violations;
}

async function* sourceFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
      yield* sourceFiles(path.join(directory, entry.name));
    } else if (entry.isFile()) {
      const filename = path.join(directory, entry.name);
      if (CODE_EXTENSIONS.has(path.extname(filename)) || path.extname(filename) === '.json') yield filename;
    }
  }
}

async function main() {
  let fileCount = 0;
  let issueCount = 0;
  for await (const filename of sourceFiles(ROOT)) {
    const source = await readFile(filename, 'utf8');
    fileCount += 1;
    for (const violation of findPolicyViolations(filename, source)) {
      console.error(`${path.relative(ROOT, filename)}:${violation.line} [${violation.rule}] ${violation.message}`);
      issueCount += 1;
    }
  }
  console.log(`Source policy: ${fileCount} files checked, ${issueCount} violations.`);
  if (issueCount > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Source policy could not finish:', error);
    process.exitCode = 1;
  });
}

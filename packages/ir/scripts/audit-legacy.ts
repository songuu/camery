import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrateV03 } from '../src/node/migrate-v03';
import type { MigrationOptions } from '../src/node/migrate-v03';
import { parseStrictJson } from '../src/node/strict-json';

type Data = null | boolean | number | string | Data[] | { [key: string]: Data };
type Path = (string | number)[];
type Mutation = { at: Path; replacement: Data } | { at: Path; remove: true };
type AuditCase = { fixture: string; path: Path; input: Data };
let stage: 'arguments' | 'fixture-loading' | 'baseline-migration' | 'mutation-enumeration' | 'legacy-oracle' | 'report-validation' | 'report-output' = 'arguments';
const replacements: Data[] = [null, true, 0, -1, 0.5, '', {}, []];
function mutations(value: Data, at: Path = [], result: Mutation[] = []): Mutation[] {
  for (const replacement of replacements) if (JSON.stringify(value) !== JSON.stringify(replacement)) result.push({ at, replacement });
  if (Array.isArray(value)) {
    if (value.length) result.push({ at, replacement: [...value, value[0]!] });
    value.forEach((child, index) => mutations(child, [...at, index], result));
  } else if (value && typeof value === 'object') {
    result.push({ at, replacement: { ...value, __audit_unknown_field: true } });
    for (const [key, child] of Object.entries(value)) { result.push({ at: [...at, key], remove: true }); mutations(child, [...at, key], result); }
  }
  return result;
}
function changed(original: Data, mutation: Mutation): Data {
  if (!mutation.at.length) return 'replacement' in mutation ? mutation.replacement : null;
  const copy = structuredClone(original); let parent = copy as Record<string | number, Data>;
  for (const key of mutation.at.slice(0, -1)) parent = parent[key] as Record<string | number, Data>;
  const key = mutation.at.at(-1)!;
  if ('remove' in mutation) delete parent[key]; else parent[key] = mutation.replacement;
  return copy;
}
const oracle = `import json,sys,importlib.util
sys.dont_write_bytecode=True
r=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('camery_legacy_oracle',r['module'])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
mismatches=[]
for case in r['cases']:
    report=module.validate(case['input'],r['schema'],r['root'])
    if not report['valid']:
        mismatches.append({'fixture':case['fixture'],'path':case['path'],'codes':sorted(set(row['code'] for row in report['errors']))})
print(json.dumps({'count':len(mismatches),'examples':mismatches[:20]}))
`;

/** Manual bounded differential audit; no package, asset, baseline or database is written. */
async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Usage: pnpm --filter @camery/ir audit:legacy');
  stage = 'fixture-loading';
  const legacyRoot = new URL('../../../storyboard_platform_v3/', import.meta.url);
  const moduleUrl = new URL('tools/validate_package.py', legacyRoot);
  const schemaBytes = await readFile(new URL('contracts/storyboard_package.schema.json', legacyRoot));
  const schema = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(schemaBytes));
  const accepted: AuditCase[] = []; const baselines: AuditCase[] = []; let tested = 0;
  const fixtureHashes: Record<string, string> = {};
  for (const fixture of ['fiction', 'knowledge']) {
    stage = 'fixture-loading';
    const bytes = await readFile(new URL(`examples/${fixture}_package.json`, legacyRoot));
    fixtureHashes[fixture] = createHash('sha256').update(bytes).digest('hex');
    const original = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Data;
    const options = parseStrictJson(await readFile(new URL(`../examples/${fixture}.v03-migration.options.json`, import.meta.url), 'utf8')) as MigrationOptions;
    stage = 'baseline-migration';
    // A rejecting migrator must not make a differential audit pass vacuously.
    if (!migrateV03(original, options).ok) throw new Error('Original fixture must migrate before mutation auditing');
    baselines.push({ fixture, path: [], input: original });
    stage = 'mutation-enumeration';
    for (const mutation of mutations(original)) {
      const input = changed(original, mutation); tested++;
      if (migrateV03(input, options).ok) accepted.push({ fixture, path: mutation.at, input });
    }
  }
  stage = 'legacy-oracle';
  const result = spawnSync('python', ['-c', oracle], {
    input: JSON.stringify({ schema, module: fileURLToPath(moduleUrl), root: fileURLToPath(legacyRoot), cases: [...baselines, ...accepted] }),
    encoding: 'utf8', timeout: 60000, maxBuffer: 1048576,
  });
  if (result.status !== 0 || result.error) throw new Error('Read-only legacy oracle failed; Python with jsonschema and the original v0.3 validator are required');
  stage = 'report-validation';
  const report = parseStrictJson(result.stdout) as { count: number; examples: unknown[] };
  if (!Number.isSafeInteger(report.count) || report.count < 0 || !Array.isArray(report.examples)) throw new Error('Invalid legacy oracle response');
  stage = 'report-output';
  console.log(JSON.stringify({
    scope: 'Two fixtures, single-site type/deletion/unknown-field/duplicate-array mutations; not a complete schema-equivalence proof',
    readOnly: true, baselineCount: baselines.length, tested, migrationAccepted: accepted.length, legacyMismatches: report.count, examples: report.examples,
    schemaSha256: createHash('sha256').update(schemaBytes).digest('hex'),
    validatorSha256: createHash('sha256').update(await readFile(moduleUrl)).digest('hex'), fixtureHashes,
  }));
  if (report.count) process.exitCode = 1;
}
main().catch(() => { console.error(`Legacy audit failed during ${stage}; check fixed fixtures, explicit migration options and the read-only Python/jsonschema oracle`); process.exitCode = 1; });

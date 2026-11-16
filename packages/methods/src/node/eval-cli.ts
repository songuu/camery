import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MethodError } from '../data.js';
import { readGoldenBaseline, writeGoldenBaseline } from './baseline.js';
import { loadMethodPack } from './loader.js';
import { runGoldenEvaluations } from './golden.js';

async function main(args: string[]): Promise<void> {
  let directory = fileURLToPath(new URL('../../../../method-packs/chapter-segmentation/', import.meta.url)); let update = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write-baseline' && !update) update = true;
    else if (args[i] === '--pack' && args[i + 1]) directory = path.resolve(args[++i]!);
    else throw new MethodError('INVALID_ARGUMENT', 'method evaluation CLI');
  }
  const pack = await loadMethodPack(directory);
  const prior: unknown = update ? undefined : await readGoldenBaseline(directory);
  const result = await runGoldenEvaluations(pack, prior);
  if (update) await writeGoldenBaseline(directory, result);
  console.log(`Method evaluations passed: ${result.reports.length} suites, ${result.reports.reduce((sum, report) => sum + report.cases.length, 0)} cases. Baseline ${update ? 'written; review this change before adoption' : 'matched'}.`);
}
main(process.argv.slice(2)).catch(error => { console.error(error instanceof MethodError ? error.message : 'EVALUATION_IO: method evaluation CLI'); process.exitCode = 1; });

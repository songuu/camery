import { boundaryFailure, validatePackageFile } from './files';
import type { FileValidationOptions } from './files';

const usage = 'validate <package.json> [--asset-root <directory>] [--delivery]';

/** Return an exit code; the process boundary owns stdout and termination. */
export async function runCli(args: readonly string[], write: (text: string) => void): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    write(JSON.stringify({ usage }) + '\n');
    return 0;
  }
  let filename: string | undefined;
  const options: FileValidationOptions = {};
  let invalid = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--delivery') options.stage = 'delivery';
    else if (arg === '--asset-root') {
      const root = args[++index];
      if (root === undefined || root.startsWith('--') || options.assetRoot !== undefined) { invalid = true; break; }
      options.assetRoot = root;
    } else if (arg.startsWith('--') || filename !== undefined) { invalid = true; break; }
    else filename = arg;
  }
  if (invalid || filename === undefined) {
    write(JSON.stringify(boundaryFailure('CLI_USAGE', '/arguments', usage)) + '\n');
    return 2;
  }
  const report = await validatePackageFile(filename, options);
  write(JSON.stringify(report) + '\n');
  return report.valid ? 0 : 1;
}

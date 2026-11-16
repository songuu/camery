import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export async function docker(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const result = await exec('docker', args, { cwd: workspaceRoot, env, encoding: 'utf8', timeout: 90000, maxBuffer: 65536 });
  return result.stdout.trim();
}

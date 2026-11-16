import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
const execute = promisify(execFile); const filename = fileURLToPath(new URL('../src/node/eval-cli.ts', import.meta.url));
it('checks the committed synthetic baseline from the actual CLI without modifying it', async () => {
  const { stdout, stderr } = await execute(process.execPath, ['--import', 'tsx', filename], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 20000 });
  expect(stderr).toBe(''); expect(stdout).toContain('Agent synthetic evaluations passed:'); expect(stdout).toContain('Baseline matched.'); expect(stdout).toContain('actual cost unknown');
}, 25000);
it('rejects unsupported CLI arguments with a safe nonzero failure', async () => {
  for (const args of [['--unexpected'], ['--write-baseline', '--unexpected']]) {
    await expect(execute(process.execPath, ['--import', 'tsx', filename, ...args], { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 20000 })).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('INVALID_AGENT_EVAL_ARGUMENT') });
  }
}, 25000);

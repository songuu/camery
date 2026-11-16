import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTurboBinary, workspaceInvocation } from './workspace.mjs';

test('native Turbo lookup has no shim, installer or architecture fallback', () => {
  for (const [platform, architecture, expected] of [
    ['win32', 'x64', '@turbo/windows-64/bin/turbo.exe'], ['linux', 'arm64', '@turbo/linux-arm64/bin/turbo'], ['darwin', 'x64', '@turbo/darwin-64/bin/turbo'],
  ]) {
    const requests = [];
    const resolved = resolveTurboBinary(specifier => { requests.push(specifier); return '/installed-native'; }, platform, architecture);
    assert.equal(resolved, '/installed-native');
    assert.deepEqual(requests, [expected]);
  }
  const missing = [];
  assert.throws(() => resolveTurboBinary(specifier => { missing.push(specifier); throw new Error('missing'); }, 'linux', 'x64'), /explicitly/);
  assert.deepEqual(missing, ['@turbo/linux-64/bin/turbo']);
  assert.throws(() => resolveTurboBinary(() => assert.fail('unsupported platform must not resolve'), 'freebsd', 'x64'), /Unsupported/);
});

test('workspace tasks use local caching and a strict, stable execution environment', () => {
  const input = { PATH: 'tool-path', TURBO_TOKEN: 'private-token', TURBO_REMOTE_ONLY: '1', CAMERY_TASK_RUNTIME: 'caller-controlled' };
  const invocation = workspaceInvocation(['typecheck'], input);
  assert.ok(invocation.args.includes('--cache=local:rw'));
  assert.ok(invocation.args.includes('--env-mode=strict'));
  assert.equal(invocation.options.env.TURBO_TOKEN, undefined);
  assert.equal(invocation.options.env.TURBO_REMOTE_ONLY, undefined);
  assert.equal(invocation.options.env.TURBO_TELEMETRY_DISABLED, '1');
  assert.match(invocation.options.env.CAMERY_TASK_RUNTIME, /^[0-9a-f]{64}$/);
  assert.notEqual(invocation.options.env.CAMERY_TASK_RUNTIME, input.CAMERY_TASK_RUNTIME);
  assert.equal(input.TURBO_TOKEN, 'private-token');
});

test('coverage is serialized and fresh execution cannot re-enable remote cache', () => {
  const coverage = workspaceInvocation(['test:coverage', '--fresh']);
  assert.ok(coverage.args.includes('--concurrency=1'));
  assert.ok(coverage.args.includes('--cache=local:w'));
  assert.ok(!coverage.args.some(value => value.includes('remote:')));
  assert.ok(workspaceInvocation(['test']).args.includes('--concurrency=4'));
});

test('only supported workspace tasks and bounded options are accepted', () => {
  assert.ok(workspaceInvocation(['eval:check', '--filter=@camery/methods']).args.includes('--filter=@camery/methods'));
  assert.ok(workspaceInvocation(['typecheck', '--dry=json']).args.includes('--dry=json'));
  for (const args of [[], ['start'], ['test:integration'], ['typecheck', '--cache=remote:rw'], ['typecheck', '--env-mode=loose'], ['build', '--', 'publish'],
    ['typecheck', '--filter=@camery/nonexistent'], ['build', '--filter=@camery/timeline']])
    assert.throws(() => workspaceInvocation(args), /Usage|Unsupported/);
});

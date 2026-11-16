import { expect, it } from 'vitest';
import { MethodRegistry, MethodRunner, chapterExecutor, chapterPack, digest } from '../src/index.js';
const context = () => ({ tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), idempotencyKey: 'request-a', signal: new AbortController().signal });
it('pins complete method content, preserves old versions and routes only explicit pins', () => {
  const registry = new MethodRegistry(); const original = structuredClone(chapterPack); const pin = registry.register(original);
  original.instructions = 'changed'; expect(registry.resolve(pin).instructions).not.toBe('changed');
  expect(registry.register(chapterPack)).toEqual(pin);
  expect(() => registry.register(original)).toThrow();
  expect(registry.route({ stage: 'input', inputKind: 'novel', language: 'zh' }, [pin])).toEqual(pin);
  expect(() => registry.route({ stage: 'input', inputKind: 'video', language: 'zh' }, [pin])).toThrow();
  const next = registry.register({ ...chapterPack, manifest: { ...chapterPack.manifest, version: '1.0.1' } });
  expect(() => registry.route({ stage: 'input', inputKind: 'novel', language: 'zh' }, [pin, next])).toThrow();
  expect(() => registry.resolve({ ...pin, digest: 'b'.repeat(64) })).toThrow();
});
it('segments exact source spans as candidates and records the actual bounded read tool', async () => {
  const registry = new MethodRegistry(); const pin = registry.register(chapterPack);
  const source = '序言\r\n第一章 开门\r\n正文😀\r\n第二章 回家\r\n结尾\r\n';
  const runner = new MethodRunner(registry, [chapterExecutor]);
  const result = await runner.run(pin, { text: source }, context());
  expect(result.status).toBe('candidate'); expect(result.method).toEqual(pin); expect(result.output).toMatchObject({ sourceDigest: digest(source), offsetUnit: 'utf16' });
  const output = result.output as { chapters: { start: number; end: number; title: string }[] };
  expect(output.chapters.map(value => source.slice(value.start, value.end)).join('')).toBe(source);
  expect(output.chapters.map(value => value.title)).toEqual(['', '第一章 开门', '第二章 回家']);
  expect(result.trace).toEqual([{ tool: 'chapter.segment', effect: 'read', network: false, evidence: 'deterministic', status: 'completed' }]);
});
it('rejects missing tools, malformed outputs, unknown rules and late or aborted execution', async () => {
  const registry = new MethodRegistry(); const pin = registry.register(chapterPack);
  await expect(new MethodRunner(registry, []).run(pin, { text: 'a' }, context())).rejects.toMatchObject({ code: 'TOOL_MISSING' });
  const invalid = { ...chapterExecutor, execute: async () => ({ wrong: true }) };
  await expect(new MethodRunner(registry, [invalid]).run(pin, { text: 'a' }, context())).rejects.toMatchObject({ code: 'OUTPUT_INVALID' });
  expect(() => registry.register({ ...chapterPack, rules: [{ id: 'bad', kind: 'eval-code', code: 'danger' }] })).toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(new MethodRunner(registry, [chapterExecutor]).run(pin, { text: 'a' }, { ...context(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  let reject: (reason: Error) => void = () => {};
  const stuck = { ...chapterExecutor, execute: () => new Promise<never>((_resolve, fail) => { reject = fail; }) };
  await expect(new MethodRunner(registry, [stuck], { timeoutMs: 10 }).run(pin, { text: 'a' }, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  reject(new Error('late sensitive reason')); await Promise.resolve();
});

import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import type { BibleDeploymentConfig } from '../src/bible-config.js';
import { createBibleModelRuntime } from '../src/bible-runtime.js';

const config: BibleDeploymentConfig = { tenantId: 'tenant-a', projectId: 'project-a', bibleDatabaseUrl: 'unused', taskDatabaseUrl: 'unused', workerId: 'worker-a', pollMs: 50, runsPerRound: 1,
  text: { label: '协议测试模型', baseUrl: 'https://models.example/v1', connectionId: 'text', modelIdentity: 'model-a', modeDigest: 'a'.repeat(64), structuredOutput: 'json_schema', timeoutMs: 1000,
    allowPrivateNetworks: false, allowInsecureHttp: false, token: 'fixture-token', currency: 'CNY', reservation: { tokens: 1000, costMicros: 10 }, pricing: { inputMicrosPerMillionTokens: 100, outputMicrosPerMillionTokens: 100 }, limits: { steps: 2, tokens: 2000, costMicros: 20 } } };
const task = { tenantId: config.tenantId, taskId: 'task-a' };
it('exposes no start preset when text is absent and limits presets to the deployment project', async () => {
  const disabled = createBibleModelRuntime({ ...config, text: null }); expect(disabled.presetFor('project-a')).toBeNull();
  await expect(disabled.sessionFor({ tenantId: 'tenant-a', execution: createBibleModelRuntime(config).presetFor('project-a')!.execution }, task)).rejects.toMatchObject({ code: 'MODEL_FAILED' });
  const ready = createBibleModelRuntime(config); expect(ready.presetFor('other')).toBeNull(); expect(ready.presetFor('project-a')).toMatchObject({ label: '协议测试模型', execution: { evidence: 'live_model', modelTier: 'economy' } });
  const { pricing: _pricing, ...unpriced } = config.text!;
  expect(createBibleModelRuntime({ ...config, text: unpriced }).presetFor('project-a')?.execution.pricing).toBeUndefined();
});
it('checks complete persisted execution identity before constructing any model session', async () => {
  const model = createBibleModelRuntime(config); const execution = model.presetFor('project-a')!.execution;
  for (const [tenantId, changed, request] of [['other', execution, task], ['tenant-a', execution, { ...task, tenantId: 'other' }], ['tenant-a', { ...execution, reservation: { ...execution.reservation, costMicros: 11 } }, task], ['tenant-a', { ...execution, evidence: 'synthetic_replay' as const }, task]] as const) {
    await expect(model.sessionFor({ tenantId, execution: changed }, request)).rejects.toMatchObject({ code: 'CONFLICT' });
  }
  const session = await model.sessionFor({ tenantId: 'tenant-a', execution }, task); expect(session.callsUsed).toBe(0);
  expect(session.profile).toEqual({ tenantId: 'tenant-a', connectionId: 'text', modeDigest: 'a'.repeat(64), modelIdentity: 'model-a', evidence: 'live_model' });
});
it('uses the real OpenAI HTTP adapter once and retains provider usage/id without retrying invalid responses', async () => {
  let calls = 0; const bodies: unknown[] = []; const headers: (string | undefined)[] = [];
  const server = createServer((request, response) => { void (async () => {
    calls++; headers.push(request.headers.authorization); const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    expect(request.url).toBe('/v1/chat/completions'); response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: `fixture-${calls}`, choices: [{ finish_reason: calls === 1 ? 'stop' : 'length', message: { role: 'assistant', content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  })().catch(() => { response.destroy(new Error('HTTP fixture failed')); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  try {
    const model = createBibleModelRuntime({ ...config, text: { ...config.text!, baseUrl: `http://127.0.0.1:${address.port}/v1`, allowPrivateNetworks: true, allowInsecureHttp: true } });
    const execution = model.presetFor('project-a')!.execution; const session = await model.sessionFor({ tenantId: 'tenant-a', execution }, task);
    const context = { tenantId: 'tenant-a', connectionId: 'text', modeDigest: 'a'.repeat(64), idempotencyKey: 'one', signal: new AbortController().signal };
    const input = { messages: [{ role: 'user' as const, content: '协议夹具' }], outputSchema: { name: 'fixture', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }, validate: (value: unknown) => JSON.stringify(value) === '{"ok":true}' };
    expect(await session.complete(input, context)).toMatchObject({ value: { ok: true }, receipt: { providerRequestId: 'fixture-1', evidence: 'live_model', usage: { inputTokens: 12, outputTokens: 4 } } });
    await expect(session.complete(input, context)).rejects.toMatchObject({ code: 'MODEL_KEY_REUSE' }); expect(calls).toBe(1);
    const invalid = await model.sessionFor({ tenantId: 'tenant-a', execution }, { ...task, taskId: 'task-b' });
    await expect(invalid.complete(input, { ...context, idempotencyKey: 'two' })).rejects.toMatchObject({ outcome: 'completed' }); expect(calls).toBe(2);
    expect(headers).toEqual(['Bearer fixture-token', 'Bearer fixture-token']); expect(bodies[0]).toMatchObject({ model: 'model-a', stream: false, response_format: { type: 'json_schema' } });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

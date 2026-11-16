import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { ComfyUiConnector, FalQueueConnector, ModelModeRegistry, NodeHttpTransport, OpenAiCompatibleLlm, RecordingTransport, ReplayTransport } from '../src/index.js';
import type { HttpTransport, Json } from '../src/index.js';
import { context } from './support.js';

it('records all three connectors over loopback HTTP, then runs the same pinned sequence offline from a synthetic cassette', async () => {
  const wire: string[] = [];
  const provider = createServer((req, res) => {
    wire.push(`${req.method} ${req.url}`);
    expect(req.headers.authorization).toBe('Bearer synthetic-transport-credential');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/chat/completions') res.end(JSON.stringify({ id: 'fixture-completion', choices: [{ message: { role: 'assistant', content: '{"scene":"fixture"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
    else if (req.url === '/prompt') res.end('{"prompt_id":"fixture-comfy","node_errors":{}}');
    else if (req.url === '/history/fixture-comfy') res.end(JSON.stringify({ 'fixture-comfy': { status: { status_str: 'success', completed: true }, outputs: { '9': { images: [{ filename: 'protocol.bin', subfolder: '', type: 'output' }] } } } }));
    else if (req.url?.startsWith('/view?')) { res.setHeader('content-type', 'application/octet-stream'); res.end(Buffer.from([1, 2, 3])); }
    else if (req.url === '/fixture/model/generate') res.end('{"request_id":"fixture-fal","status":"IN_QUEUE"}');
    else if (req.url === '/fixture/model/requests/fixture-fal/status') res.end('{"request_id":"fixture-fal","status":"COMPLETED"}');
    else if (req.url === '/fixture/model/requests/fixture-fal') res.end('{"artifact_ref":"synthetic-protocol-output"}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error('Expected mock TCP address');
  let closed = false;
  const close = async () => { if (closed) return; closed = true; provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); };
  try {
    const registry = new ModelModeRegistry();
    for (const [id, kind, connector, layer, field] of [['fixture-llm', 'llm', 'openai', 'text', 'content'], ['fixture-comfy', 'image', 'comfyui', 'anchor', 'identity'], ['fixture-fal', 'image', 'fal', 'anchor', 'identity']] as const) {
      const evidence = { value: null, source: 'fixture://synthetic-protocol', modeVersion: '1.0.0', verification: 'unverified', evaluationIds: [] };
      registry.register({ id, version: '1.0.0', kind, connector: { kind: connector, profile: 'synthetic-profile' },
        capabilities: Object.fromEntries(['durationSeconds', 'maxReferenceImages', 'firstFrame', 'lastFrame', 'nativeAudio', 'lipsync', 'aspectRatios', 'resolutions', 'inputSlots', 'promptLimits', 'maxConcurrency'].map(name => [name, evidence])),
        compiler: { [layer]: { sections: [field], separator: '\n', prefix: '' } }, cost: evidence, quality: { passed: null, total: null, evaluationIds: [], commonFailures: [] } });
    }
    const ctx = (id: string, call: string) => context({ modeDigest: registry.pin(id, '1.0.0').digest, idempotencyKey: `${id}:${call}` });
    async function run(transport: HttpTransport) {
      const llmPin = registry.pin('fixture-llm', '1.0.0');
      const llmPrompt = registry.compile(llmPin, { layer: 'text', sections: { content: 'one scene' } }).text;
      const llm = new OpenAiCompatibleLlm(transport, { model: 'synthetic-llm', structuredOutput: 'json_schema' });
      const completion = await llm.complete({ messages: [{ role: 'user', content: llmPrompt }], outputSchema: { name: 'scene', schema: { type: 'object', properties: { scene: { type: 'string' } }, required: ['scene'], additionalProperties: false } }, validate: (value: Json) => value !== null && typeof value === 'object' && !Array.isArray(value) && value['scene'] === 'fixture' }, ctx('fixture-llm', 'complete'));
      const comfy = new ComfyUiConnector(transport, { workflow: { '6': { class_type: 'SyntheticNode', inputs: { text: '' } } }, mappings: [{ parameter: 'text', nodeId: '6', inputPath: ['text'] }] });
      const prompt = registry.compile(registry.pin('fixture-comfy', '1.0.0'), { layer: 'anchor', sections: { identity: 'fixture person' } }).text;
      const queued = await comfy.submit({ text: prompt }, ctx('fixture-comfy', 'submit'));
      const finished = await comfy.poll(queued.id, ctx('fixture-comfy', 'poll'));
      const downloaded = await comfy.download({ filename: 'protocol.bin', subfolder: '', type: 'output' }, ctx('fixture-comfy', 'download'));
      const fal = new FalQueueConnector(transport, { endpoint: 'fixture/model/generate' });
      const falJob = await fal.submit({ prompt: 'synthetic fixture' }, ctx('fixture-fal', 'submit'));
      const falStatus = await fal.poll(falJob.id, ctx('fixture-fal', 'poll'));
      expect(falStatus.state).toBe('unknown');
      const result = await fal.result(falJob.id, ctx('fixture-fal', 'result'));
      return { completion, comfyState: finished.state, bytes: [...downloaded.bytes], falState: result.state, falResult: result.result };
    }
    const live = new NodeHttpTransport({ tenantId: 'tenant-test', connectionId: 'connection-test', baseUrl: `http://127.0.0.1:${address.port}`, allowPrivateNetworks: true, allowInsecureHttp: true, timeoutMs: 1000, maxInFlight: 1,
      auth: { scheme: 'Bearer', credentialRef: 'synthetic-only', resolveSecret: async () => 'synthetic-transport-credential' } });
    const recorded = new RecordingTransport(live, { kind: 'synthetic_contract', source: 'Loopback protocol emulator; not external providers or generated media', recordedAt: '2026-11-11T00:00:00.000Z' });
    const first = await run(recorded); const cassette = recorded.exportCassette();
    expect(cassette.entries).toHaveLength(7); expect(JSON.stringify(cassette)).not.toContain('synthetic-transport-credential');
    await expect(JSON.stringify(cassette, null, 2) + '\n').toMatchFileSnapshot('./fixtures/providers.synthetic.json');
    await close();
    const replay = new ReplayTransport(JSON.parse(JSON.stringify(cassette)));
    expect(await run(replay)).toEqual(first); replay.assertComplete(); expect(wire).toHaveLength(7);
    expect(first).toMatchObject({ comfyState: 'remote_succeeded', bytes: [1, 2, 3], falState: 'remote_succeeded' });
    expect(first).not.toHaveProperty('ready');
  } finally { await close(); }
});

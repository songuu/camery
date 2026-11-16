import { describe, expect, it, vi } from 'vitest';
import { ComfyUiConnector, decodeComfyProgress } from '../src/connectors/comfy.js';
import type { ComfyParameterMapping } from '../src/connectors/comfy.js';
import type { HttpReply, HttpTransport, Json, JsonObject } from '../src/types.js';
import { jsonValue } from '../src/json.js';
import { context, reply } from './support.js';

// Synthetic protocol fixtures: these tests do not claim that a real ComfyUI node generated media.
const workflow = (): JsonObject => ({
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'template', clip: ['4', 1] } },
  '3': { class_type: 'KSampler', inputs: { seed: 1, options: { steps: 4 } } },
  '9': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'fixture' } },
});
const mappings = (): ComfyParameterMapping[] => [
  { parameter: 'prompt', nodeId: '6', inputPath: ['text'] },
  { parameter: 'seed', nodeId: '3', inputPath: ['seed'] },
  { parameter: 'steps', nodeId: '3', inputPath: ['options', 'steps'] },
];
const parameters = (): JsonObject => ({ prompt: 'a paper boat', seed: 9, steps: 6 });
const file = () => ({ filename: 'frame 1.png', subfolder: 'outputs/day-1', type: 'output' as const });
const history = (status: Json = { status_str: 'success', completed: true }, outputs: Json = { '9': { images: [file()] } }): Json => ({ 'prompt-1': { status, outputs } });
function setup(responses: HttpReply[] = []) {
  const exchange = vi.fn<HttpTransport['exchange']>();
  for (const response of responses) exchange.mockResolvedValueOnce(response);
  const connector = new ComfyUiConnector({ exchange }, { workflow: workflow(), mappings: mappings() });
  return { connector, exchange };
}

describe('ComfyUI workflow templates', () => {
  it('maps only declared values into a detached API workflow and never mutates configuration', () => {
    const template = workflow(); const map = mappings();
    const connector = new ComfyUiConnector({ exchange: vi.fn() }, { workflow: template, mappings: map });
    (template['6'] as JsonObject)['class_type'] = 'mutated'; map[0]!.inputPath[0] = 'clip';
    const compiled = connector.compile(parameters());
    expect(compiled).toMatchObject({ '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a paper boat' } }, '3': { inputs: { seed: 9, options: { steps: 6 } } } });
    (compiled['6'] as JsonObject)['class_type'] = 'also-mutated';
    expect(connector.compile(parameters())['6']).toMatchObject({ class_type: 'CLIPTextEncode' });
  });
  it.each([
    {}, { nodes: [] }, { '1': null }, { '1': { class_type: '', inputs: {} } }, { '1': { class_type: 'Node', inputs: [] } },
  ])('rejects non API workflows %j', invalid => {
    expect(() => new ComfyUiConnector({ exchange: vi.fn() }, { workflow: invalid, mappings: [] })).toThrow();
  });
  it('rejects missing mappings, unsafe fields and duplicate or overlapping targets', () => {
    const invalidMaps = [
      [{ parameter: 'p', nodeId: 'missing', inputPath: ['text'] }],
      [{ parameter: 'p', nodeId: '6', inputPath: ['missing'] }],
      [{ parameter: 'p', nodeId: '6', inputPath: [] }],
      [{ parameter: 'p', nodeId: '6', inputPath: ['__proto__'] }],
      [{ parameter: '../p', nodeId: '6', inputPath: ['text'] }],
      [{ parameter: 'p', nodeId: '6', inputPath: ['clip', '0'] }],
      [{ parameter: 'p', nodeId: '6', inputPath: ['text'] }, { parameter: 'q', nodeId: '6', inputPath: ['text'] }],
      [{ parameter: 'p', nodeId: '3', inputPath: ['options'] }, { parameter: 'q', nodeId: '3', inputPath: ['options', 'steps'] }],
    ];
    for (const map of invalidMaps) expect(() => new ComfyUiConnector({ exchange: vi.fn() }, { workflow: workflow(), mappings: map })).toThrow();
    const connector = setup().connector;
    expect(() => connector.compile({ prompt: 'x', seed: 1 })).toThrow();
    expect(() => connector.compile({ ...parameters(), arbitrary: 'x' })).toThrow();
    expect(() => connector.compile({ ...parameters(), seed: Infinity })).toThrow();
  });
  it('can fan one declared parameter out to multiple distinct existing inputs', () => {
    const connector = new ComfyUiConnector({ exchange: vi.fn() }, { workflow: workflow(), mappings: [{ parameter: 'text', nodeId: '6', inputPath: ['text'] }, { parameter: 'text', nodeId: '9', inputPath: ['filename_prefix'] }] });
    expect(connector.compile({ text: 'same' })).toMatchObject({ '6': { inputs: { text: 'same' } }, '9': { inputs: { filename_prefix: 'same' } } });
  });
  it('accepts a fixed template with no variables and rejects malformed mapping collections or absent node inputs', () => {
    const connector = new ComfyUiConnector({ exchange: vi.fn() }, { workflow: workflow(), mappings: [] });
    expect(connector.compile({})).toEqual(workflow());
    expect(() => new ComfyUiConnector({ exchange: vi.fn() }, { workflow: workflow(), mappings: {} as ComfyParameterMapping[] })).toThrow();
    expect(() => new ComfyUiConnector({ exchange: vi.fn() }, { workflow: { '1': { class_type: 'Node' } }, mappings: [] })).toThrow();
  });
});

describe('ComfyUI remote protocol', () => {
  it('submits a single detached prompt and retains the remote ID without claiming a completed artifact', async () => {
    const { connector, exchange } = setup([reply({ prompt_id: 'prompt-1', number: 0, node_errors: {} })]);
    const input = parameters(); const ctx = context();
    const submitted = connector.submit(input, ctx); input['prompt'] = 'too late'; ctx.idempotencyKey = 'too-late-key';
    expect(await submitted).toEqual({ id: 'prompt-1', state: 'queued' });
    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange.mock.calls[0]![0]).toMatchObject({ method: 'POST', path: '/prompt', effect: 'submit', responseType: 'json', body: { client_id: 'request-test', prompt: { '6': { inputs: { text: 'a paper boat' } } } } });
    expect(exchange.mock.calls[0]![1].idempotencyKey).toBe('request-test');
  });
  it('keeps partial accepted node-error submissions unknown instead of blindly retrying', async () => {
    const { connector } = setup([reply({ prompt_id: 'prompt-1', node_errors: { '9': { errors: [{ details: 'private provider details' }] } } })]);
    expect(await connector.submit(parameters(), context())).toEqual({ id: 'prompt-1', state: 'unknown', result: { diagnostic: 'NODE_ERRORS' } });
  });
  it.each([{ number: 1 }, { prompt_id: '../escape' }, [], { prompt_id: '' }, { prompt_id: 'id', node_errors: [] }])('keeps malformed successful submission %j ambiguous', async body => {
    const { connector, exchange } = setup([reply(body)]);
    await expect(connector.submit(parameters(), context())).rejects.toMatchObject({ outcome: 'unknown' }); expect(exchange).toHaveBeenCalledOnce();
  });
  it.each([[400, 'rejected'], [503, 'unknown']] as const)('classifies HTTP %s without exposing raw provider errors', async (status, outcome) => {
    const { connector } = setup([reply({ error: 'token=do-not-log-this' }, status)]);
    try { await connector.submit(parameters(), context()); throw new Error('expected rejection'); }
    catch (error) { expect(error).toMatchObject({ outcome, httpStatus: status }); expect(String(error)).not.toContain('do-not-log'); }
  });
  it('requires successful completed history plus valid output references', async () => {
    const { connector, exchange } = setup([reply(history())]);
    const job = await connector.poll('prompt-1', context());
    expect(job.state).toBe('remote_succeeded'); expect(job.result).toMatchObject({ files: [file()] });
    expect(exchange.mock.calls[0]![0]).toMatchObject({ path: '/history/prompt-1', effect: 'read' }); expect(exchange).toHaveBeenCalledOnce();
  });
  it.each([
    [{ status_str: 'error', completed: false }, 'failed'],
    [{ status_str: 'success', completed: false }, 'unknown'],
    [{ status_str: 'future', completed: true }, 'unknown'],
    [null, 'unknown'],
    [{ status_str: 'success', completed: true, messages: [['execution_interrupted', {}]] }, 'failed'],
  ] as const)('never promotes incomplete/failed history %j', async (status, state) => {
    const { connector } = setup([reply(history(jsonValue(status)))]); expect((await connector.poll('prompt-1', context())).state).toBe(state);
  });
  it('does not promote empty or text-only successful outputs to a generated image', async () => {
    for (const outputs of [{}, { '9': { text: ['done'] } }]) {
      const { connector } = setup([reply(history(undefined, outputs))]); expect((await connector.poll('prompt-1', context())).state).toBe('unknown');
    }
  });
  it.each(['queued', 'running', 'unknown'] as const)('recovers %s from current queue after missing history', async state => {
    const tuple = [0, 'prompt-1', {}, {}, []];
    const { connector, exchange } = setup([reply({}), reply({ queue_running: state === 'running' ? [tuple] : [], queue_pending: state === 'queued' ? [tuple] : [] })]);
    expect(await connector.poll('prompt-1', context())).toEqual({ id: 'prompt-1', state });
    expect(exchange.mock.calls[1]![0]).toMatchObject({ method: 'GET', path: '/queue', effect: 'read' }); expect(exchange).toHaveBeenCalledTimes(2);
  });
  it('captures queue context and respects cancellation between history and queue reads', async () => {
    const { connector, exchange } = setup(); const ctx = context();
    exchange.mockImplementationOnce(async () => { ctx.tenantId = 'tampered'; return reply({}); }).mockResolvedValueOnce(reply({ queue_running: [], queue_pending: [] }));
    await connector.poll('prompt-1', ctx); expect(exchange.mock.calls[1]![1].tenantId).toBe('tenant-test');
    const controller = new AbortController();
    exchange.mockImplementationOnce(async () => { controller.abort(); return reply({}); });
    await expect(connector.poll('prompt-1', context({ signal: controller.signal }))).rejects.toMatchObject({ code: 'ABORTED' });
    expect(exchange).toHaveBeenCalledTimes(3);
  });
  it.each([{ queue_running: null, queue_pending: [] }, { queue_running: [], queue_pending: {} }])('rejects malformed queue %j', async queue => {
    const { connector } = setup([reply({}), reply(queue)]); await expect(connector.poll('prompt-1', context())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('rejects bad response descriptors and invalid IDs without following arbitrary paths', async () => {
    const { connector, exchange } = setup([reply(history(undefined, { '9': { images: [{ ...file(), filename: '../secret' }] } }))]);
    await expect(connector.poll('prompt-1', context())).rejects.toThrow();
    await expect(connector.poll('../escape', context())).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(exchange).toHaveBeenCalledOnce();
  });
  it('validates history output containers and supports temporary audio and animated output files', async () => {
    for (const outputs of [null, { '9': null }, { '9': { images: {} } }]) {
      const { connector } = setup([reply(history(undefined, outputs))]);
      await expect(connector.poll('prompt-1', context())).rejects.toThrow();
    }
    const temp = { ...file(), type: 'temp', subfolder: '' };
    const { connector } = setup([reply(history(undefined, { '9': { gifs: [temp], audio: [temp] } }))]);
    expect((await connector.poll('prompt-1', context())).result).toMatchObject({ files: [temp, temp] });
  });
  it('rejects invalid or already-aborted contexts before sending any request', async () => {
    const { connector, exchange } = setup();
    await expect(connector.submit(parameters(), context({ modeDigest: 'invalid' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(connector.submit(parameters(), context({ signal: {} as AbortSignal }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(connector.submit(parameters(), context({ tenantId: '' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const controller = new AbortController(); controller.abort();
    await expect(connector.submit(parameters(), context({ signal: controller.signal }))).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_sent' });
    expect(exchange).not.toHaveBeenCalled();
  });
  it('downloads encoded output descriptors as bytes without writing or claiming verified media', async () => {
    const bytes = Buffer.from([1, 2, 3]);
    const { connector, exchange } = setup([{ status: 200, contentType: 'image/png', body: { kind: 'bytes', base64: bytes.toString('base64') } }]);
    const downloaded = await connector.download(file(), context()); expect(downloaded.bytes).toEqual(new Uint8Array(bytes)); expect(downloaded.contentType).toBe('image/png');
    const path = exchange.mock.calls[0]![0].path; expect(new URL(path, 'https://example.test').searchParams.get('filename')).toBe('frame 1.png');
    expect(exchange.mock.calls[0]![0]).toMatchObject({ effect: 'read', responseType: 'bytes' });
  });
  it.each([
    { filename: '../x.png', subfolder: '', type: 'output' }, { filename: 'x.png', subfolder: '/absolute', type: 'output' },
    { filename: 'x.png', subfolder: 'a/../b', type: 'output' }, { filename: 'x.png', subfolder: 'a\\b', type: 'output' },
    { filename: 'x.png', subfolder: '', type: 'input' }, { filename: 'x.png', subfolder: '%2e%2e', type: 'temp' },
    { filename: 'C:drive-relative.png', subfolder: '', type: 'output' }, { filename: 'x.png', subfolder: 'C:/absolute', type: 'output' },
  ])('rejects dangerous remote file descriptor %j', async descriptor => {
    const { connector, exchange } = setup(); await expect(connector.download(descriptor as Parameters<ComfyUiConnector['download']>[0], context())).rejects.toThrow(); expect(exchange).not.toHaveBeenCalled();
  });
  it('rejects unsuccessful or nonbinary downloads', async () => {
    const failed = setup([reply({}, 404)]); await expect(failed.connector.download(file(), context())).rejects.toMatchObject({ code: 'HTTP_ERROR', outcome: 'not_applicable' });
    const json = setup([reply({ not: 'media' })]); await expect(json.connector.download(file(), context())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const invalid = setup([{ status: 200, contentType: null, body: { kind: 'bytes', base64: '%%%' } }]); await expect(invalid.connector.download(file(), context())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('reports reachable nodes without pretending that devices generated an image', async () => {
    const { connector } = setup([reply({ system: { python_version: 'fixture' }, devices: [{ name: 'cpu', type: 'cpu' }] })]);
    expect(await connector.health(context())).toEqual({ reachable: true, devices: 1 });
    const zero = setup([reply({ devices: [] })]); expect(await zero.connector.health(context())).toEqual({ reachable: true, devices: 0 });
    const invalid = setup([reply({ devices: 'gpu' })]); await expect(invalid.connector.health(context())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('ComfyUI progress decoder', () => {
  it('ignores binary previews, global/unrelated messages and unrecognized event types', () => {
    for (const message of [new Uint8Array([1, 2]), null, {}, '{}', JSON.stringify({ type: { toString: 'not callable' } }), JSON.stringify({ type: 'status', data: {} }), JSON.stringify({ type: 'progress', data: { prompt_id: 'another', value: 1, max: 10 } }), JSON.stringify({ type: 'executed', data: { prompt_id: 'prompt-1' } })]) expect(decodeComfyProgress(message, 'prompt-1')).toBeNull();
  });
  it('decodes progress and executing node events only for the expected prompt', () => {
    expect(decodeComfyProgress(JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 2, max: 10, node: '3' } }), 'prompt-1')).toEqual({ kind: 'progress', value: 2, max: 10, node: '3' });
    expect(decodeComfyProgress(JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 2, max: 10 } }), 'prompt-1')).toEqual({ kind: 'progress', value: 2, max: 10, node: null });
    expect(decodeComfyProgress(JSON.stringify({ type: 'executing', data: { prompt_id: 'prompt-1', node: '3' } }), 'prompt-1')).toEqual({ kind: 'executing', node: '3' });
  });
  it.each(['execution_success', 'executing'] as const)('requires authoritative history after %s', type => {
    expect(decodeComfyProgress(JSON.stringify({ type, data: { prompt_id: 'prompt-1', node: null } }), 'prompt-1')).toEqual({ kind: 'history_required' });
  });
  it.each(['execution_error', 'execution_interrupted'] as const)('reports %s without copying remote exception text', reason => {
    expect(decodeComfyProgress(JSON.stringify({ type: reason, data: { prompt_id: 'prompt-1', exception_message: 'secret' } }), 'prompt-1')).toEqual({ kind: 'failed', reason });
  });
  it.each([{ value: -1, max: 10 }, { value: 11, max: 10 }, { value: 0, max: 0 }, { value: '1', max: 10 }])('rejects invalid progress %j', data => {
    expect(() => decodeComfyProgress(JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', ...data } }), 'prompt-1')).toThrow();
  });
  it('rejects malformed recognized protocol frames explicitly', () => {
    expect(() => decodeComfyProgress('{', 'prompt-1')).toThrow();
    expect(() => decodeComfyProgress('[]', 'prompt-1')).toThrow();
    expect(() => decodeComfyProgress(JSON.stringify({ type: 'executing', data: { prompt_id: 'prompt-1', node: '../bad' } }), 'prompt-1')).toThrow();
    expect(() => decodeComfyProgress('{}', '../bad')).toThrow();
  });
});

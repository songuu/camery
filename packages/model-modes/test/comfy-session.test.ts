import { expect, it, vi } from 'vitest';
import { ComfyProgressSession } from '../src/connectors/comfy-session.js';
import { ModelError } from '../src/types.js';
import type { RemoteJob, WebSocketTransport } from '../src/types.js';
import { context } from './support.js';
const job = (state: RemoteJob['state']): RemoteJob => ({ id: 'prompt-1', state });
const terminal = JSON.stringify({ type: 'execution_success', data: { prompt_id: 'prompt-1' } });
const progress = JSON.stringify({ type: 'progress', data: { prompt_id: 'prompt-1', value: 1, max: 2 } });
const options = { pollIntervalMs: 5, reconnectDelayMs: 0, maxMonitorMs: 200 };
const quiet: WebSocketTransport = { events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) };
it('returns an HTTP terminal without opening a socket', async () => {
  const events = vi.fn(quiet.events); const poll = vi.fn(async () => job('remote_succeeded'));
  expect(await new ComfyProgressSession({ poll }, { events }, options).watch('prompt-1', 'original-client', context())).toEqual(job('remote_succeeded'));
  expect(events).not.toHaveBeenCalled();
});
it('URL-encodes the original submission client identity using the same validation as submit', async () => {
  let polls = 0; const clientId = 'task 中文 / ?';
  const events = vi.fn(async function* (_path: string) { yield terminal; });
  const actual = await new ComfyProgressSession({ poll: async () => job(++polls === 1 ? 'queued' : 'remote_succeeded') }, { events }, options).watch('prompt-1', clientId, context());
  expect(actual.state).toBe('remote_succeeded'); expect(events.mock.calls[0]?.[0]).toBe(`/ws?${new URLSearchParams({ clientId }).toString()}`);
});
it('requires history confirmation even after socket success, ignores other tasks and serializes progress callbacks', async () => {
  let polls = 0; const seen: unknown[] = [];
  const poll = vi.fn(async () => job(++polls < 3 ? 'queued' : 'remote_succeeded'));
  const events = vi.fn(async function* (_path: string) { yield terminal; yield JSON.stringify({ type: 'execution_success', data: { prompt_id: 'other' } }); yield progress; });
  const session = new ComfyProgressSession({ poll }, { events }, options);
  expect(await session.watch('prompt-1', 'original-client', context(), async event => { await Promise.resolve(); seen.push(event); })).toEqual(job('remote_succeeded'));
  expect(seen).toEqual([{ kind: 'history_required' }, { kind: 'progress', value: 1, max: 2, node: null }]);
  expect(events.mock.calls[0]?.[0]).toBe('/ws?clientId=original-client');
});
it('polls quiet sockets without creating overlapping next calls and releases a noncooperative iterator', async () => {
  let calls = 0; const next = vi.fn(() => new Promise<IteratorResult<string>>(() => {})); const returned = vi.fn(() => new Promise<IteratorResult<string>>(() => {}));
  const events: WebSocketTransport['events'] = () => ({ [Symbol.asyncIterator]: () => ({ next, return: returned }) });
  const poll = async () => job(++calls < 4 ? 'running' : 'remote_succeeded');
  expect(await new ComfyProgressSession({ poll }, { events }, options).watch('prompt-1', 'original-client', context())).toEqual(job('remote_succeeded'));
  await Promise.resolve(); expect(next).toHaveBeenCalledOnce(); expect(returned).toHaveBeenCalledOnce();
});
it('bounds reconnects, then confirms completion through HTTP alone', async () => {
  let calls = 0; const poll = async () => job(++calls < 7 ? 'unknown' : 'failed');
  const events = vi.fn(async function* () { yield await Promise.reject(new ModelError('WS_NETWORK_FAILED', 'synthetic', 'not_applicable')); });
  expect(await new ComfyProgressSession({ poll }, { events }, { ...options, maxReconnects: 1 }).watch('prompt-1', 'original-client', context())).toEqual(job('failed'));
  expect(events).toHaveBeenCalledTimes(2);
});
it.each(['AUTH_FAILED', 'SECRET_ECHO', 'WS_BUFFER_LIMIT'])('does not retry unsafe %s failures', async code => {
  const events = vi.fn(async function* () { yield await Promise.reject(new ModelError(code, 'synthetic', 'not_applicable')); });
  await expect(new ComfyProgressSession({ poll: async () => job('queued') }, { events }, options).watch('prompt-1', 'client', context())).rejects.toMatchObject({ code });
  expect(events).toHaveBeenCalledOnce();
});
it('bounds cancellation, stuck polls and callbacks without cancelling remote generation', async () => {
  const controller = new AbortController(); const poll = vi.fn(async () => job('queued'));
  const aborted = new ComfyProgressSession({ poll }, quiet, options).watch('prompt-1', 'client', context({ signal: controller.signal }));
  controller.abort(); await expect(aborted).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_applicable' });
  const pendingPoll = new ComfyProgressSession({ poll: () => new Promise(() => {}) }, quiet, { ...options, maxMonitorMs: 10 }).watch('prompt-1', 'client', context());
  await expect(pendingPoll).rejects.toMatchObject({ code: 'TIMEOUT' });
  let rejectCallback: (error: Error) => void = () => {};
  const events = async function* () { yield progress; };
  await expect(new ComfyProgressSession({ poll }, { events }, { ...options, maxMonitorMs: 10 }).watch('prompt-1', 'client', context(), () => new Promise((_resolve, reject) => { rejectCallback = reject; }))).rejects.toMatchObject({ code: 'TIMEOUT' });
  rejectCallback(new Error('late sensitive details')); await Promise.resolve();
});
it('sanitizes callback failures and rejects malformed job identities and configuration', async () => {
  const events = async function* () { yield progress; };
  await expect(new ComfyProgressSession({ poll: async () => job('queued') }, { events }, options).watch('prompt-1', 'client', context(), () => { throw new Error('sensitive'); })).rejects.toMatchObject({ code: 'PROGRESS_HANDLER_FAILED' });
  await expect(new ComfyProgressSession({ poll: async () => ({ ...job('failed'), id: 'other' }) }, quiet, options).watch('prompt-1', 'client', context())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  expect(() => new ComfyProgressSession({ poll: async () => job('queued') }, quiet, { maxReconnects: -1 })).toThrow();
  await expect(new ComfyProgressSession({ poll: async () => job('queued') }, quiet).watch('../bad', 'client', context())).rejects.toThrow();
});
it('recovers transient HTTP and synchronous socket failures, then returns copied authoritative output', async () => {
  let polls = 0;
  const result = { files: ['test.png'] };
  const poll = async (): Promise<RemoteJob> => {
    if (++polls === 1) throw new ModelError('NETWORK_FAILED', 'synthetic', 'not_applicable');
    return polls < 4 ? job('queued') : { ...job('remote_succeeded'), result };
  };
  const events = vi.fn(() => { throw new ModelError('TIMEOUT', 'synthetic', 'not_applicable'); });
  const actual = await new ComfyProgressSession({ poll }, { events }, { ...options, maxReconnects: 0 }).watch('prompt-1', 'client', context());
  expect(actual.result).toEqual(result); expect(actual.result).not.toBe(result); expect(events).toHaveBeenCalledOnce();
});
it.each(['poll', 'sync', 'async'] as const)('sanitizes unexpected %s source exceptions', async kind => {
  const failure = (): never => { throw new Error('sensitive details'); };
  const events: WebSocketTransport['events'] = kind === 'sync' ? failure : async function* () { failure(); yield ''; };
  const poll = kind === 'poll' ? async (): Promise<RemoteJob> => failure() : async () => job('queued');
  await expect(new ComfyProgressSession({ poll }, { events }, options).watch('prompt-1', 'client', context())).rejects.toMatchObject({ code: kind === 'poll' ? 'POLL_FAILED' : 'WS_NETWORK_FAILED' });
});
it('observes pre-cancellation and rejects invalid monitor contexts and job states', async () => {
  const poll = vi.fn(async () => job('queued')); const session = new ComfyProgressSession({ poll }, quiet, options);
  const controller = new AbortController(); controller.abort();
  await expect(session.watch('prompt-1', 'client', context({ signal: controller.signal }))).rejects.toMatchObject({ code: 'ABORTED' }); expect(poll).not.toHaveBeenCalled();
  await expect(session.watch('prompt-1', 'client', context({ modeDigest: 'bad' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(session.watch('prompt-1', 'client', context(), 'bad' as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(new ComfyProgressSession({ poll: async () => ({ id: 'prompt-1', state: 'bad' as never }) }, quiet, options).watch('prompt-1', 'client', context())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
});
it.each([{ pollIntervalMs: 0 }, { maxMonitorMs: 0 }, { reconnectDelayMs: -1 }, { maxReconnects: 21 }, { unknown: 1 }, { toString: 1 }, null, []].map(value => ({ value })))('rejects invalid monitor options $value', ({ value }) => {
  expect(() => new ComfyProgressSession({ poll: async () => job('queued') }, quiet, value as never)).toThrow();
});

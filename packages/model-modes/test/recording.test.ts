import { expect, it, vi } from 'vitest';
import { RecordingTransport, ReplayTransport } from '../src/recording.js';
import { ModelError } from '../src/types.js';
import type { HttpReply, HttpRequest, HttpTransport } from '../src/types.js';
import { context, reply } from './support.js';
const request: HttpRequest = { method: 'POST', path: '/chat/completions', body: { prompt: 'private source never stored in cassette request' }, effect: 'submit', responseType: 'json' };
const provenance = { kind: 'synthetic_contract' as const, source: 'local protocol test', recordedAt: '2026-11-10T00:00:00.000Z' };
it('records response/fingerprint with explicit provenance and replays offline without fallback', async () => {
  const upstream = { exchange: vi.fn(async () => reply({ value: 'saved' })) }; const recorder = new RecordingTransport(upstream, provenance);
  await recorder.exchange(request, context()); const cassette = recorder.exportCassette();
  expect(JSON.stringify(cassette)).not.toContain('private source'); expect(cassette.entries).toHaveLength(1);
  const replay = new ReplayTransport(cassette); expect(await replay.exchange(request, context())).toEqual(reply({ value: 'saved' })); replay.assertComplete();
  await expect(replay.exchange(request, context())).rejects.toMatchObject({ code: 'REPLAY_EXHAUSTED' }); expect(upstream.exchange).toHaveBeenCalledTimes(1);
});
it.each(['tenantId', 'connectionId', 'modeDigest', 'idempotencyKey'] as const)('cannot replay a record under a different %s', async field => {
  const recorder = new RecordingTransport({ exchange: async () => reply({}) }, provenance); await recorder.exchange(request, context());
  const replay = new ReplayTransport(recorder.exportCassette());
  await expect(replay.exchange(request, context({ [field]: field === 'modeDigest' ? 'b'.repeat(64) : 'other' }))).rejects.toMatchObject({ code: 'REPLAY_MISMATCH' });
  await expect(replay.exchange({ ...request, body: { prompt: 'changed' } }, context())).rejects.toMatchObject({ code: 'REPLAY_MISMATCH' });
  expect(() => replay.assertComplete()).toThrow(); await replay.exchange(request, context()); replay.assertComplete();
});
it('records sanitized errors, strips auth fields/signed URL query values and validates imported cassettes', async () => {
  const recorder = new RecordingTransport({ exchange: async () => reply({ access_token: 'credential', nested: [{ password: 'secret', url: 'https://user:pass@cdn.example/image.png?signature=private#fragment' }] }) }, provenance);
  await recorder.exchange(request, context()); const text = JSON.stringify(recorder.exportCassette());
  for (const secret of ['credential', 'secret', 'user:pass', 'signature', 'private#']) expect(text).not.toContain(secret);
  const failed = new RecordingTransport({ exchange: async () => { throw new Error('private API credential error'); } }, provenance);
  await expect(failed.exchange(request, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', outcome: 'unknown' });
  expect(JSON.stringify(failed.exportCassette())).not.toContain('credential');
  const playback = new ReplayTransport(failed.exportCassette()); await expect(playback.exchange(request, context())).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
  expect(() => new ReplayTransport({ version: 0, entries: [] })).toThrow(); expect(() => new RecordingTransport({} as HttpTransport, { ...provenance, recordedAt: 'yesterday' })).toThrow();
});
it('preserves call-start order under concurrency and refuses export while an exchange is pending', async () => {
  let release: (value: HttpReply) => void = () => {};
  const upstream = { exchange: vi.fn().mockImplementationOnce(async () => new Promise<HttpReply>(resolve => { release = resolve; })).mockResolvedValueOnce(reply({ value: 2 })) };
  const recorder = new RecordingTransport(upstream, provenance); const first = recorder.exchange(request, context());
  expect(() => recorder.exportCassette()).toThrow(); await recorder.exchange({ ...request, path: '/other' }, context()); release(reply({ value: 1 })); await first;
  const replay = new ReplayTransport(recorder.exportCassette()); expect(await replay.exchange(request, context())).toEqual(reply({ value: 1 }));
  expect(await replay.exchange({ ...request, path: '/other' }, context())).toEqual(reply({ value: 2 })); replay.assertComplete();
});
it('retains transport outcome codes but never raw error messages, and respects abort before consuming replay', async () => {
  const recorder = new RecordingTransport({ exchange: async () => { throw new ModelError('TIMEOUT', 'contains-private-value', 'unknown'); } }, provenance);
  await expect(recorder.exchange(request, context())).rejects.toMatchObject({ code: 'TIMEOUT' });
  expect(JSON.stringify(recorder.exportCassette())).not.toContain('contains-private-value');
  const replay = new ReplayTransport(recorder.exportCassette()); const aborted = new AbortController(); aborted.abort();
  await expect(replay.exchange(request, context({ signal: aborted.signal }))).rejects.toMatchObject({ code: 'ABORTED' });
  await expect(replay.exchange(request, context())).rejects.toMatchObject({ code: 'TIMEOUT', outcome: 'unknown' }); replay.assertComplete();
});
it('does not call an already-returned exchange not_sent when its response cannot be recorded', async () => {
  const recorder = new RecordingTransport({ exchange: async () => ({ status: 200, contentType: null, body: { kind: 'json', value: NaN } }) }, provenance);
  await expect(recorder.exchange(request, context())).rejects.toMatchObject({ code: 'RECORDING_FAILED', outcome: 'unknown' });
});
it('round-trips binary reads, primitive values and redacted invalid URLs without storing request payloads', async () => {
  const values: HttpReply[] = [reply(null), reply(['http://%', 42, false]), { status: 200, contentType: 'image/png', body: { kind: 'bytes', base64: 'AQID' } }];
  const recorder = new RecordingTransport({ exchange: async () => values.shift()! }, provenance);
  const read: HttpRequest = { method: 'GET', path: '/image', effect: 'read', responseType: 'bytes' };
  await recorder.exchange(read, context()); await recorder.exchange(read, context()); await recorder.exchange(read, context());
  const replay = new ReplayTransport(recorder.exportCassette());
  expect((await replay.exchange(read, context())).body).toEqual({ kind: 'json', value: null });
  expect((await replay.exchange(read, context())).body).toEqual({ kind: 'json', value: ['[REDACTED_URL]', 42, false] });
  expect((await replay.exchange(read, context())).body).toEqual({ kind: 'bytes', base64: 'AQID' }); replay.assertComplete();
});
it('bounds trace capacity before another call and rejects invalid imported identities and reply shapes', async () => {
  const upstream = { exchange: vi.fn(async () => reply({})) }; const recorder = new RecordingTransport(upstream, provenance);
  for (let i = 0; i < 1000; i++) await recorder.exchange(request, context());
  await expect(recorder.exchange(request, context())).rejects.toMatchObject({ code: 'RECORDING_LIMIT' }); expect(upstream.exchange).toHaveBeenCalledTimes(1000);
  const cassette = recorder.exportCassette(); cassette.entries.push(cassette.entries[0]!); expect(() => new ReplayTransport(cassette)).toThrow();
  await expect(recorder.exchange(request, context({ modeDigest: 'invalid' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  const invalid = new RecordingTransport({ exchange: async () => ({ ...reply({}), status: 700 }) }, provenance);
  await expect(invalid.exchange(request, context())).rejects.toMatchObject({ code: 'RECORDING_FAILED' });
});
it('replays rejected HTTP status and sanitizes nonstandard error codes and read failures', async () => {
  const cases = [new ModelError('AUTH_FAILED', 'private', 'rejected', 401), new ModelError('private-invalid-code', 'private', 'unknown'), new Error('private')];
  for (const error of cases) {
    const recorder = new RecordingTransport({ exchange: async () => { throw error; } }, provenance);
    const read: HttpRequest = { method: 'GET', path: '/status', effect: 'read', responseType: 'json' };
    await expect(recorder.exchange(read, context())).rejects.toThrow(); const replay = new ReplayTransport(recorder.exportCassette());
    await expect(replay.exchange(read, context())).rejects.toThrow(); replay.assertComplete();
  }
});

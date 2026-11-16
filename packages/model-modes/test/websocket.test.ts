import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { NodeWebSocketTransport } from '../src/websocket.js';
import { context } from './support.js';
const config = (baseUrl: string) => ({ tenantId: 'tenant-test', connectionId: 'connection-test', baseUrl, allowPrivateNetworks: true, allowInsecureHttp: true, timeoutMs: 1000, maxInFlight: 1 });
async function server(connected: (socket: WebSocket, request: IncomingMessage) => void) {
  const http = createServer(); const ws = new WebSocketServer({ noServer: true });
  const connections = new Set<Socket>(); http.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  http.on('upgrade', (request, socket, head) => {
    if (request.url === '/hang') return;
    if (request.url === '/unauthorized') { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
    if (request.url === '/redirect') { socket.end('HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
    ws.handleUpgrade(request, socket, head, client => connected(client, request));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { url: `http://127.0.0.1:${address.port}`, ws, close: async () => { for (const socket of ws.clients) socket.terminate(); for (const socket of connections) socket.destroy(); await new Promise<void>(resolve => ws.close(() => resolve())); http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); } };
}
const collect = async (events: AsyncIterable<string>): Promise<string[]> => { const result: string[] = []; for await (const event of events) result.push(event); return result; };
it('pins socket DNS, confines paths and keeps credentials inside the authenticated upgrade', async () => {
  const seen: unknown[] = []; const host = await server((socket, req) => { seen.push({ host: req.headers.host, auth: req.headers.authorization, path: req.url }); socket.send(Buffer.from([1, 2, 3])); socket.send('{"type":"status"}'); socket.close(); });
  try {
    const port = new URL(host.url).port; const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const transport = new NodeWebSocketTransport({ ...config(`http://comfy.example:${port}/api/`), lookup, auth: { scheme: 'Bearer', credentialRef: 'test-ref', resolveSecret: async () => 'synthetic-socket-secret' } });
    expect(await collect(transport.events('/ws?clientId=client-1', context()))).toEqual(['{"type":"status"}']);
    expect(lookup).toHaveBeenCalledOnce(); expect(seen).toEqual([{ host: `comfy.example:${port}`, auth: 'Bearer synthetic-socket-secret', path: '/api/ws?clientId=client-1' }]);
  } finally { await host.close(); }
});
it('captures scope before lazy iteration, bounds active capacity and observes pre-cancelled calls', async () => {
  let started: () => void = () => {}; const ready = new Promise<void>(resolve => { started = resolve; });
  const host = await server(socket => { socket.send('captured'); started(); });
  try {
    const transport = new NodeWebSocketTransport(config(host.url)); const controller = new AbortController();
    const original = context({ signal: controller.signal }); const captured = transport.events('/ws', original);
    original.tenantId = 'other'; const iterator = captured[Symbol.asyncIterator](); expect((await iterator.next()).value).toBe('captured'); await ready;
    await expect(collect(transport.events('/ws', context()))).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' });
    controller.abort(); await expect(iterator.next()).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(collect(transport.events('/ws', context({ signal: controller.signal })))).rejects.toMatchObject({ code: 'ABORTED' });
  } finally { await host.close(); }
});
it.each(['count', 'utf8', 'abrupt'] as const)('bounds malformed and interrupted %s streams', async kind => {
  const host = await server(socket => {
    if (kind === 'count') { socket.send('one'); socket.send('two'); }
    else if (kind === 'utf8') socket.send(Buffer.from([255]), { binary: false });
    else socket.terminate();
  });
  try {
    const transport = new NodeWebSocketTransport({ ...config(host.url), webSocket: { maxBufferedMessages: 1 } });
    await expect(collect(transport.events('/ws', context()))).rejects.toMatchObject({ code: { count: 'WS_BUFFER_LIMIT', utf8: 'WS_INVALID_FRAME', abrupt: 'WS_NETWORK_FAILED' }[kind] });
  } finally { await host.close(); }
});
it('reports authentication and handshake timeouts with safe error metadata', async () => {
  const host = await server(() => {});
  try {
    const transport = new NodeWebSocketTransport({ ...config(host.url), timeoutMs: 20, webSocket: { sessionMs: 500 } });
    await expect(collect(transport.events('/unauthorized', context()))).rejects.toMatchObject({ code: 'AUTH_FAILED', httpStatus: 401 });
    await expect(collect(transport.events('/hang', context()))).rejects.toMatchObject({ code: 'TIMEOUT' });
    const badAuth = new NodeWebSocketTransport({ ...config(host.url), auth: { scheme: 'Key', credentialRef: 'test', resolveSecret: async () => { throw new Error('sensitive'); } } });
    await expect(collect(badAuth.events('/ws', context()))).rejects.toMatchObject({ code: 'AUTH_RESOLUTION' });
  } finally { await host.close(); }
});
it.each([{ sessionMs: 0 }, { maxConnections: NaN }, { maxFrameBytes: 0 }, { maxBufferedMessages: 0 }, { maxMessages: Infinity }, { unknown: 1 }, { toString: 1 }, null, []].map(value => ({ value })))('rejects invalid socket limits $value', ({ value: webSocket }) => {
  expect(() => new NodeWebSocketTransport({ ...config('http://127.0.0.1'), webSocket: webSocket as never })).toThrow();
});
it('blocks mismatched scopes, private DNS and unsafe paths without opening a socket', async () => {
  const transport = new NodeWebSocketTransport({ ...config('http://example.test'), allowPrivateNetworks: false, lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
  expect(() => transport.events('/ws', context({ tenantId: 'other' }))).toThrow();
  expect(() => transport.events('//other.example', context())).toThrow();
  await expect(collect(transport.events('/ws', context()))).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS' });
  expect(() => new NodeWebSocketTransport({ ...config('http://127.0.0.1'), webSocket: { maxBufferedBytes: 0 } })).toThrow();
});
it.each(['buffer', 'messages', 'frame', 'secret'] as const)('bounds %s failures without returning unsafe progress', async kind => {
  const host = await server(socket => {
    if (kind === 'messages') { socket.send(Buffer.from([1])); socket.send(Buffer.from([2])); }
    else socket.send(kind === 'secret' ? 'synthetic-socket-secret' : 'x'.repeat(128));
  });
  try {
    const options = kind === 'buffer' ? { maxBufferedBytes: 64 } : kind === 'messages' ? { maxMessages: 1 } : kind === 'frame' ? { maxFrameBytes: 64 } : {};
    const transport = new NodeWebSocketTransport({ ...config(host.url), webSocket: options, auth: { scheme: 'Key', credentialRef: 'test', resolveSecret: async () => 'synthetic-socket-secret' } });
    const codes = { buffer: 'WS_BUFFER_LIMIT', messages: 'WS_MESSAGE_LIMIT', frame: 'WS_FRAME_LIMIT', secret: 'SECRET_ECHO' };
    await expect(collect(transport.events('/ws', context()))).rejects.toMatchObject({ code: codes[kind] });
  } finally { await host.close(); }
});
it('rejects redirects without following them and bounds quiet connections by session time', async () => {
  const host = await server(() => {});
  try {
    const transport = new NodeWebSocketTransport({ ...config(host.url), webSocket: { sessionMs: 30 } });
    await expect(collect(transport.events('/redirect', context()))).rejects.toMatchObject({ code: 'WS_UPGRADE_FAILED', httpStatus: 302 });
    await expect(collect(transport.events('/ws', context()))).rejects.toMatchObject({ code: 'TIMEOUT' });
  } finally { await host.close(); }
});
it('closes aborted streams, releases capacity and never opens after a delayed DNS preparation', async () => {
  let ready: () => void = () => {}; const started = new Promise<void>(resolve => { ready = resolve; }); let connections = 0;
  const host = await server(socket => { connections++; ready(); if (connections > 1) { socket.send('next'); socket.close(); } });
  try {
    const controller = new AbortController(); const transport = new NodeWebSocketTransport(config(host.url));
    const pending = collect(transport.events('/ws', context({ signal: controller.signal }))); const observed = pending.catch(error => error);
    await started; controller.abort(); expect(await observed).toMatchObject({ code: 'ABORTED' });
    expect(await collect(transport.events('/ws', context()))).toEqual(['next']);
    let resolve: (value: { address: string; family: number }[]) => void = () => {};
    const slow = new NodeWebSocketTransport({ ...config(`http://slow.example:${new URL(host.url).port}`), timeoutMs: 10, lookup: async () => new Promise(done => { resolve = done; }) });
    await expect(collect(slow.events('/ws', context()))).rejects.toMatchObject({ code: 'TIMEOUT' });
    resolve([{ address: '127.0.0.1', family: 4 }]); await new Promise(done => setTimeout(done, 5)); expect(connections).toBe(2);
  } finally { await host.close(); }
});
it('releases sockets when consumers break and releases remotely closed sockets even if a consumer stops reading', async () => {
  const host = await server(socket => { socket.send('one'); socket.close(); });
  try {
    const transport = new NodeWebSocketTransport({ ...config(host.url), webSocket: { maxConnections: 1, sessionMs: 5000 } });
    const first = transport.events('/ws', context())[Symbol.asyncIterator](); expect((await first.next()).value).toBe('one');
    // A paused consumer must not hold capacity after the remote close; observe release instead of assuming a scheduler delay.
    let outcome: { values: string[] } | { error: unknown } | undefined;
    await expect.poll(async () => {
      try { outcome = { values: await collect(transport.events('/ws', context())) }; return true; }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'CONCURRENCY_LIMIT') return false;
        // Vitest retries thrown poll errors too, so carry unrelated failures outside the polling callback.
        outcome = { error }; return true;
      }
    }, { timeout: 1000 }).toBe(true);
    if (outcome && 'error' in outcome) throw outcome.error;
    expect(outcome).toEqual({ values: ['one'] }); await first.return?.();
    for await (const value of transport.events('/ws', context())) { expect(value).toBe('one'); break; }
    expect(await collect(transport.events('/ws', context()))).toEqual(['one']);
  } finally { await host.close(); }
});
it('does not deliver buffered progress after cancellation of a remotely closed stream', async () => {
  const host = await server(socket => { socket.send('one'); socket.send('two'); socket.close(); });
  try {
    const controller = new AbortController(); const transport = new NodeWebSocketTransport(config(host.url));
    const iterator = transport.events('/ws', context({ signal: controller.signal }))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe('one'); await new Promise(done => setTimeout(done, 10));
    controller.abort(); await expect(iterator.next()).rejects.toMatchObject({ code: 'ABORTED' });
  } finally { await host.close(); }
});
it.each(['value', 'key'])('rejects JSON-escaped credential echoes in a %s', async location => {
  const secret = 'synthetic-socket-secret'; const escaped = Array.from(secret).map(value => `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const text = location === 'key' ? `{"${escaped}":"x"}` : `{"type":"executing","data":{"prompt_id":"p1","node":"${escaped}"}}`;
  const host = await server(socket => { socket.send(text); socket.close(); });
  try {
    const transport = new NodeWebSocketTransport({ ...config(host.url), auth: { scheme: 'Key', credentialRef: 'test', resolveSecret: async () => secret } });
    await expect(collect(transport.events('/ws', context()))).rejects.toMatchObject({ code: 'SECRET_ECHO' });
  } finally { await host.close(); }
});
it('checks JSON frames with many small values without overflowing the event handler stack', async () => {
  const text = JSON.stringify(Array(150000).fill(1));
  const host = await server(socket => { socket.send(text); socket.close(); });
  try {
    const transport = new NodeWebSocketTransport({ ...config(host.url), auth: { scheme: 'Key', credentialRef: 'test', resolveSecret: async () => 'synthetic-socket-secret' } });
    expect(await collect(transport.events('/ws', context()))).toEqual([text]);
  } finally { await host.close(); }
});

import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { NodeHttpTransport, isPrivateAddress } from '../src/http.js';
import type { HttpConnection } from '../src/http.js';
import { context } from './support.js';
import type { HttpRequest } from '../src/types.js';
const request: HttpRequest = { method: 'POST', path: '/echo', effect: 'submit', responseType: 'json', body: { prompt: 'test' } };
const config = (baseUrl: string) => ({ tenantId: 'tenant-test', connectionId: 'connection-test', baseUrl, allowPrivateNetworks: true, allowInsecureHttp: true, timeoutMs: 1000, maxInFlight: 2 });
async function server(handler: RequestListener) {
  const instance = createServer(handler); instance.listen(0, '127.0.0.1'); await once(instance, 'listening');
  const address = instance.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { instance.closeAllConnections(); await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve())); } };
}
it.each(['127.0.0.1', '10.1.2.3', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '0.0.0.0', '224.0.0.1', '::', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1'])('blocks nonpublic address %s', ip => expect(isPrivateAddress(ip)).toBe(true));
it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('recognizes public address %s', ip => expect(isPrivateAddress(ip)).toBe(false));
it('pins DNS to the approved socket address, confines base paths and resolves credentials only in transport', async () => {
  const seen: unknown[] = [];
  const host = await server((req, res) => { seen.push({ url: req.url, host: req.headers.host, auth: req.headers.authorization }); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value: 'echo super-secret-token' })); });
  try {
    const origin = new URL(host.url); const lookup = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]);
    const http = new NodeHttpTransport({ ...config(`http://model.example:${origin.port}/api/`), lookup, auth: { scheme: 'Bearer', credentialRef: 'server-env', resolveSecret: async () => 'super-secret-token' } });
    const result = await http.exchange(request, context());
    expect(result.body).toEqual({ kind: 'json', value: { value: 'echo [REDACTED]' } });
    expect(lookup).toHaveBeenCalledWith('model.example'); expect(seen).toEqual([{ url: '/api/echo', host: `model.example:${origin.port}`, auth: 'Bearer super-secret-token' }]);
  } finally { await host.close(); }
});
it('does not follow redirects or expose credentials to another host', async () => {
  const host = await server((_req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }); res.end('{}'); });
  try { expect((await new NodeHttpTransport(config(host.url)).exchange(request, context())).status).toBe(302); }
  finally { await host.close(); }
});
it.each(['header', 'property'] as const)('rejects credential echo in the response %s before exposing or recording it', async where => {
  const secret = 'test-credential-echo-only';
  const host = await server((_req, res) => {
    if (where === 'header') res.setHeader('content-type', secret);
    res.end(JSON.stringify(where === 'property' ? { [secret]: 'echo' } : { ok: true }));
  });
  try {
    const http = new NodeHttpTransport({ ...config(host.url), auth: { scheme: 'Key', credentialRef: 'test', resolveSecret: async () => secret } });
    await expect(http.exchange(request, context())).rejects.toMatchObject({ code: 'SECRET_ECHO', outcome: 'unknown' });
  } finally { await host.close(); }
});
it('rejects untrusted connection scope and unsafe URLs before network access', async () => {
  for (const baseUrl of ['file:///etc/passwd', 'http://user:pass@example.com', 'https://example.com?a=secret', 'https://example.com/#x']) expect(() => new NodeHttpTransport(config(baseUrl))).toThrow();
  expect(() => new NodeHttpTransport({ ...config('http://127.0.0.1'), allowInsecureHttp: false })).toThrow();
  for (const patch of [{ timeoutMs: 0 }, { maxInFlight: 0 }, { maxResponseBytes: 0 }]) expect(() => new NodeHttpTransport({ ...config('http://127.0.0.1'), ...patch })).toThrow();
  const http = new NodeHttpTransport(config('http://127.0.0.1:1'));
  await expect(http.exchange(request, context({ tenantId: 'other' }))).rejects.toMatchObject({ code: 'CONNECTION_SCOPE', outcome: 'not_sent' });
  await expect(http.exchange(request, context({ connectionId: 'other' }))).rejects.toMatchObject({ code: 'CONNECTION_SCOPE' });
  for (const path of ['//evil.test/path', 'https://evil.test', '/../secret', '/%2e%2e/secret', '/%252e%252e/secret', '/a\\b', '/%2f%2fevil']) await expect(http.exchange({ ...request, path }, context())).rejects.toMatchObject({ code: 'INVALID_PATH' });
  await expect(http.exchange({ ...request, method: 'GET', body: {} }, context())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});
it('denies private DNS and mixed DNS results by default', async () => {
  const http = new NodeHttpTransport({ ...config('http://public.example'), allowPrivateNetworks: false, lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
  await expect(http.exchange(request, context())).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS', outcome: 'not_sent' });
  const empty = new NodeHttpTransport({ ...config('http://public.example'), lookup: async () => [] });
  await expect(empty.exchange(request, context())).rejects.toMatchObject({ code: 'DNS_FAILED' });
});
it.each(['false', 'true', 0, 1, null])('rejects nonboolean network-policy flags %s instead of treating them as opt-in', value => {
  for (const field of ['allowPrivateNetworks', 'allowInsecureHttp']) expect(() => new NodeHttpTransport({ ...config('http://127.0.0.1'), [field]: value } as unknown as HttpConnection)).toThrow();
});
it('aborts a transmitted request as unknown and bounds a hung preflight without transmission', async () => {
  let started: () => void = () => {}; const received = new Promise<void>(resolve => { started = resolve; });
  const host = await server(() => started());
  try {
    const controller = new AbortController(); const pending = new NodeHttpTransport(config(host.url)).exchange(request, context({ signal: controller.signal }));
    await received; controller.abort(); await expect(pending).rejects.toMatchObject({ code: 'ABORTED', outcome: 'unknown' });
    const slow = new NodeHttpTransport({ ...config('http://unresolved.example'), timeoutMs: 10, lookup: async () => new Promise(() => {}) });
    await expect(slow.exchange(request, context())).rejects.toMatchObject({ code: 'TIMEOUT', outcome: 'not_sent' });
  } finally { await host.close(); }
});
it('bounds response and request sizes, rejects duplicate JSON and handles binary without marking assets ready', async () => {
  const host = await server((req, res) => {
    if (req.url === '/duplicate') { res.end('{"x":1,"x":2}'); return; }
    if (req.url === '/large') { res.end('x'.repeat(200)); return; }
    if (req.url === '/binary') { res.setHeader('content-type', 'image/png'); res.end(Buffer.from([1, 2, 3])); return; }
    res.end('{}');
  });
  try {
    const http = new NodeHttpTransport({ ...config(host.url), maxResponseBytes: 100, maxRequestBytes: 100 });
    await expect(http.exchange({ ...request, path: '/duplicate' }, context())).rejects.toMatchObject({ code: 'INVALID_JSON', outcome: 'unknown' });
    await expect(http.exchange({ ...request, path: '/large' }, context())).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
    await expect(http.exchange({ ...request, body: 'x'.repeat(101) }, context())).rejects.toMatchObject({ code: 'REQUEST_LIMIT', outcome: 'not_sent' });
    const image = await http.exchange({ method: 'GET', path: '/binary', effect: 'read', responseType: 'bytes' }, context());
    expect(image).toMatchObject({ contentType: 'image/png', body: { kind: 'bytes', base64: 'AQID' } });
  } finally { await host.close(); }
});
it('enforces local connection concurrency and never retries after a network failure', async () => {
  let started: () => void = () => {}; const received = new Promise<void>(resolve => { started = resolve; });
  const host = await server(req => { started(); req.socket.destroy(); });
  try {
    const http = new NodeHttpTransport({ ...config(host.url), maxInFlight: 1 });
    const pending = http.exchange(request, context()); const observed = pending.catch(error => error);
    await expect(http.exchange(request, context())).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT' }); await received;
    expect(await observed).toMatchObject({ code: 'NETWORK_FAILED', outcome: 'unknown' });
  } finally { await host.close(); }
});
it('fails preflight safely for bad credentials, aborted calls, malformed DNS and invalid configuration', async () => {
  expect(() => new NodeHttpTransport(config('not a URL'))).toThrow();
  for (const auth of [{ scheme: 'Other', credentialRef: 'ref', resolveSecret: async () => 'x' }, { scheme: 'Bearer', credentialRef: 'ref', resolveSecret: 'not-a-function' }]) expect(() => new NodeHttpTransport({ ...config('http://127.0.0.1'), auth } as unknown as HttpConnection)).toThrow();
  const abort = new AbortController(); abort.abort(); const resolver = vi.fn(async () => 'secret-value');
  const http = new NodeHttpTransport({ ...config('http://127.0.0.1:1'), auth: { scheme: 'Bearer', credentialRef: 'ref', resolveSecret: resolver } });
  await expect(http.exchange(request, context({ signal: abort.signal }))).rejects.toMatchObject({ code: 'ABORTED', outcome: 'not_sent' }); expect(resolver).not.toHaveBeenCalled();
  await expect(http.exchange(request, context({ modeDigest: 'invalid' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  for (const resolveSecret of [async () => '', async () => 'x\r\nforged: value', async () => { throw new Error('private credential details'); }]) {
    const bad = new NodeHttpTransport({ ...config('http://127.0.0.1:1'), auth: { scheme: 'Key', credentialRef: 'ref', resolveSecret } });
    await expect(bad.exchange(request, context())).rejects.toMatchObject({ code: 'AUTH_RESOLUTION', outcome: 'not_sent' });
  }
  const badDns = new NodeHttpTransport({ ...config('http://example.test'), lookup: async () => [{ address: 'invalid', family: 4 }] });
  await expect(badDns.exchange(request, context())).rejects.toMatchObject({ code: 'DNS_FAILED' });
  const defaults = new NodeHttpTransport({ tenantId: 'tenant-test', connectionId: 'connection-test', baseUrl: 'https://localhost', timeoutMs: 1000, maxInFlight: 1 });
  await expect(defaults.exchange(request, context())).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS', outcome: 'not_sent' });
});
it('redacts nested credentials and rejects binary echoes and invalid UTF-8 without exposing provider content', async () => {
  const secret = 'credential-echo-test';
  const host = await server((req, res) => {
    if (req.url === '/bad-utf8') res.end(Buffer.from([255]));
    else if (req.url === '/secret-binary') res.end(Buffer.from(secret));
    else res.end(JSON.stringify([secret, { nested: secret }, null, false, 2]));
  });
  try {
    const http = new NodeHttpTransport({ ...config(host.url), auth: { scheme: 'Key', credentialRef: 'ref', resolveSecret: async () => secret } });
    expect((await http.exchange(request, context())).body).toEqual({ kind: 'json', value: ['[REDACTED]', { nested: '[REDACTED]' }, null, false, 2] });
    await expect(http.exchange({ ...request, path: '/secret-binary', responseType: 'bytes' }, context())).rejects.toMatchObject({ code: 'SECRET_ECHO' });
    await expect(http.exchange({ ...request, path: '/bad-utf8' }, context())).rejects.toMatchObject({ code: 'INVALID_RESPONSE', outcome: 'unknown' });
  } finally { await host.close(); }
});

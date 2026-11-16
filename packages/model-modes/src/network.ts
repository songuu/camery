import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { name } from './json.js';
import { ModelError } from './types.js';
import type { CallContext } from './types.js';

const reserved = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) reserved.addSubnet(ip, prefix, 'ipv4');
for (const [ip, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) reserved.addSubnet(ip, prefix, 'ipv6');
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (!family) return true;
  if (reserved.check(address, family === 4 ? 'ipv4' : 'ipv6')) return true;
  return family === 6 && !/^[23]/i.test(address) && !/^::ffff:/i.test(address);
}
interface Address { address: string; family: number }
export interface WebSocketLimits {
  sessionMs?: number; maxConnections?: number; maxFrameBytes?: number;
  maxBufferedBytes?: number; maxBufferedMessages?: number; maxMessages?: number;
}
export interface HttpConnection {
  tenantId: string; connectionId: string; baseUrl: string;
  allowPrivateNetworks?: boolean; allowInsecureHttp?: boolean;
  timeoutMs: number; maxInFlight: number; maxRequestBytes?: number; maxResponseBytes?: number;
  webSocket?: WebSocketLimits;
  lookup?: (hostname: string) => Promise<Address[]>;
  auth?: { scheme: 'Bearer' | 'Key'; credentialRef: string; resolveSecret: (reference: string, context: Readonly<CallContext>) => Promise<string> };
}
export function positive(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ModelError('INVALID_CONFIG', 'connection limits', 'not_sent');
}
function safePath(path: string): void {
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20\x7f#]/.test(path)) throw new ModelError('INVALID_PATH', 'request path', 'not_sent');
  let decoded = path.split('?')[0]!;
  try {
    for (let i = 0; i < 4; i++) {
      if (decoded.includes('\\') || decoded.startsWith('//') || decoded.split('/').some(part => part === '.' || part === '..')) throw new Error();
      const next = decodeURIComponent(decoded);
      if (next === decoded) return;
      if (next.split('/').length !== decoded.split('/').length) throw new Error();
      decoded = next;
    }
  } catch { throw new ModelError('INVALID_PATH', 'request path', 'not_sent'); }
  throw new ModelError('INVALID_PATH', 'path encoding depth', 'not_sent');
}
/** One policy for HTTP and WS, including DNS pinning and host-owned credential resolution. */
export class ConnectionPolicy {
  protected readonly config: HttpConnection;
  private readonly base: URL;
  constructor(config: HttpConnection) {
    if ([config.allowPrivateNetworks, config.allowInsecureHttp].some(value => value !== undefined && typeof value !== 'boolean')) throw new ModelError('INVALID_CONFIG', 'connection network policy', 'not_sent');
    let base: URL;
    try { base = new URL(config.baseUrl); } catch { throw new ModelError('INVALID_CONFIG', 'connection URL', 'not_sent'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || (base.protocol === 'http:' && config.allowInsecureHttp !== true)) throw new ModelError('INVALID_CONFIG', 'connection URL', 'not_sent');
    name(config.tenantId, 'connection tenant'); name(config.connectionId, 'connection ID');
    positive(config.timeoutMs, 300_000); positive(config.maxInFlight, 1000);
    positive(config.maxRequestBytes ?? 1_048_576, 16_777_216); positive(config.maxResponseBytes ?? 4_194_304, 67_108_864);
    if (config.auth) { name(config.auth.credentialRef, 'credential reference'); if (!['Bearer', 'Key'].includes(config.auth.scheme) || typeof config.auth.resolveSecret !== 'function') throw new ModelError('INVALID_CONFIG', 'authentication resolver', 'not_sent'); }
    base.pathname = base.pathname.replace(/\/?$/, '/');
    this.base = base; this.config = { ...config, ...(config.auth ? { auth: { ...config.auth } } : {}), ...(config.webSocket ? { webSocket: { ...config.webSocket } } : {}) };
  }
  protected captureContext(original: CallContext): Readonly<CallContext> {
    const context = Object.freeze({ tenantId: original.tenantId, connectionId: original.connectionId, modeDigest: original.modeDigest, idempotencyKey: original.idempotencyKey, signal: original.signal });
    if (context.tenantId !== this.config.tenantId || context.connectionId !== this.config.connectionId) throw new ModelError('CONNECTION_SCOPE', 'connection scope', 'not_sent');
    name(context.idempotencyKey, 'request identity');
    if (!/^[a-f0-9]{64}$/.test(context.modeDigest) || !(context.signal instanceof AbortSignal)) throw new ModelError('INVALID_INPUT', 'call context', 'not_sent');
    return context;
  }
  protected target(path: string): URL {
    safePath(path);
    const target = new URL(path.slice(1), this.base);
    if (target.origin !== this.base.origin || !target.pathname.startsWith(this.base.pathname)) throw new ModelError('INVALID_PATH', 'connection boundary', 'not_sent');
    return target;
  }
  protected async prepare(target: URL, context: Readonly<CallContext>, bounded: <T>(fn: () => Promise<T>) => Promise<T>): Promise<{ hostname: string; address: Address; secret: string | undefined }> {
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = await bounded(() => isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : (this.config.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })))(hostname));
    if (!addresses.length || addresses.some(item => !isIP(item.address) || isIP(item.address) !== item.family)) throw new ModelError('DNS_FAILED', 'connection DNS', 'not_sent');
    if (this.config.allowPrivateNetworks !== true && addresses.some(item => isPrivateAddress(item.address))) throw new ModelError('PRIVATE_ADDRESS', 'connection DNS', 'not_sent');
    let secret: string | undefined;
    const auth = this.config.auth;
    if (auth) {
      try { secret = await bounded(() => auth.resolveSecret(auth.credentialRef, context)); }
      catch (error) { if (error instanceof ModelError) throw error; throw new ModelError('AUTH_RESOLUTION', 'connection credential', 'not_sent'); }
      if (typeof secret !== 'string' || !secret || secret.length > 16_384 || /[\r\n]/.test(secret)) throw new ModelError('AUTH_RESOLUTION', 'connection credential', 'not_sent');
    }
    return { hostname, address: addresses[0]!, secret };
  }
}

import { ConnectionPolicy } from './network.js';
export { isPrivateAddress } from './network.js';
export type { HttpConnection, WebSocketLimits } from './network.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { canonicalJson, parseJson } from './json.js';
import { ModelError } from './types.js';
import type { CallContext, HttpReply, HttpRequest, HttpTransport, Json, Outcome } from './types.js';

function redact(value: Json, secret: string | undefined, outcome: Outcome): Json {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => redact(item, secret, outcome));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    // Rewriting keys can collide and silently change structured results; reject credential-bearing keys instead.
    if (key.includes(secret)) throw new ModelError('SECRET_ECHO', 'HTTP JSON response', outcome);
    return [key, redact(item, secret, outcome)];
  }));
  return value;
}
/** No automatic retries, redirects, arbitrary headers or URLs from model output. DNS is resolved, checked and pinned. */
export class NodeHttpTransport extends ConnectionPolicy implements HttpTransport {
  private active = 0;
  async exchange(input: HttpRequest, original: CallContext): Promise<HttpReply> {
    const config = this.config;
    const context = this.captureContext(original);
    const target = this.target(input.path);
    if (!['GET', 'POST'].includes(input.method) || !['read', 'submit'].includes(input.effect) || !['json', 'bytes'].includes(input.responseType) || (input.method === 'GET' && input.body !== undefined)) throw new ModelError('INVALID_INPUT', 'HTTP request', 'not_sent');
    const body = input.body === undefined ? undefined : canonicalJson(input.body);
    if (body !== undefined && Buffer.byteLength(body) > (config.maxRequestBytes ?? 1_048_576)) throw new ModelError('REQUEST_LIMIT', 'request body', 'not_sent');
    const request = { ...input };
    if (this.active >= config.maxInFlight) throw new ModelError('CONCURRENCY_LIMIT', 'connection capacity', 'not_sent');
    this.active++;
    let sent = false; let timedOut = false; let secret: string | undefined;
    const outcome = (): Outcome => request.effect === 'read' ? 'not_applicable' : sent ? 'unknown' : 'not_sent';
    const controller = new AbortController(); const abort = (): void => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    const aborted = (): ModelError => new ModelError(timedOut ? 'TIMEOUT' : 'ABORTED', 'HTTP exchange', outcome());
    const bounded = async <T>(execute: () => Promise<T>): Promise<T> => {
      if (controller.signal.aborted) throw aborted();
      let listener: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => { listener = () => reject(aborted()); controller.signal.addEventListener('abort', listener, { once: true }); });
      try { return await Promise.race([Promise.resolve().then(() => { if (controller.signal.aborted) throw aborted(); return execute(); }), cancelled]); }
      finally { controller.signal.removeEventListener('abort', listener); }
    };
    try {
      const prepared = await this.prepare(target, context, bounded);
      const { hostname, address } = prepared; secret = prepared.secret;
      return await bounded(() => new Promise<HttpReply>((resolve, reject) => {
        const headers: Record<string, string> = { host: target.host, accept: request.responseType === 'json' ? 'application/json' : '*/*' };
        if (body !== undefined) { headers['content-type'] = 'application/json'; headers['content-length'] = String(Buffer.byteLength(body)); }
        if (secret && config.auth) headers['authorization'] = `${config.auth.scheme} ${secret}`;
        const network = target.protocol === 'https:' ? httpsRequest : httpRequest;
        const outgoing = network({ protocol: target.protocol, hostname: address.address, family: address.family, port: target.port, path: target.pathname + target.search,
          method: request.method, headers, agent: false, ...(isIP(hostname) ? {} : { servername: hostname }) }, incoming => {
          const chunks: Buffer[] = []; let size = 0;
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > (config.maxResponseBytes ?? 4_194_304)) { reject(new ModelError('RESPONSE_LIMIT', 'HTTP response', outcome())); incoming.destroy(); return; }
            chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => {
            try {
              const bytes = Buffer.concat(chunks); const contentType = incoming.headers['content-type'] ?? null;
              if (secret && contentType?.includes(secret)) throw new ModelError('SECRET_ECHO', 'HTTP response header', outcome());
              if (request.responseType === 'json') {
                const value = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'HTTP JSON response', outcome());
                resolve({ status: incoming.statusCode!, contentType, body: { kind: 'json', value: redact(value, secret, outcome()) } });
              } else {
                if (secret && bytes.includes(Buffer.from(secret))) throw new ModelError('SECRET_ECHO', 'binary HTTP response', outcome());
                resolve({ status: incoming.statusCode!, contentType, body: { kind: 'bytes', base64: bytes.toString('base64') } });
              }
            } catch (error) { reject(error instanceof ModelError ? error : new ModelError('INVALID_RESPONSE', 'HTTP decode', outcome())); }
          });
        });
        const stop = (): void => { outgoing.destroy(aborted()); };
        controller.signal.addEventListener('abort', stop, { once: true });
        outgoing.once('close', () => controller.signal.removeEventListener('abort', stop)); outgoing.on('error', reject);
        if (controller.signal.aborted) { stop(); return; }
        sent = true; outgoing.end(body);
      }));
    } catch (error) {
      if (controller.signal.aborted) throw aborted();
      if (error instanceof ModelError) throw error;
      throw new ModelError('NETWORK_FAILED', 'HTTP exchange', outcome());
    } finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); this.active--; }
  }
}

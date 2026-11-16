import WebSocket from 'ws';
import { Deadline } from './deadline.js';
import { ConnectionPolicy, positive } from './network.js';
import type { HttpConnection, WebSocketLimits } from './network.js';
import { ModelError } from './types.js';
import type { CallContext, WebSocketTransport } from './types.js';

function secretEcho(text: string, secret: string): boolean {
  if (text.includes(secret)) return true;
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return false; }
  // JSON escapes become real strings before progress decoding. Iterate to avoid recursion on nested frames.
  const pending: unknown[] = [decoded];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string' && value.includes(secret)) return true;
    if (value && typeof value === 'object') {
      if (Object.keys(value).some(key => key.includes(secret))) return true;
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return false;
}

/** A bounded, read-only stream. Reconnection belongs to the job monitor, never to workflow submission. */
export class NodeWebSocketTransport extends ConnectionPolicy implements WebSocketTransport {
  private active = 0;
  private readonly limits: Required<WebSocketLimits>;
  constructor(config: HttpConnection) {
    super(config);
    const options = config.webSocket;
    const defaults = { sessionMs: config.timeoutMs, maxConnections: 1, maxFrameBytes: 4_194_304, maxBufferedBytes: 1_048_576, maxBufferedMessages: 128, maxMessages: 10_000 };
    if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !Object.hasOwn(defaults, key)))) throw new ModelError('INVALID_CONFIG', 'WebSocket limits', 'not_sent');
    this.limits = { ...defaults, ...options };
    positive(this.limits.sessionMs, 300_000); positive(this.limits.maxConnections, 1000);
    positive(this.limits.maxFrameBytes, 67_108_864); positive(this.limits.maxBufferedBytes, 67_108_864);
    positive(this.limits.maxBufferedMessages, 10_000); positive(this.limits.maxMessages, 1_000_000);
  }
  events(path: string, original: CallContext): AsyncIterable<string> {
    // Capture before the first next(), so callers cannot swap scope or cancellation while queued.
    return this.stream(this.target(path), this.captureContext(original));
  }
  private async *stream(target: URL, context: Readonly<CallContext>): AsyncGenerator<string> {
    if (this.active >= this.limits.maxConnections) throw new ModelError('CONCURRENCY_LIMIT', 'WebSocket capacity', 'not_applicable');
    this.active++;
    const session = new Deadline(context.signal, this.limits.sessionMs, 'WebSocket stream');
    const handshake = new Deadline(session.signal, this.config.timeoutMs, 'WebSocket handshake');
    let socket: WebSocket | undefined; let released = false; let closed = false; let failure: ModelError | undefined;
    let wake: () => void = () => {}; let queuedBytes = 0; let messages = 0;
    const queue: { text: string; bytes: number }[] = [];
    const release = (): void => {
      if (released) return; released = true; this.active--;
      session.dispose(); handshake.dispose();
      session.signal.removeEventListener('abort', onSessionAbort); handshake.signal.removeEventListener('abort', onHandshakeAbort);
    };
    const stop = (): void => { if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate(); };
    const fail = (error: ModelError): void => { if (closed) return; failure = error; closed = true; queue.length = 0; release(); stop(); wake(); };
    const onSessionAbort = (): void => fail(session.error());
    const onHandshakeAbort = (): void => fail(session.signal.aborted ? session.error() : handshake.error());
    session.signal.addEventListener('abort', onSessionAbort, { once: true }); handshake.signal.addEventListener('abort', onHandshakeAbort, { once: true });
    try {
      const { address, secret } = await handshake.run(() => this.prepare(target, context, fn => handshake.run(fn)));
      if (session.signal.aborted || handshake.signal.aborted) throw session.signal.aborted ? session.error() : handshake.error();
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(target, {
        followRedirects: false, perMessageDeflate: false, maxPayload: this.limits.maxFrameBytes,
        handshakeTimeout: this.config.timeoutMs, rejectUnauthorized: true, skipUTF8Validation: false,
        headers: secret && this.config.auth ? { authorization: `${this.config.auth.scheme} ${secret}` } : {},
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
      });
      socket.on('open', () => { handshake.dispose(); handshake.signal.removeEventListener('abort', onHandshakeAbort); });
      socket.on('unexpected-response', (request, response) => {
        const status = response.statusCode;
        fail(new ModelError(status === 401 || status === 403 ? 'AUTH_FAILED' : 'WS_UPGRADE_FAILED', 'WebSocket upgrade', 'not_applicable', status));
        response.destroy(); request.destroy();
      });
      socket.on('error', (error: Error & { code?: string }) => {
        const code = error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' ? 'WS_FRAME_LIMIT' : error.code === 'WS_ERR_INVALID_UTF8' ? 'WS_INVALID_FRAME' : 'WS_NETWORK_FAILED';
        fail(new ModelError(code, 'WebSocket stream', 'not_applicable'));
      });
      socket.on('message', (data, binary) => {
        if (closed) return;
        if (++messages > this.limits.maxMessages) { fail(new ModelError('WS_MESSAGE_LIMIT', 'WebSocket stream', 'not_applicable')); return; }
        if (binary) return; // Previews consume the session message budget but never enter the text queue.
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        const text = bytes.toString('utf8');
        if (secret && secretEcho(text, secret)) { fail(new ModelError('SECRET_ECHO', 'WebSocket progress', 'not_applicable')); return; }
        if (queuedBytes + bytes.length > this.limits.maxBufferedBytes || queue.length >= this.limits.maxBufferedMessages) { fail(new ModelError('WS_BUFFER_LIMIT', 'WebSocket progress', 'not_applicable')); return; }
        queue.push({ text, bytes: bytes.length }); queuedBytes += bytes.length; wake();
      });
      socket.on('close', code => {
        if (closed) return;
        if (code !== 1000 && code !== 1005) { fail(new ModelError('WS_NETWORK_FAILED', 'WebSocket closed', 'not_applicable')); return; }
        closed = true; release(); wake();
      });
      while (true) {
        if (failure) throw failure;
        // Remote close releases timers/listeners immediately, but queued frames still respect later caller cancellation.
        if (context.signal.aborted) throw new ModelError('ABORTED', 'WebSocket stream', 'not_applicable');
        const next = queue.shift();
        if (next) { queuedBytes -= next.bytes; yield next.text; continue; }
        if (closed) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } catch (error) {
      if (failure) throw failure;
      throw error instanceof ModelError ? error : new ModelError('WS_NETWORK_FAILED', 'WebSocket stream', 'not_applicable');
    } finally { closed = true; release(); stop(); }
  }
}

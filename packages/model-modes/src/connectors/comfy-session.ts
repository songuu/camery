import { Deadline } from '../deadline.js';
import { jsonValue, name } from '../json.js';
import { ModelError } from '../types.js';
import type { CallContext, RemoteJob, WebSocketTransport } from '../types.js';
import { decodeComfyProgress } from './comfy.js';
import type { ComfyProgress, ComfyUiConnector } from './comfy.js';

export interface ComfySessionOptions {
  maxReconnects?: number; reconnectDelayMs?: number; pollIntervalMs?: number; maxMonitorMs?: number;
}
type Next = { kind: 'event'; result: IteratorResult<string> } | { kind: 'error'; error: unknown };
interface Stream { controller: AbortController; iterator: AsyncIterator<string>; pending: Promise<Next>; unlink: () => void }
const transient = (error: unknown): boolean => error instanceof ModelError && ['WS_NETWORK_FAILED', 'NETWORK_FAILED', 'TIMEOUT'].includes(error.code);
const identifier = (value: string): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new ModelError('INVALID_INPUT', 'comfy monitor identity', 'not_applicable');
};
/** Watches an existing prompt. Only HTTP history/queue establishes terminal state; no submission or remote cancellation. */
export class ComfyProgressSession {
  private readonly options: Required<ComfySessionOptions>;
  constructor(private readonly connector: Pick<ComfyUiConnector, 'poll'>, private readonly progress: WebSocketTransport, options: ComfySessionOptions = {}) {
    const defaults = { maxReconnects: 2, reconnectDelayMs: 1000, pollIntervalMs: 1000, maxMonitorMs: 300_000 };
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !Object.hasOwn(defaults, key))) throw new ModelError('INVALID_CONFIG', 'comfy monitor options', 'not_sent');
    this.options = { ...defaults, ...options };
    for (const [key, max] of [['maxReconnects', 20], ['reconnectDelayMs', 60_000], ['pollIntervalMs', 60_000], ['maxMonitorMs', 3_600_000]] as const) {
      const value = this.options[key];
      if (!Number.isSafeInteger(value) || value < (key === 'maxReconnects' || key === 'reconnectDelayMs' ? 0 : 1) || value > max) throw new ModelError('INVALID_CONFIG', 'comfy monitor limits', 'not_sent');
    }
  }
  async watch(promptId: string, clientId: string, original: CallContext, onProgress?: (event: ComfyProgress) => void | Promise<void>): Promise<RemoteJob> {
    identifier(promptId); name(clientId, 'comfy monitor client');
    const captured = Object.freeze({ tenantId: original.tenantId, connectionId: original.connectionId, modeDigest: original.modeDigest, idempotencyKey: original.idempotencyKey, signal: original.signal });
    name(captured.tenantId, 'comfy monitor tenant'); name(captured.connectionId, 'comfy monitor connection'); name(captured.idempotencyKey, 'comfy monitor key');
    if (!(captured.signal instanceof AbortSignal) || !/^[a-f0-9]{64}$/.test(captured.modeDigest) || (onProgress !== undefined && typeof onProgress !== 'function')) throw new ModelError('INVALID_INPUT', 'comfy monitor context', 'not_applicable');
    const deadline = new Deadline(captured.signal, this.options.maxMonitorMs, 'comfy monitor');
    const context = Object.freeze({ ...captured, signal: deadline.signal });
    let stream: Stream | undefined;
    const next = (iterator: AsyncIterator<string>): Promise<Next> => Promise.resolve().then(() => iterator.next()).then(result => ({ kind: 'event', result }), error => ({ kind: 'error', error }));
    const close = (): void => {
      if (!stream) return;
      const current = stream; stream = undefined; current.controller.abort(); current.unlink();
      // An injected transport may ignore abort or return(); observe it without delaying monitor shutdown.
      void Promise.resolve().then(() => current.iterator.return?.()).catch(() => {});
    };
    const poll = async (): Promise<RemoteJob> => {
      let value: RemoteJob;
      try { value = await deadline.run(() => this.connector.poll(promptId, context)); }
      catch (error) {
        if (deadline.signal.aborted) throw deadline.error();
        if (transient(error)) return { id: promptId, state: 'unknown' };
        throw error instanceof ModelError ? error : new ModelError('POLL_FAILED', 'comfy monitor', 'not_applicable');
      }
      if (!value || value.id !== promptId || !['queued', 'running', 'remote_succeeded', 'failed', 'unknown'].includes(value.state)) throw new ModelError('INVALID_RESPONSE', 'comfy monitor job', 'not_applicable');
      return { id: value.id, state: value.state, ...(value.result !== undefined ? { result: jsonValue(value.result) } : {}) };
    };
    const terminal = (job: RemoteJob): boolean => job.state === 'remote_succeeded' || job.state === 'failed';
    const wait = async (ms: number, pending?: Promise<Next>): Promise<Next | { kind: 'tick' }> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await deadline.run(() => {
          const tick = new Promise<{ kind: 'tick' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'tick' }), Math.max(0, ms)); });
          return pending ? Promise.race([pending, tick]) : tick;
        });
      } finally { clearTimeout(timer); }
    };
    try {
      const initial = await poll(); if (terminal(initial)) return initial;
      let attempts = 0; let retryAt = Date.now(); let pollAt = Date.now() + this.options.pollIntervalMs;
      while (true) {
        if (deadline.signal.aborted) throw deadline.error();
        if (Date.now() >= pollAt) {
          const current = await poll(); if (terminal(current)) return current;
          pollAt = Date.now() + this.options.pollIntervalMs;
        }
        if (!stream && attempts <= this.options.maxReconnects && Date.now() >= retryAt) {
          attempts++;
          const controller = new AbortController(); const abort = (): void => controller.abort();
          deadline.signal.addEventListener('abort', abort, { once: true });
          try {
            const iterator = this.progress.events(`/ws?${new URLSearchParams({ clientId }).toString()}`, Object.freeze({ ...context, signal: controller.signal }))[Symbol.asyncIterator]();
            stream = { controller, iterator, pending: next(iterator), unlink: () => deadline.signal.removeEventListener('abort', abort) };
          } catch (error) {
            controller.abort(); deadline.signal.removeEventListener('abort', abort);
            if (!transient(error)) throw error instanceof ModelError ? error : new ModelError('WS_NETWORK_FAILED', 'comfy monitor transport', 'not_applicable');
            retryAt = Date.now() + this.options.reconnectDelayMs; pollAt = Date.now(); continue;
          }
        }
        if (!stream) { await wait(Math.min(pollAt, attempts <= this.options.maxReconnects ? retryAt : Infinity) - Date.now()); continue; }
        const event = await wait(pollAt - Date.now(), stream.pending);
        if (event.kind === 'tick') continue;
        if (event.kind === 'error' || event.result.done) {
          close();
          if (event.kind === 'error' && !transient(event.error)) throw event.error instanceof ModelError ? event.error : new ModelError('WS_NETWORK_FAILED', 'comfy monitor transport', 'not_applicable');
          retryAt = Date.now() + this.options.reconnectDelayMs; pollAt = Date.now(); continue;
        }
        const decoded = decodeComfyProgress(event.result.value, promptId);
        if (decoded) {
          if (onProgress) {
            try { await deadline.run(async () => { await onProgress(decoded); }); }
            catch { if (deadline.signal.aborted) throw deadline.error(); throw new ModelError('PROGRESS_HANDLER_FAILED', 'comfy monitor progress', 'not_applicable'); }
          }
          if (decoded.kind === 'history_required' || decoded.kind === 'failed') pollAt = Date.now();
        }
        stream.pending = next(stream.iterator);
      }
    } finally { close(); deadline.dispose(); }
  }
}

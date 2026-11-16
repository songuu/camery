import { ModelError } from './types.js';

/** Observe late promises while bounding resolvers, callbacks and quiet streams by one signal. */
export class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private timedOut = false;
  private readonly abort = (): void => { this.controller.abort(); };
  constructor(private readonly parent: AbortSignal, durationMs: number, private readonly operation: string) {
    parent.addEventListener('abort', this.abort, { once: true });
    if (parent.aborted) this.abort();
    this.timer = setTimeout(() => { this.timedOut = true; this.abort(); }, durationMs);
  }
  get signal(): AbortSignal { return this.controller.signal; }
  error(): ModelError { return new ModelError(this.timedOut ? 'TIMEOUT' : 'ABORTED', this.operation, 'not_applicable'); }
  async run<T>(execute: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.error();
    let listener: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { listener = () => reject(this.error()); this.signal.addEventListener('abort', listener, { once: true }); });
    try { return await Promise.race([Promise.resolve().then(() => { if (this.signal.aborted) throw this.error(); return execute(); }), cancelled]); }
    finally { this.signal.removeEventListener('abort', listener); }
  }
  dispose(): void { clearTimeout(this.timer); this.parent.removeEventListener('abort', this.abort); }
}

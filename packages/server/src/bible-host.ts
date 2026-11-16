import { z } from 'zod';
import { BibleError } from '@camery/bible';
import { BIBLE_CHUNK_WORKFLOW, BIBLE_CHUNK_WORKFLOW_VERSION, enqueueNextBibleTask, RunKeySchema, type BibleStore } from '@camery/bible/node';
import { BibleRunListSchema, type BibleRunSummary } from '@camery/bible/http';
import type { DurableStore, DurableWorker } from '@camery/durable';
import type { BibleCatalogReader } from './bible-options.js';

export interface BibleHostOptions {
  readonly scope: { readonly tenantId: string; readonly projectId: string }; readonly workerId: string;
  readonly store: BibleStore; readonly catalog: BibleCatalogReader; readonly durable: Pick<DurableStore, 'enqueue'>;
  readonly worker: Pick<DurableWorker, 'hasWorkflow' | 'runTask'>; readonly pollMs?: number; readonly runsPerRound?: number;
}
const Settings = z.strictObject({ workerId: RunKeySchema.shape.runId, pollMs: z.int().min(50).max(60000), runsPerRound: z.int().min(1).max(50) });
export interface BibleHostRound { readonly visited: number; readonly executed: number; readonly errors: number }
function wait(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds); signal.addEventListener('abort', done, { once: true });
  });
}
/** A fair bounded scan; the database owns progress, this host owns only its current page cursor. */
export function createBibleHost(options: BibleHostOptions) {
  const { tenantId, projectId } = RunKeySchema.pick({ tenantId: true, projectId: true }).parse(options.scope);
  const settings = Settings.parse({ workerId: options.workerId, pollMs: options.pollMs ?? 1000, runsPerRound: options.runsPerRound ?? 20 });
  const readPage = options.catalog.list.bind(options.catalog); const runTask = options.worker.runTask.bind(options.worker);
  const store = options.store; const durable = options.durable;
  if (!options.worker.hasWorkflow(BIBLE_CHUNK_WORKFLOW, BIBLE_CHUNK_WORKFLOW_VERSION)) throw new BibleError('INVALID_INPUT', 'Bible host workflow unavailable');
  let cursor: string | undefined; let remaining: BibleRunSummary[] = []; let pageEndsScan = false; let busy = false;
  async function round(signal?: AbortSignal): Promise<BibleHostRound> {
    if (busy) throw new BibleError('CONFLICT', 'Bible host concurrent round');
    busy = true; let visited = 0; let executed = 0; let errors = 0;
    try {
      while (visited < settings.runsPerRound && !signal?.aborted) {
        if (!remaining.length) {
          if (pageEndsScan) { pageEndsScan = false; cursor = undefined; break; }
          const page = BibleRunListSchema.parse(await readPage({ tenantId, projectId, pendingOnly: true, ...(cursor ? { cursor } : {}) }));
          remaining = page.items; cursor = page.nextCursor ?? undefined; pageEndsScan = page.nextCursor === null;
          if (!remaining.length) { if (page.nextCursor !== null) throw new BibleError('STORAGE_FAILED', 'empty Bible catalog continuation'); pageEndsScan = false; cursor = undefined; break; }
        }
        const summary = remaining.shift()!; visited++;
        try {
          const dispatch = await enqueueNextBibleTask(store, durable, { tenantId, projectId, runId: summary.runId });
          if (signal?.aborted) break;
          if (dispatch.state === 'task' && ['queued', 'running', 'waiting'].includes(dispatch.task.status)) {
            // Exact claim inspects lease/time/gate eligibility; it cannot consume an unrelated tenant queue item.
            const result = await runTask({ tenantId, taskId: dispatch.task.taskId }, settings.workerId);
            if (result) executed++;
          }
        } catch { errors++; }
      }
      return Object.freeze({ visited, executed, errors });
    } finally { busy = false; }
  }
  return Object.freeze({ round,
    async run(signal: AbortSignal): Promise<{ reason: 'stopped'; rounds: number; errors: number }> {
      let rounds = 0; let errors = 0;
      while (!signal.aborted) { const result = await round(signal); rounds++; errors += result.errors; await wait(signal, settings.pollMs); }
      // runTask is awaited above; the caller may safely close its pools only after this promise resolves.
      return { reason: 'stopped', rounds, errors };
    } });
}

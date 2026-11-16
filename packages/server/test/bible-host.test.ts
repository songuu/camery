import { expect, it, vi } from 'vitest';
import { importNovel } from '@camery/ingest';
import { captureSource, createChunkPlan, createStoryBibleMethodPack } from '@camery/bible';
import { bibleRunDigest, type BibleProgress, type BibleRun, type BibleStore } from '@camery/bible/node';
import { digest, MethodRegistry } from '@camery/methods';
import type { DurableStore, Task, TaskStatus } from '@camery/durable';
import type { BibleRunSummary } from '@camery/bible/http';
import { createBibleHost } from '../src/bible-host.js';
import type { BibleCatalogReader } from '../src/bible-options.js';

function fixture() {
  const scope = { tenantId: 'tenant-a', projectId: 'project-a' };
  const input = { ...scope, documentId: 'novel-a', kind: 'novel' as const, revision: 1, document: importNovel('第一章 车站\n小林来到车站。\n') };
  const source = captureSource(input); const plan = createChunkPlan(input); const method = new MethodRegistry().register(createStoryBibleMethodPack());
  const execution = { connectionId: 'fixture', modeDigest: digest('mode'), modelIdentity: 'fixture-model', evidence: 'synthetic_replay' as const, modelTier: 'economy' as const,
    currency: 'CNY', reservation: { tokens: 100, costMicros: 0 }, limits: { steps: 1, tokens: 100, costMicros: 0 } };
  const run: BibleRun = { ...scope, runId: 'run-a', source, plan, method, execution, digest: bibleRunDigest(plan, method, execution), createdAt: '2026-11-16T10:00:00.000Z' };
  const progress = (runId: string): BibleProgress => ({ run: { ...run, runId }, records: [], candidate: null, review: null });
  const store: BibleStore = { start: vi.fn(), read: vi.fn(async key => progress(key.runId)), saveChunk: vi.fn(), materialize: vi.fn(), isCurrent: vi.fn(async () => true), confirm: vi.fn(), reject: vi.fn() };
  const { tenantId: _tenant, projectId: _project, ...publicSource } = source.source;
  const summary = (runId: string): BibleRunSummary => ({ runId, source: publicSource, createdAt: run.createdAt, completedChunks: 0, totalChunks: 1, candidateDigest: null, reviewStatus: null, sourceChanged: false });
  const catalog = { list: vi.fn<BibleCatalogReader['list']>(async () => ({ items: [summary('run-a')], nextCursor: null })), summary: vi.fn() };
  const durable = { enqueue: vi.fn<DurableStore['enqueue']>(async request => ({ ...request, status: 'queued', attempts: 0, fence: 0, owner: null, leaseUntil: null, output: null, error: null })) };
  const worker = { hasWorkflow: vi.fn(() => true), runTask: vi.fn(async (): Promise<Task | null> => null) };
  return { options: { scope, workerId: 'worker-a', store, catalog, durable, worker, pollMs: 50, runsPerRound: 1 }, summary, progress, run };
}
it('dispatches only deterministic Bible task refs in its fixed scope', async () => {
  const f = fixture(); const host = createBibleHost(f.options);
  expect(await host.round()).toEqual({ visited: 1, executed: 0, errors: 0 });
  const queued = f.options.durable.enqueue.mock.calls[0]![0];
  expect(queued.input).toMatchObject({ projectId: 'project-a', runId: 'run-a', runDigest: f.run.digest });
  expect(f.options.worker.runTask).toHaveBeenCalledExactlyOnceWith({ tenantId: 'tenant-a', taskId: queued.taskId }, 'worker-a');
  expect(f.options.catalog.list).toHaveBeenCalledExactlyOnceWith({ ...f.options.scope, pendingOnly: true });
});
it('supplies bounded default scheduling settings when deployment overrides are absent', async () => {
  const f = fixture(); const { pollMs: _poll, runsPerRound: _runs, ...defaults } = f.options;
  expect(await createBibleHost(defaults).round()).toEqual({ visited: 1, executed: 0, errors: 0 });
});
it('continues remaining rows and keyset pages fairly before returning to the first page', async () => {
  const f = fixture(); f.options.catalog.list.mockImplementation(async request => request.cursor === 'second'
    ? { items: [f.summary('run-c')], nextCursor: null } : { items: [f.summary('run-a'), f.summary('run-b')], nextCursor: 'second' });
  const host = createBibleHost(f.options);
  await host.round(); await host.round(); expect(f.options.catalog.list).toHaveBeenCalledTimes(1);
  await host.round(); expect(f.options.catalog.list.mock.calls[1]![0]).toMatchObject({ cursor: 'second' });
  await host.round(); expect(f.options.catalog.list).toHaveBeenCalledTimes(2); await host.round();
  expect(f.options.store.read).toHaveBeenCalledWith({ ...f.options.scope, runId: 'run-c' });
  expect(f.options.catalog.list.mock.calls[2]![0]).not.toHaveProperty('cursor');
});
it.each(['reconciling', 'succeeded', 'failed', 'cancelled'] as TaskStatus[])('does not execute or skip a terminal/unknown %s chunk', async status => {
  const f = fixture(); f.options.durable.enqueue.mockImplementation(async request => ({ ...request, status, attempts: 1, fence: 1, owner: null, leaseUntil: null, output: { state: 'blocked' }, error: null }));
  const host = createBibleHost(f.options); await host.round(); await host.round(); await host.round();
  expect(f.options.worker.runTask).not.toHaveBeenCalled(); expect(f.options.durable.enqueue.mock.calls[0]).toEqual(f.options.durable.enqueue.mock.calls[1]);
});
it('uses durable claim eligibility for running/waiting and counts only actual claims', async () => {
  for (const status of ['running', 'waiting'] as const) {
    const f = fixture(); f.options.durable.enqueue.mockImplementation(async request => ({ ...request, status, attempts: 1, fence: 1, owner: null, leaseUntil: null, output: null, error: null }));
    f.options.worker.runTask.mockImplementation(async () => ({ status: 'succeeded' }) as Task);
    expect(await createBibleHost(f.options).round()).toMatchObject({ executed: 1 });
  }
});
it('continues past a failed run, but never executes stale or reviewed source work', async () => {
  const f = fixture(); f.options.runsPerRound = 3; f.options.catalog.list.mockResolvedValue({ items: [f.summary('run-a'), f.summary('run-b'), f.summary('run-c')], nextCursor: null });
  vi.mocked(f.options.store.read).mockImplementation(async key => {
    if (key.runId === 'run-a') throw new Error('fixture-secret');
    return key.runId === 'run-b' ? { ...f.progress(key.runId), review: { status: 'rejected' } as BibleProgress['review'] } : f.progress(key.runId);
  }); vi.mocked(f.options.store.isCurrent).mockResolvedValue(false);
  expect(await createBibleHost(f.options).round()).toEqual({ visited: 3, executed: 0, errors: 1 }); expect(f.options.durable.enqueue).not.toHaveBeenCalled();
});
it('stops new tasks after abort and waits for the active bounded attempt before returning', async () => {
  const f = fixture(); const signal = new AbortController(); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const active = new Promise<void>(resolve => { release = resolve; });
  f.options.worker.runTask.mockImplementation(async () => { entered(); await active; return { status: 'succeeded' } as Task; });
  let finished = false; const pending = createBibleHost(f.options).run(signal.signal).then(result => { finished = true; return result; });
  await started; signal.abort(); await Promise.resolve(); expect(finished).toBe(false); release();
  expect(await pending).toEqual({ reason: 'stopped', rounds: 1, errors: 0 }); expect(f.options.worker.runTask).toHaveBeenCalledOnce();
});
it('handles empty polling, pre-aborted signals and natural polling without a busy loop', async () => {
  const f = fixture(); const signal = new AbortController(); let reads = 0;
  f.options.catalog.list.mockImplementation(async () => { if (++reads === 2) signal.abort(); return { items: [], nextCursor: null }; });
  expect(await createBibleHost(f.options).run(signal.signal)).toEqual({ reason: 'stopped', rounds: 2, errors: 0 });
  expect(await createBibleHost(f.options).run(signal.signal)).toEqual({ reason: 'stopped', rounds: 0, errors: 0 });
  expect(await createBibleHost(f.options).round(signal.signal)).toEqual({ visited: 0, executed: 0, errors: 0 });
});
it('aborts idle polling immediately and stops between enqueue and execution', async () => {
  const f = fixture(); const signal = new AbortController(); f.options.catalog.list.mockResolvedValue({ items: [], nextCursor: null });
  const pending = createBibleHost(f.options).run(signal.signal); await new Promise(resolve => setTimeout(resolve, 5)); signal.abort(); await pending;
  const second = fixture(); const halt = new AbortController(); const enqueue = second.options.durable.enqueue.getMockImplementation()!;
  second.options.durable.enqueue.mockImplementation(async request => { const result = await enqueue(request); halt.abort(); return result; });
  await createBibleHost(second.options).round(halt.signal); expect(second.options.worker.runTask).not.toHaveBeenCalled();
});
it('rejects concurrent rounds, malformed metadata and missing workflow declarations', async () => {
  const f = fixture(); let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  f.options.catalog.list.mockImplementation(async () => { await wait; return { items: [], nextCursor: null }; });
  const host = createBibleHost(f.options); const pending = host.round(); await expect(host.round()).rejects.toMatchObject({ code: 'CONFLICT' }); release(); await pending;
  f.options.catalog.list.mockResolvedValue({ items: [], nextCursor: 'bad' }); await expect(host.round()).rejects.toMatchObject({ code: 'STORAGE_FAILED' });
  f.options.worker.hasWorkflow.mockReturnValue(false); expect(() => createBibleHost(f.options)).toThrow('Bible host workflow unavailable');
});

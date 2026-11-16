import { expect, it, vi } from 'vitest';
import { digest } from '@camery/methods';
import type { DurableStore, Task } from '@camery/durable';
import { AgentDispatchHost } from '../src/host.js';
import { createOutboxItem } from '../src/relay.js';
import type { OutboxItem, OutboxScope } from '../src/relay.js';
import type { AgentHostOptions } from '../src/host.js';
import type { StoredTaskTree } from '../src/task-service.js';

function fixture(children = 1, independent = false) {
  const tree = { tenantId: 'tenant', projectId: 'project', treeId: 'tree' }; const pin = { id: 'research', version: '1.0.0', digest: 'a'.repeat(64) };
  const root = { taskId: 'root', parentId: null, agent: pin, input: { text: 'root' }, dependencies: [], scope: { tenantId: tree.tenantId, projectId: tree.projectId, objectIds: ['source'] }, status: 'queued' as const };
  const tasks = [root, ...Array.from({ length: children }, (_unused, index) => ({ ...root, taskId: `child-${index}`, parentId: 'root', input: { text: `child-${index}` }, dependencies: independent ? [] : ['root'] }))];
  const saved: StoredTaskTree = { definition: { ...tree, tasks, routes: [{ agent: pin, workflow: 'research-flow', version: 1, maxAttempts: 1, outputKind: 'raw' }] }, tasks: tasks.map(task => ({ task: structuredClone(task), treeId: tree.treeId, revision: 0, durableTaskId: null })) };
  const outbox: OutboxItem[] = []; const acknowledged = new Set<string>(); const jobs = new Map<string, Task>();
  const collaboration = {
    tree: vi.fn(async () => structuredClone(saved)),
    syncTask: vi.fn(async (key: { taskId: string }) => { const value = saved.tasks.find(item => item.task.taskId === key.taskId)!; const physical = value.durableTaskId ? jobs.get(value.durableTaskId) : undefined;
      if (physical && physical.status !== value.task.status) { const status = physical.status === 'reconciling' ? 'waiting' : physical.status; value.task = { ...value.task, status, ...(status === 'succeeded' ? { output: physical.output } : status === 'failed' ? { errorCode: 'WORKFLOW_FAILED' } : {}) }; value.revision++; } return structuredClone(value); }),
    queueReady: vi.fn(async () => { const ids: string[] = []; for (const item of saved.tasks) if (!item.durableTaskId && item.task.status === 'queued' && item.task.dependencies.every(id => saved.tasks.some(other => other.task.taskId === id && other.task.status === 'succeeded'))) {
      item.durableTaskId = `agent_${digest({ ...tree, taskId: item.task.taskId })}`; item.revision++; const id = `outbox-${item.task.taskId}`; ids.push(id);
      outbox.push(createOutboxItem({ tenantId: tree.tenantId, projectId: tree.projectId, outboxId: id, kind: 'enqueue', payload: { tenantId: tree.tenantId, taskId: item.durableTaskId, workflow: 'research-flow', version: 1, maxAttempts: 1, input: item.task.input, availableAt: '2026-01-01T00:00:00.000Z' } }));
    } return ids; }),
    pending: vi.fn(async (_scope: OutboxScope, limit: number) => outbox.filter(item => !acknowledged.has(item.outboxId)).slice(0, limit)),
    acknowledge: vi.fn(async (_scope: OutboxScope, id: string) => { acknowledged.add(id); }),
  };
  const durable = { enqueue: vi.fn<DurableStore['enqueue']>(async input => { const existing = jobs.get(input.taskId); if (existing) return structuredClone(existing); const value: Task = { ...input, status: 'queued', attempts: 0, fence: 0, owner: null, leaseUntil: null, output: null, error: null }; jobs.set(input.taskId, value); return structuredClone(value); }), signal: vi.fn(), steps: vi.fn(), get: vi.fn<DurableStore['get']>(async key => structuredClone(jobs.get(key.taskId) ?? null)) };
  const worker = { hasWorkflow: vi.fn(() => true), runTask: vi.fn(async (key: { taskId: string }): Promise<Task | null> => { const job = jobs.get(key.taskId); if (!job || job.status !== 'queued') return null; job.status = 'succeeded'; job.output = job.input; return structuredClone(job); }) };
  const options: AgentHostOptions = { tree, workerId: 'host-worker', collaboration, durable, worker, pollIntervalMs: 50 }; const host = new AgentDispatchHost(options);
  return { tree, pin, saved, outbox, acknowledged, jobs, collaboration, durable, worker, options, host };
}
it('coordinates dependency dispatch and exact-target execution over bounded ticks', async () => {
  const f = fixture(); const first = await f.host.tick(); expect(first).toMatchObject({ state: 'active', queued: ['outbox-root'], executed: [{ taskId: 'root', status: 'succeeded' }] });
  const second = await f.host.tick(); expect(second).toMatchObject({ state: 'complete', queued: ['outbox-child-0'] }); expect(f.worker.runTask.mock.calls.map(([key]) => key.taskId)).toEqual(f.saved.tasks.map(item => item.durableTaskId)); expect(f.durable.enqueue).toHaveBeenCalledTimes(2); expect(Object.isFrozen(second.tasks)).toBe(true);
  expect((await f.host.tick()).executed).toEqual([]);
});
it('leaves another tree outbox and unrelated work untouched even within the same project', async () => {
  const f = fixture(0); f.outbox.push(createOutboxItem({ tenantId: 'tenant', projectId: 'project', outboxId: 'foreign', kind: 'enqueue', payload: { tenantId: 'tenant', taskId: 'another-tree-task', workflow: 'foreign-workflow', version: 1, maxAttempts: 1, input: { private: 'other source' }, availableAt: '2026-01-01T00:00:00.000Z' } }));
  expect((await f.host.tick()).state).toBe('complete'); expect(f.jobs.has('another-tree-task')).toBe(false); expect(f.acknowledged.has('foreign')).toBe(false); expect(JSON.stringify(await f.host.tick())).not.toContain('other source');
});
it('rejects unavailable workflow routes and inconsistent scope before queuing or running anything', async () => {
  const f = fixture(); f.worker.hasWorkflow.mockReturnValue(false); await expect(f.host.tick()).rejects.toMatchObject({ code: 'AGENT_HOST_WORKFLOW' }); expect(f.collaboration.queueReady).not.toHaveBeenCalled();
  const other = fixture(); other.saved.definition.projectId = 'outside'; await expect(other.host.tick()).rejects.toThrow(); expect(other.worker.runTask).not.toHaveBeenCalled();
});
it.each([false, true])('observes and refuses an accidentally asynchronous workflow check (rejection: %s)', async rejected => {
  const f = fixture(); f.worker.hasWorkflow.mockImplementation(() => (rejected ? Promise.reject(new Error('late capability rejection')) : Promise.resolve(true)) as unknown as boolean);
  await expect(f.host.tick()).rejects.toMatchObject({ code: 'ASYNC_CALLBACK' }); await new Promise(resolve => setTimeout(resolve, 0)); expect(f.worker.runTask).not.toHaveBeenCalled();
});
it.each(['physical', 'input', 'tree-id', 'duplicate'] as const)('rejects an inconsistent stored task snapshot: %s', async kind => {
  const f = fixture(); if (kind === 'physical') f.saved.tasks[0]!.durableTaskId = 'wrong'; if (kind === 'input') f.saved.tasks[0]!.task.input = { text: 'changed' }; if (kind === 'tree-id') f.saved.tasks[0]!.treeId = 'wrong'; if (kind === 'duplicate') f.saved.tasks[1] = structuredClone(f.saved.tasks[0]!);
  await expect(f.host.tick()).rejects.toMatchObject({ code: 'AGENT_HOST_SNAPSHOT' }); expect(f.collaboration.queueReady).not.toHaveBeenCalled();
});
it('does not run a physical journal that differs from the immutable route or input', async () => {
  const f = fixture(0); f.durable.get.mockImplementation(async key => { const job = f.jobs.get(key.taskId); return job ? { ...job, version: 2 } : null; });
  await expect(f.host.tick()).rejects.toMatchObject({ code: 'AGENT_HOST_JOB_CONFLICT' }); expect(f.worker.runTask).not.toHaveBeenCalled();
});
it('marks failed dependencies blocked while completing independent branches first', async () => {
  const f = fixture(1); f.worker.runTask.mockImplementation(async key => { const job = f.jobs.get(key.taskId)!; job.status = 'failed'; return structuredClone(job); });
  expect(await f.host.run(new AbortController().signal)).toMatchObject({ reason: 'blocked', last: { state: 'blocked', blockedTaskIds: ['root', 'child-0'] } }); expect(f.saved.tasks[1]!.durableTaskId).toBeNull();
});
it('rotates bounded scans so waiting work cannot permanently starve independent ready jobs', async () => {
  const f = fixture(2, true); const host = new AgentDispatchHost({ ...f.options, maxTasksPerTick: 1, maxExecutionsPerTick: 1 }); f.worker.runTask.mockImplementation(async key => { const job = f.jobs.get(key.taskId)!; if (job.input && typeof job.input === 'object' && !Array.isArray(job.input) && job.input['text'] === 'root') { job.status = 'waiting'; return structuredClone(job); } if (job.status !== 'queued') return null; job.status = 'succeeded'; job.output = job.input; return structuredClone(job); });
  for (let index = 0; index < 4; index++) await host.tick(); expect(f.saved.tasks.filter(item => item.task.status === 'succeeded')).toHaveLength(2); expect((await host.tick()).state).toBe('waiting');
});
it('advances past the last inspected task when the execution budget ends before the scan budget', async () => {
  const f = fixture(1, true); const host = new AgentDispatchHost({ ...f.options, maxTasksPerTick: 2, maxExecutionsPerTick: 1 });
  f.worker.runTask.mockImplementation(async key => { const job = f.jobs.get(key.taskId)!; if (job.input && typeof job.input === 'object' && !Array.isArray(job.input) && job.input['text'] === 'root') job.status = 'waiting'; else { job.status = 'succeeded'; job.output = job.input; } return structuredClone(job); });
  await host.tick(); await host.tick(); expect(f.saved.tasks[1]!.task.status).toBe('succeeded');
});
it('captures host keys/capabilities and rejects concurrent use of one host instance', async () => {
  const f = fixture(0); const original = f.collaboration.tree.getMockImplementation()!; let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); f.collaboration.tree.mockImplementationOnce(async () => { await gate; return original(); });
  const pending = f.host.tick(); f.options.tree = { ...f.options.tree, projectId: 'mutated' }; f.collaboration.queueReady = vi.fn(async () => { throw new Error('replaced capability'); });
  await expect(f.host.tick()).rejects.toMatchObject({ code: 'AGENT_HOST_BUSY' }); await expect(f.host.run(new AbortController().signal)).rejects.toMatchObject({ code: 'AGENT_HOST_BUSY' }); release(); expect((await pending).state).toBe('complete');
});
it('aborts idle polling promptly and drains an in-flight target attempt without claiming its child', async () => {
  const f = fixture(); let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); const original = f.worker.runTask.getMockImplementation()!; f.worker.runTask.mockImplementationOnce(async key => { await gate; return original(key); });
  const controller = new AbortController(); let settled = false; const pending = f.host.run(controller.signal).then(value => { settled = true; return value; }); await vi.waitFor(() => expect(f.worker.runTask).toHaveBeenCalledOnce()); controller.abort(); await Promise.resolve(); expect(settled).toBe(false); release(); expect((await pending).reason).toBe('aborted'); expect(f.saved.tasks[1]!.durableTaskId).toBeNull();
  const idle = fixture(0); idle.worker.runTask.mockImplementation(async key => { const job = idle.jobs.get(key.taskId)!; job.status = 'waiting'; return structuredClone(job); }); const stop = new AbortController(); const running = new AgentDispatchHost({ ...idle.options, pollIntervalMs: 10000 }).run(stop.signal); await vi.waitFor(() => expect(idle.worker.runTask).toHaveBeenCalledOnce()); stop.abort(); expect((await running).reason).toBe('aborted');
});
it('does not leak failed host diagnostics and releases its busy guard after failure', async () => {
  const f = fixture(0); f.collaboration.tree.mockRejectedValueOnce(new Error('postgres://private:password@host')); await expect(f.host.tick()).rejects.toMatchObject({ code: 'AGENT_HOST_FAILED', message: 'AGENT_HOST_FAILED: agent runtime (not_applicable)' }); expect((await f.host.tick()).state).toBe('complete');
  const stopped = new AbortController(); stopped.abort(); await expect(f.host.tick(stopped.signal)).rejects.toMatchObject({ code: 'AGENT_HOST_ABORTED' }); expect(await f.host.run(stopped.signal)).toEqual({ reason: 'aborted', last: null });
});
it('validates bounded configuration and refuses worker implementations without targeted claims', () => {
  const f = fixture(); for (const change of [{ maxTasksPerTick: 0 }, { maxExecutionsPerTick: 101 }, { outboxLimit: 101 }, { pollIntervalMs: 0 }, { workerId: '' }]) expect(() => new AgentDispatchHost({ ...f.options, ...change })).toThrow();
  expect(() => new AgentDispatchHost({ ...f.options, worker: { ...f.worker, runTask: false as never } })).toThrow('INVALID_AGENT_HOST');
});

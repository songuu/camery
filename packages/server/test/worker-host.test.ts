import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { AgentRegistry } from '@camery/agents';
import type { StoredTaskTree } from '@camery/agents';
import { loadAgentDefinition } from '@camery/agents/node';
import { digest } from '@camery/methods';
import { createChapterWorkerHost } from '../src/worker-host.js';
import { chapterWorkerRoute } from '../src/chapter-worker.js';
const scope = { tenantId: 'tenant-a', projectId: 'project-a', treeId: 'tree-a' };
async function setup() {
  const agents = new AgentRegistry(); const producer = agents.register(await loadAgentDefinition(fileURLToPath(new URL('../../../agents/producer', import.meta.url))));
  const task = { taskId: 'logical-a', parentId: null, agent: producer, input: { sourceId: 'source-a', text: '原文。' }, dependencies: [], scope: { tenantId: scope.tenantId, projectId: scope.projectId, objectIds: ['source-a'] }, status: 'queued' as const };
  const snapshot: StoredTaskTree = { definition: { ...scope, tasks: [task], routes: [{ agent: producer, ...chapterWorkerRoute }] }, tasks: [{ task: { ...task, status: 'succeeded', output: { state: 'reviewed_candidate', candidateDigest: 'a'.repeat(64) } }, treeId: scope.treeId, revision: 2, durableTaskId: `agent_${digest({ ...scope, taskId: task.taskId })}` }] };
  const collaboration = { tree: vi.fn(async () => snapshot), syncTask: vi.fn(), queueReady: vi.fn(async () => []), pending: vi.fn(async () => []), acknowledge: vi.fn() };
  const durable = { enqueue: vi.fn(), get: vi.fn(), steps: vi.fn(), signal: vi.fn() };
  const worker = { hasWorkflow: vi.fn(() => true), runTask: vi.fn() };
  return { producer, snapshot, options: { scope, workerId: 'worker-a', producer, collaboration, durable, worker } };
}
it('uses the scoped dispatch host and returns complete without repeating terminal work', async () => {
  const f = await setup(); expect((await createChapterWorkerHost(f.options).tick()).state).toBe('complete');
  expect(f.options.worker.runTask).not.toHaveBeenCalled();
});
it('rejects changed route policy, unscoped source, invalid input and another deployment before queueing', async () => {
  for (const mutate of [
    (tree: StoredTaskTree) => { tree.definition.routes[0]!.maxAttempts = 4; },
    (tree: StoredTaskTree) => { tree.definition.routes[0]!.outputKind = 'agent_report'; },
    (tree: StoredTaskTree) => { tree.definition.projectId = 'other'; },
    (tree: StoredTaskTree) => { tree.definition.tasks[0]!.scope.objectIds = ['outside']; },
    (tree: StoredTaskTree) => { tree.definition.tasks[0]!.input = { sourceId: 'source-a', text: '' }; },
  ]) {
    const f = await setup(); mutate(f.snapshot);
    await expect(createChapterWorkerHost(f.options).tick()).rejects.toThrow();
    expect(f.options.collaboration.queueReady).not.toHaveBeenCalled(); expect(f.options.worker.runTask).not.toHaveBeenCalled();
  }
});
it('returns the same detached snapshot it validated across the host await boundary', async () => {
  const f = await setup(); let reads = 0;
  f.options.collaboration.tree.mockImplementation(async () => {
    if (reads++ === 0) queueMicrotask(() => queueMicrotask(() => { f.snapshot.definition.routes[0]!.maxAttempts = 4; }));
    return f.snapshot;
  });
  f.options.collaboration.queueReady.mockImplementation(async () => { f.snapshot.definition.routes[0]!.maxAttempts = 3; return []; });
  await expect(createChapterWorkerHost(f.options).tick()).resolves.toMatchObject({ state: 'complete' });
});

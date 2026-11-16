import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { AgentRegistry, type AllocationRequest } from '@camery/agents';
import { loadAgentDefinition } from '@camery/agents/node';
import { chapterPack, digest, MethodRegistry, MethodRunner } from '@camery/methods';
import type { WorkflowContext, Json } from '@camery/durable';
import { createChapterWorkerWorkflow, chapterWorkerBudget } from '../src/chapter-worker.js';
const scope = { tenantId: 'tenant-a', projectId: 'project-a', treeId: 'tree-a' };
async function setup() {
  const methods = new MethodRegistry(); const method = methods.register(chapterPack);
  const agents = new AgentRegistry(); const producer = agents.register({ ...await loadAgentDefinition(fileURLToPath(new URL('../../../agents/producer', import.meta.url))), methods: [method] });
  const taskId = `agent_${digest({ ...scope, taskId: 'logical-a' })}`;
  const input = { sourceId: 'source-a', text: '第一章 出发\n原文。\n第二章 归来\n后文。' };
  const assignment = { treeId: scope.treeId, revision: 1, durableTaskId: taskId, task: { taskId: 'logical-a', parentId: null, agent: producer, input, dependencies: [], status: 'running' as const, scope: { tenantId: scope.tenantId, projectId: scope.projectId, objectIds: ['source-a'] } } };
  const assign = vi.fn(async () => assignment);
  const allocate = vi.fn(async (request: AllocationRequest) => ({ ...request, taskFingerprint: digest({ taskId }), state: 'held' as const, confirmation: null }));
  const cache = new Map<string, Json>();
  const context: WorkflowContext = { task: { tenantId: scope.tenantId, taskId }, signal: new AbortController().signal,
    step: async (key, options, effect) => { if (cache.has(key)) return cache.get(key)!; const result = await effect({ input: options.input, signal: new AbortController().signal, idempotencyKey: `key-${key}` }); cache.set(key, result); return result; },
    waitForSignal: vi.fn(async (_key, value) => ({ decision: 'accept', candidateDigest: (value as Record<string, Json>)['candidateDigest']! })), sleepUntil: vi.fn() };
  const options = { scope, agents, producer, methods, method, collaboration: { assignment: assign }, ledger: { allocate } };
  return { options, assignment, assign, allocate, context, input, agents, producer };
}
it('runs the pinned chapter producer under a real journaled budget allocation and only returns its declared output', async () => {
  const f = await setup(); const workflow = createChapterWorkerWorkflow(f.options); const spy = vi.spyOn(MethodRunner.prototype, 'run');
  try {
    const result = await workflow.run(f.input, f.context);
    expect(result).toEqual({ state: 'reviewed_candidate', candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.agents.validateOutput(f.producer, result)).toBe(true);
    expect(f.allocate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: scope.tenantId, projectId: scope.projectId, taskId: f.context.task.taskId, agent: f.producer, budget: chapterWorkerBudget }));
    expect(await workflow.run(f.input, f.context)).toEqual(result); expect(spy).toHaveBeenCalledOnce(); expect(f.allocate).toHaveBeenCalledOnce();
  } finally { spy.mockRestore(); }
});
it('rejects forged assignment scope, task identity, source or role before reserving budget', async () => {
  for (const change of [
    { treeId: 'other-tree' }, { durableTaskId: 'other-task' },
    { task: { field: 'scope', value: { tenantId: scope.tenantId, projectId: 'other-project', objectIds: ['source-a'] } } },
    { task: { field: 'taskId', value: 'other-logical' } },
    { task: { field: 'agent', value: { id: 'research', version: '1.0.0', digest: 'a'.repeat(64) } } },
    { task: { field: 'input', value: { sourceId: 'source-a', text: 'different source' } } },
    { task: { field: 'scope', value: { tenantId: scope.tenantId, projectId: scope.projectId, objectIds: ['outside'] } } },
  ]) {
    const f = await setup();
    if ('task' in change) Object.assign(f.assignment.task, { [change.task.field]: change.task.value }); else Object.assign(f.assignment, change);
    await expect(createChapterWorkerWorkflow(f.options).run(f.input, f.context)).rejects.toThrow(); expect(f.allocate).not.toHaveBeenCalled();
  }
});
it('does not run the method with invalid, foreign, closed or malformed allocations', async () => {
  for (const change of [{ tenantId: 'other' }, { budget: { ...chapterWorkerBudget, maxSteps: 9 } }, { taskFingerprint: 'invalid' }, { state: 'settled', confirmation: { actorId: 'operator', receiptId: 'r', reference: 'verified', actual: { steps: 0, tokens: 0, costMicros: 0 } } }, null]) {
    const f = await setup(); const original = f.allocate.getMockImplementation()!;
    f.allocate.mockImplementation(async request => change === null ? null as never : { ...await original(request), ...change } as never);
    const method = vi.spyOn(MethodRunner.prototype, 'run');
    try { await expect(createChapterWorkerWorkflow(f.options).run(f.input, f.context)).rejects.toThrow(); expect(method).not.toHaveBeenCalled(); } finally { method.mockRestore(); }
  }
});
it('preserves durable suspension and captures the source before waiting on the assignment', async () => {
  const f = await setup(); const suspension = new Error('internal durable suspension');
  f.context.waitForSignal = vi.fn(async () => { throw suspension; });
  let release = () => {}; const waiting = new Promise<void>(resolve => { release = resolve; });
  f.assign.mockImplementation(async () => { await waiting; return f.assignment; });
  const input = { ...f.input }; const running = createChapterWorkerWorkflow(f.options).run(input, f.context); input.text = 'changed during lookup'; release();
  await expect(running).rejects.toBe(suspension); expect(f.allocate).toHaveBeenCalledOnce();
});
it('rejects invalid sources, foreign journal identity and an unpinned producer before assignment or allocation', async () => {
  const f = await setup(); const workflow = createChapterWorkerWorkflow(f.options);
  const getter = vi.fn(() => { throw new Error('private source diagnostic'); });
  const hostile = Object.defineProperty({}, 'sourceId', { get: getter });
  for (const input of [{ sourceId: 'source-a', text: '' }, { ...f.input, tenantId: 'forged' }, hostile]) await expect(workflow.run(input, f.context)).rejects.toMatchObject({ code: 'WORKER_SOURCE' });
  expect(getter).not.toHaveBeenCalled();
  Object.assign(f.context.task, { tenantId: 'other' });
  await expect(workflow.run(f.input, f.context)).rejects.toMatchObject({ code: 'WORKER_SCOPE' });
  expect(f.assign).not.toHaveBeenCalled(); expect(f.allocate).not.toHaveBeenCalled();
  const agents = new AgentRegistry(); const producer = agents.register({ ...f.agents.resolve(f.producer), methods: [] });
  expect(() => createChapterWorkerWorkflow({ ...f.options, agents, producer })).toThrow('WORKER_PRODUCER');
});

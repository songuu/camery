import { expect, it, vi } from 'vitest';
import type { WorkflowContext } from '@camery/durable';
import type { AgentRuntime } from '../src/runtime.js';
import { Allocation, AllocationRequest, budgetData, BudgetAmounts, BudgetConfirmation, createBudgetedAgentWorkflow } from '../src/budget.js';
const agent = { id: 'research', version: '1.0.0', digest: 'a'.repeat(64) };
const budget = { maxSteps: 8, maxTokens: 100, maxCostMicros: 200, currency: 'CNY' };
const request = { tenantId: 'tenant-a', projectId: 'project-a', taskId: 'task-a', allocationId: 'allocation-a', agent, budget };
function fixture() {
  const allocate = vi.fn(async () => ({ ...request, taskFingerprint: 'b'.repeat(64), state: 'held' as const, confirmation: null }));
  const run = vi.fn(async () => ({ state: 'candidate', agent, output: { candidate: true }, reason: null, steps: 1, charged: { tokens: 0, costMicros: 0 }, usageUnknown: false, spans: [] }));
  const planFor = vi.fn(async () => ({ projectId: 'project-a', objectIds: ['source-a'], stage: 'understanding', writers: [], taskBudget: budget, allocationId: request.allocationId, allocationBudget: budget }));
  const options = { name: 'budgeted-research', version: 1, agent, ledger: { allocate }, planFor, runtime: { run } as unknown as AgentRuntime };
  const context: WorkflowContext = { task: { tenantId: request.tenantId, taskId: request.taskId }, signal: new AbortController().signal, step: async (_key, options, effect) => effect({ input: options.input, signal: new AbortController().signal, idempotencyKey: 'allocation-step' }), waitForSignal: vi.fn(), sleepUntil: vi.fn() };
  return { options, context, allocate, run, planFor };
}
it('constructs runtime grants from a journaled database allocation and the actual durable identity', async () => {
  const f = fixture(); const workflow = createBudgetedAgentWorkflow(f.options); const original = { text: 'source', tenantId: 'forged' };
  await expect(workflow.run(original, f.context)).resolves.toMatchObject({ state: 'candidate' });
  expect(f.allocate).toHaveBeenCalledWith(request); expect(f.planFor).toHaveBeenCalledWith(f.context.task);
  expect(f.run).toHaveBeenCalledWith(agent, original, expect.objectContaining({ tenantId: request.tenantId, taskId: request.taskId, projectAllocation: budget }), f.context);
});
it('does not run an agent when allocation fails or returns a different or closed grant', async () => {
  for (const result of [new Error('limit'), { ...request, state: 'held', taskFingerprint: 'b'.repeat(64), confirmation: null, budget: { ...budget, maxTokens: 101 } }, { ...request, state: 'settled', taskFingerprint: 'b'.repeat(64), confirmation: { actorId: 'operator', receiptId: 'r1', reference: 'verified-bill', actual: { steps: 0, tokens: 0, costMicros: 0 } } }]) {
    const f = fixture(); if (result instanceof Error) f.allocate.mockRejectedValueOnce(result); else f.allocate.mockResolvedValueOnce(result as never);
    await expect(createBudgetedAgentWorkflow(f.options).run({}, f.context)).rejects.toThrow(); expect(f.run).not.toHaveBeenCalled();
  }
});
it('rejects invalid amounts, unknown settlements, malformed workflows and currency mismatches', async () => {
  for (const input of [{ steps: -1, tokens: 0, costMicros: 0 }, { steps: 0, tokens: Number.MAX_SAFE_INTEGER + 1, costMicros: 0 }, { steps: 0, tokens: 0, costMicros: null }, { steps: 0, tokens: 0, costMicros: Infinity }]) expect(() => budgetData(BudgetAmounts, input)).toThrow('INVALID_BUDGET_INPUT');
  expect(() => budgetData(BudgetConfirmation, { actorId: 'operator', receiptId: 'bill', reference: 'receipt', actual: { steps: 1, tokens: null, costMicros: 0 } })).toThrow();
  expect(() => budgetData(AllocationRequest, { ...request, tenantId: '' })).toThrow();
  const f = fixture(); expect(() => createBudgetedAgentWorkflow({ ...f.options, name: 'Invalid Name' })).toThrow();
  f.planFor.mockResolvedValueOnce({ ...await f.planFor(), allocationBudget: { ...budget, currency: 'USD' } } as never);
  await expect(createBudgetedAgentWorkflow(f.options).run({}, f.context)).rejects.toThrow('CURRENCY_MISMATCH'); expect(f.allocate).not.toHaveBeenCalled();
  expect(() => budgetData(Allocation, { ...request, taskFingerprint: 'b'.repeat(64), state: 'held', confirmation: { actorId: 'x' } })).toThrow();
});
it('captures the source before awaiting a host plan or database allocation', async () => {
  const f = fixture(); let release: () => void = () => {}; const pendingPlan = new Promise<void>(resolve => { release = resolve; }); const plan = await f.planFor();
  f.planFor.mockImplementationOnce(async () => { await pendingPlan; return plan; }); const input = { text: 'original' };
  const pending = createBudgetedAgentWorkflow(f.options).run(input, f.context); input.text = 'changed during allocation'; release(); await pending;
  expect(f.run.mock.calls[0]).toEqual([agent, { text: 'original' }, expect.any(Object), f.context]);
});

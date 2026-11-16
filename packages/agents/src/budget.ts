import { z } from 'zod';
import { canonical, freeze, jsonCopy, Pin } from '@camery/methods';
import type { MethodPin } from '@camery/methods';
import type { TaskKey, Workflow } from '@camery/durable';
import { AgentError, BudgetSchema, Id, Name } from './registry.js';
import type { AgentRuntime, RunBinding } from './runtime.js';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const BudgetAmounts = z.strictObject({ steps: count, tokens: count, costMicros: count });
export type BudgetAmounts = z.infer<typeof BudgetAmounts>;
export const ProjectBudgetKey = z.strictObject({ tenantId: Name, projectId: Name });
export const ProjectBudgetDefinition = ProjectBudgetKey.extend({ currency: BudgetSchema.shape.currency, limits: BudgetAmounts });
export type ProjectBudgetDefinition = z.infer<typeof ProjectBudgetDefinition>;
export const AllocationKey = ProjectBudgetKey.extend({ taskId: Name, allocationId: Name });
export const AllocationRequest = AllocationKey.extend({ agent: Pin, budget: BudgetSchema });
export type AllocationRequest = z.infer<typeof AllocationRequest>;
export const BudgetConfirmation = z.strictObject({ actorId: Name, receiptId: Name, reference: Name, actual: BudgetAmounts });
export const Allocation = AllocationRequest.extend({ taskFingerprint: Pin.shape.digest, state: z.enum(['held', 'settled']), confirmation: BudgetConfirmation.nullable() }).refine(value => (value.state === 'settled') === (value.confirmation !== null));
export type BudgetAllocation = z.infer<typeof Allocation>;
export const ConfirmSettlement = AllocationKey.extend(BudgetConfirmation.shape);
export type ConfirmSettlement = z.infer<typeof ConfirmSettlement>;
export interface ProjectBudgetSnapshot { definition: ProjectBudgetDefinition; used: Record<keyof BudgetAmounts, string>; remaining: Record<keyof BudgetAmounts, string>; debt: Record<keyof BudgetAmounts, string> }
export interface BudgetLedger {
  allocate(input: AllocationRequest): Promise<BudgetAllocation>;
}
export class BudgetLedgerError extends Error {
  override readonly name = 'BudgetLedgerError';
  constructor(readonly code: string) { super(`${code}: agent budget ledger`); }
}
export function budgetData<T>(schema: z.ZodType<T>, input: unknown): T {
  try { const parsed = schema.safeParse(jsonCopy(input)); if (parsed.success) return freeze(parsed.data) as T; } catch { /* Normalize untrusted JSON diagnostics to this boundary. */ }
  throw new BudgetLedgerError('INVALID_BUDGET_INPUT');
}
const Plan = z.strictObject({ projectId: Name, logicalTaskId: Name.optional(), objectIds: z.array(Name).max(1000), stage: Id, writers: z.array(z.strictObject({ objectType: Id, agentId: Id })).max(100), taskBudget: BudgetSchema, allocationId: Name, allocationBudget: BudgetSchema });
export type BudgetedRunPlan = z.infer<typeof Plan>;
/** The allocation mutation is idempotent and journaled; settlement is deliberately a post-terminal host action. */
export function createBudgetedAgentWorkflow(options: { name: string; version: number; runtime: AgentRuntime; agent: MethodPin; ledger: BudgetLedger; planFor(task: Readonly<TaskKey>): Promise<BudgetedRunPlan> }): Workflow {
  const { name, version, runtime } = options; const agent = budgetData(Pin, options.agent);
  if (!Id.safeParse(name).success || !Number.isSafeInteger(version) || version < 1 || typeof options.ledger.allocate !== 'function' || typeof options.planFor !== 'function') throw new BudgetLedgerError('INVALID_BUDGET_WORKFLOW');
  const allocate = options.ledger.allocate.bind(options.ledger); const planFor = options.planFor.bind(options); const run = runtime.run.bind(runtime);
  return { name, version, async run(input, context) {
    const captured = jsonCopy(input); freeze(captured);
    const plan = budgetData(Plan, await planFor(context.task));
    if (plan.taskBudget.currency !== plan.allocationBudget.currency) throw new BudgetLedgerError('CURRENCY_MISMATCH');
    const request = budgetData(AllocationRequest, { tenantId: context.task.tenantId, taskId: context.task.taskId, projectId: plan.projectId, allocationId: plan.allocationId, agent, budget: plan.allocationBudget });
    const raw = await context.step('budget.allocate', { kind: 'replayable', input: JSON.parse(canonical(request)) }, async () => JSON.parse(canonical(await allocate(request))));
    const allocation = budgetData(Allocation, raw);
    const actualRequest = { tenantId: allocation.tenantId, taskId: allocation.taskId, projectId: allocation.projectId, allocationId: allocation.allocationId, agent: allocation.agent, budget: allocation.budget };
    if (canonical(actualRequest) !== canonical(request) || allocation.state !== 'held') throw new BudgetLedgerError('ALLOCATION_MISMATCH');
    const binding: RunBinding = { tenantId: context.task.tenantId, taskId: context.task.taskId, projectId: plan.projectId, ...(plan.logicalTaskId !== undefined ? { logicalTaskId: plan.logicalTaskId } : {}), objectIds: plan.objectIds, stage: plan.stage, writers: plan.writers, taskBudget: plan.taskBudget, allocationId: allocation.allocationId, projectAllocation: allocation.budget };
    const report = await run(agent, captured, binding, context);
    if (report.state !== 'candidate' && report.state !== 'blocked') throw new AgentError('INVALID_AGENT_REPORT');
    return JSON.parse(canonical(report));
  } };
}

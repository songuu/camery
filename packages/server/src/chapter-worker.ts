import { z } from 'zod';
import {
  Allocation, AllocationRequest, AgentRegistry, Name, TreeKeySchema, createChapterResearchWorkflow,
  persistenceData, validateAgentTask,
} from '@camery/agents';
import type { BudgetLedger, StoredTask, TaskTreeKey } from '@camery/agents';
import { canonical, digest, freeze, jsonCopy, Pin } from '@camery/methods';
import type { MethodPin, MethodRegistry } from '@camery/methods';
import type { TaskKey, Workflow } from '@camery/durable';

export const chapterWorkerRoute = Object.freeze({ workflow: 'phase0.chapter-research', version: 1, maxAttempts: 3, outputKind: 'raw' as const });
export const chapterWorkerBudget = Object.freeze({ maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' });
const Source = z.strictObject({ sourceId: Name, text: z.string().min(1).max(1000000) });
const Key = z.strictObject({ tenantId: Name, taskId: Name });
const Stored = z.strictObject({ task: z.unknown(), treeId: Name, revision: z.int().min(0), durableTaskId: Name.nullable() });
const Result = z.strictObject({ state: z.enum(['reviewed_candidate', 'rejected_candidate']), candidateDigest: Pin.shape.digest });
export class ChapterWorkerError extends Error {
  constructor(readonly code: string) { super(`${code}: chapter worker`); this.name = 'ChapterWorkerError'; }
}
export interface ChapterWorkerWorkflowOptions {
  scope: TaskTreeKey; agents: AgentRegistry; producer: MethodPin; methods: MethodRegistry; method: MethodPin;
  collaboration: { assignment(key: TaskKey): Promise<StoredTask> }; ledger: BudgetLedger;
}
function sourceData(input: unknown) {
  try { const parsed = Source.safeParse(jsonCopy(input)); if (parsed.success) return freeze(parsed.data); } catch { /* Do not expose source diagnostics. */ }
  throw new ChapterWorkerError('WORKER_SOURCE');
}
/** The built-in route is fixed; source content cannot choose providers, scopes, writers or budgets. */
export function createChapterWorkerWorkflow(options: ChapterWorkerWorkflowOptions): Workflow {
  const scope = persistenceData(TreeKeySchema, options.scope); const producer = persistenceData(Pin, options.producer); const method = persistenceData(Pin, options.method);
  const definition = options.agents.resolve(producer);
  if (definition.id !== 'producer' || definition.modelTier !== 'deterministic' || canonical(definition.budget) !== canonical(chapterWorkerBudget) || canonical(definition.methods) !== canonical([method]) || definition.tools.length !== 0 || canonical(definition.writeKinds) !== canonical(['task'])) throw new ChapterWorkerError('WORKER_PRODUCER');
  const methods = options.methods; methods.resolve(method);
  const assignmentFor = options.collaboration.assignment.bind(options.collaboration); const allocate = options.ledger.allocate.bind(options.ledger);
  const validateOutput = options.agents.validateOutput.bind(options.agents);
  return { name: chapterWorkerRoute.workflow, version: chapterWorkerRoute.version, async run(input, context) {
    const source = sourceData(input); const key = persistenceData(Key, context.task);
    if (key.tenantId !== scope.tenantId) throw new ChapterWorkerError('WORKER_SCOPE');
    const assigned = persistenceData(Stored, await assignmentFor(key)); const task = validateAgentTask(assigned.task);
    const physical = `agent_${digest({ ...scope, taskId: task.taskId })}`;
    if (assigned.treeId !== scope.treeId || assigned.durableTaskId !== key.taskId || physical !== key.taskId || task.scope.tenantId !== scope.tenantId || task.scope.projectId !== scope.projectId || canonical(task.agent) !== canonical(producer) || canonical(task.input) !== canonical(source) || task.scope.objectIds.length !== 1 || task.scope.objectIds[0] !== source.sourceId) throw new ChapterWorkerError('WORKER_SCOPE');
    const request = persistenceData(AllocationRequest, { ...key, projectId: scope.projectId, allocationId: `worker_${digest(key)}`, agent: producer, budget: chapterWorkerBudget });
    const raw = await context.step('budget.allocate', { kind: 'replayable', input: jsonCopy(request) }, async () => jsonCopy(await allocate(request)));
    const allocation = persistenceData(Allocation, raw);
    const returned = { tenantId: allocation.tenantId, projectId: allocation.projectId, taskId: allocation.taskId, allocationId: allocation.allocationId, agent: allocation.agent, budget: allocation.budget };
    if (canonical(returned) !== canonical(request) || allocation.state !== 'held') throw new ChapterWorkerError('WORKER_ALLOCATION');
    // Ledger owns the task fingerprint check, including its immutable enqueue identity.
    const workflow = createChapterResearchWorkflow({ name: chapterWorkerRoute.workflow, version: chapterWorkerRoute.version, methods, method, bindingFor: async actual => {
      if (canonical(actual) !== canonical(key)) throw new ChapterWorkerError('WORKER_SCOPE');
      return { ...key, projectId: scope.projectId, logicalTaskId: task.taskId, objectIds: [source.sourceId], stage: 'understanding', writers: [], taskBudget: chapterWorkerBudget, projectAllocation: allocation.budget, allocationId: allocation.allocationId };
    } });
    // Let durable suspension/lease errors propagate unchanged to the journal engine.
    const report = jsonCopy(await workflow.run(jsonCopy(source), context)) as Record<string, unknown>;
    const parsed = Result.safeParse({ state: report['state'], candidateDigest: report['candidateDigest'] });
    if (!parsed.success || !validateOutput(producer, parsed.data)) throw new ChapterWorkerError('WORKER_RESULT');
    // Full research candidates stay in journal/gate records; this matches the outer producer contract.
    return jsonCopy(parsed.data);
  } };
}

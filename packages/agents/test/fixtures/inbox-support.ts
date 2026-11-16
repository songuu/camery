import type { Pool } from 'pg';
import { digest } from '@camery/methods';
import { AgentRegistry, ToolRegistry } from '../../src/registry.js';
import { AgentRuntime } from '../../src/runtime.js';
import { createBudgetedAgentWorkflow } from '../../src/budget.js';
import { PostgresBudgetLedger } from '../../src/node/budgets.js';
import { PostgresCollaborationStore } from '../../src/node/collaboration-store.js';
import { createCollaborationQuestionInbox } from '../../src/node/question-inbox.js';
import type { DecisionDriver } from '../../src/runtime.js';

export const inboxBudget = { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' };
/** Synthetic decisions exercise persistence without a provider or paid tools. */
export function inboxSetup(pool: Pool, hooks: { decision?(): void; opened?(): Promise<void> } = {}) {
  const agents = new AgentRegistry(); const tools = new ToolRegistry();
  const agent = agents.register({ id: 'research', version: '1.0.0', instructions: 'Ask the host to choose a source before producing a candidate.', tools: [], methods: [], modelTier: 'deterministic', writeKinds: [], budget: inboxBudget, outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const collaboration = new PostgresCollaborationStore(pool, agents); const ledger = new PostgresBudgetLedger(pool);
  const inbox = createCollaborationQuestionInbox(collaboration, 'host-agent');
  const driver: DecisionDriver = { identity: 'synthetic-inbox-driver', digest: digest({ version: 1 }), evidence: 'deterministic', currency: 'CNY', reservation: { tokens: 0, costMicros: 0 },
    async decide(request) { hooks.decision?.(); return { action: request.observations.length ? { kind: 'finish', output: { text: 'host-selected candidate' } } : { kind: 'question', prompt: 'Which source?', choices: ['one', 'two'] }, usage: { tokens: 0, costMicros: 0 } }; } };
  const runtime = new AgentRuntime(agents, tools, driver, undefined, { identity: inbox.identity, digest: inbox.digest,
    async open(...args) { await inbox.open(...args); await hooks.opened?.(); } });
  const workflow = createBudgetedAgentWorkflow({ name: 'agent-inbox', version: 1, runtime, agent, ledger,
    async planFor(task) { const assigned = await collaboration.assignment(task); return { projectId: assigned.task.scope.projectId, logicalTaskId: assigned.task.taskId, objectIds: assigned.task.scope.objectIds, stage: 'understanding', writers: [], taskBudget: inboxBudget, allocationBudget: inboxBudget, allocationId: `allocation-${digest(task)}` }; } });
  return { agents, agent, collaboration, ledger, runtime, workflow };
}

import { afterEach, expect, it, vi } from 'vitest';
import { canonical } from '@camery/methods';
import { AgentRuntime } from '../src/runtime.js';
import { runAgentBehaviorEvaluations } from '../src/node/agent-evals.js';

afterEach(() => { vi.restoreAllMocks(); });
it('executes fixed synthetic behavior cases and exactly reproduces their reports from a fresh registry and cache', async () => {
  const first = await runAgentBehaviorEvaluations(); expect(first.passed).toBe(true); expect(first.cases).toHaveLength(10);
  const observed = (id: string) => first.cases.find(item => item.id === id)!.observed!;
  expect(observed('candidate-tool')).toMatchObject({ taskCompleted: true, decisionCycles: 2, toolCalls: 1, tokens: '4', costMicros: '3' });
  expect(observed('source-injection')).toMatchObject({ taskCompleted: true, tokens: null, costMicros: null, knownTokens: '2', knownCostMicros: '0', chargedTokens: '6', chargedCostMicros: '5' });
  expect(observed('paid-without-approval')).toMatchObject({ state: 'blocked', reason: 'APPROVAL_DENIED', taskCompleted: false, decisionCycles: 1, toolCalls: 1, chargedCostMicros: '0' });
  expect(observed('question-answer')).toMatchObject({ humanAssisted: true, questions: 1, decisionCycles: 2 });
  expect(observed('review-escalation')).toMatchObject({ state: 'candidate', taskCompleted: false, humanEscalated: true, reviewRounds: 2, reviewState: 'needs_human' });
  expect(observed('independent-review')).toMatchObject({ taskCompleted: true, humanEscalated: false, reviewRounds: 1, reviewState: 'reviewed_candidate' });
  expect(observed('chapter-research')).toMatchObject({ taskCompleted: true, decisionCycles: 2, toolCalls: 1, costMicros: '0' });
  expect(first.summary).toEqual({ completion: { completed: 5, total: 10, unknown: 0 }, humanEscalation: { escalated: 1, total: 10, unknown: 0 }, humanAssistance: { assisted: 2, total: 10, unknown: 0 },
    decisionCycles: '15', toolCalls: '6', questions: '1', reviewRounds: '3', measuredCases: 10, tokens: null, costMicros: null, knownTokens: '21', knownCostMicros: '9', chargedTokens: '25', chargedCostMicros: '14' });
  expect(await runAgentBehaviorEvaluations(first)).toEqual(first);
});
it('rejects a baseline with extra untrusted fields rather than silently accepting it', async () => {
  const report = await runAgentBehaviorEvaluations(); await expect(runAgentBehaviorEvaluations({ ...report, forgedApproval: true })).rejects.toThrow();
});
it('captures the validated baseline before any asynchronous case execution', async () => {
  const prior = structuredClone(await runAgentBehaviorEvaluations()); const pending = runAgentBehaviorEvaluations(prior);
  prior.suite.version = '9.9.9';
  await expect(pending).resolves.toMatchObject({ passed: true });
});
it('rejects a malformed baseline before invoking any runtime', async () => {
  const run = vi.spyOn(AgentRuntime.prototype, 'run');
  await expect(runAgentBehaviorEvaluations({ version: 1 })).rejects.toMatchObject({ code: 'INVALID_AGENT_EVAL_REPORT' });
  expect(run.mock.calls.length).toBe(0);
});
it('keeps independently declared output oracles when a successful runtime output changes', async () => {
  const run = AgentRuntime.prototype.run;
  vi.spyOn(AgentRuntime.prototype, 'run').mockImplementation(async function (this: AgentRuntime, ...args: Parameters<AgentRuntime['run']>) {
    const report = await run.apply(this, args);
    return report.state === 'candidate' && canonical(report.output) === canonical({ text: 'candidate' }) ? { ...report, output: { text: 'changed output' } } : report;
  });
  await expect(runAgentBehaviorEvaluations()).rejects.toMatchObject({ code: 'AGENT_EVALUATION_FAILED' });
});

import { expect, it } from 'vitest';
import { digest } from '@camery/methods';
import { runAgentEvaluations, assertAgentEvaluationBaseline, validateAgentEvaluationReport } from '../src/evaluations.js';
import type { AgentEvaluationSuite } from '../src/evaluations.js';
import type { AgentRunReport } from '../src/runtime.js';
const agent = { id: 'research', version: '1.0.0', digest: 'a'.repeat(64) };
function run(unknown = false): AgentRunReport {
  return { state: 'candidate', agent, output: { text: 'candidate' }, reason: null, steps: 1, charged: { tokens: 3, costMicros: 4 }, usageUnknown: unknown, spans: [{ id: 'b'.repeat(64), kind: 'decision', name: 'fixture-driver', pin: 'c'.repeat(64), inputDigest: 'd'.repeat(64), outputDigest: 'e'.repeat(64), usage: { tokens: unknown ? null : 3, costMicros: unknown ? null : 4 }, charged: { tokens: 3, costMicros: 4 }, outcome: 'not_applicable' }] };
}
function suite(): AgentEvaluationSuite { return { id: 'agent-contract', version: '1.0.0', currency: 'CNY', evidence: 'synthetic_contract', cases: [{ id: 'candidate', expected: { state: 'candidate', reason: null, outputDigest: digest({ text: 'candidate' }), reviewState: 'none' } }] }; }
it('reports observed task completion, cycles and exact costs separately from oracle success', async () => {
  const report = await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: run() }));
  expect(report.passed).toBe(true); expect(report.summary).toMatchObject({ completion: { completed: 1, total: 1, unknown: 0 }, humanEscalation: { escalated: 0, total: 1, unknown: 0 }, decisionCycles: '1', reviewRounds: '0', costMicros: '4', chargedCostMicros: '4' });
  expect(validateAgentEvaluationReport(report)).toEqual(report); expect(Object.isFrozen(report.cases)).toBe(true); assertAgentEvaluationBaseline(report, report);
});
it('keeps unknown usage unknown and preserves charged reservations separately from actual cost', async () => {
  const report = await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: run(true) }));
  expect(report.summary).toMatchObject({ tokens: null, costMicros: null, knownTokens: '0', knownCostMicros: '0', chargedTokens: '3', chargedCostMicros: '4' });
});
it('preserves known partial model tokens and aggregates safe per-run costs beyond JavaScript safe integers', async () => {
  const value = run(true); value.spans[0]!.modelCall = { tenantId: 'tenant', connectionId: 'connection', modeDigest: 'a'.repeat(64), modelIdentity: 'synthetic/model', evidence: 'synthetic_replay', callId: 'call', providerRequestId: 'fixture-call', inputDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64), usage: { inputTokens: 2, outputTokens: null } };
  value.spans[0]!.usage.costMicros = 0; value.spans[0]!.charged.costMicros = 0; value.charged.costMicros = 0;
  expect((await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: value }))).summary).toMatchObject({ tokens: null, knownTokens: '2' });
  const input = suite(); input.cases.push({ ...input.cases[0]!, id: 'second' }); const large = run(); large.charged.costMicros = Number.MAX_SAFE_INTEGER; large.spans[0]!.charged.costMicros = Number.MAX_SAFE_INTEGER; large.spans[0]!.usage.costMicros = Number.MAX_SAFE_INTEGER;
  expect((await runAgentEvaluations(input, async () => ({ currency: 'CNY', run: large }))).summary.costMicros).toBe((2n * BigInt(Number.MAX_SAFE_INTEGER)).toString());
});
it.each([false, true])('does not accept token totals that contradict a model receipt (partial: %s)', async partial => {
  const value = run(); value.charged = { tokens: 6, costMicros: 0 }; value.spans[0]!.charged = { ...value.charged }; value.spans[0]!.usage = { ...value.charged };
  value.spans[0]!.modelCall = { tenantId: 'tenant', connectionId: 'connection', modeDigest: 'a'.repeat(64), modelIdentity: 'synthetic/model', evidence: 'synthetic_replay', callId: 'call', providerRequestId: 'fixture-call', inputDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64), usage: { inputTokens: 2, outputTokens: partial ? null : 3 } };
  expect((await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: value }))).cases[0]!.errorCode).toBe('AGENT_EVAL_RESULT_INVALID');
});
it('refuses live-model or uncertain external evidence in a synthetic-only evaluation suite', async () => {
  const value = run(); value.spans[0]!.outcome = 'unknown'; expect((await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: value }))).cases[0]!.errorCode).toBe('AGENT_EVAL_RESULT_INVALID');
  value.spans[0]!.outcome = 'completed'; value.spans[0]!.modelCall = { tenantId: 'tenant', connectionId: 'connection', modeDigest: 'a'.repeat(64), modelIdentity: 'live/model', evidence: 'live_model', callId: 'call', providerRequestId: 'fixture-call', inputDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64), usage: { inputTokens: 2, outputTokens: 1 } };
  expect((await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: value }))).passed).toBe(false);
});
it('does not turn a passing expected refusal into a completed candidate task', async () => {
  const input = suite(); input.cases[0]!.expected = { state: 'blocked', reason: 'BUDGET_LIMIT', outputDigest: digest(null), reviewState: 'none' };
  const report = await runAgentEvaluations(input, async () => ({ currency: 'CNY', run: { ...run(), state: 'blocked', reason: 'BUDGET_LIMIT', output: null } }));
  expect(report.passed).toBe(true); expect(report.summary.completion).toEqual({ completed: 0, total: 1, unknown: 0 });
});
it('records failed assertions and safe execution failures without losing subsequent cases or inventing zero spend', async () => {
  const input = suite(); input.cases.push({ ...input.cases[0]!, id: 'throws' }, { ...input.cases[0]!, id: 'last' });
  const report = await runAgentEvaluations(input, async id => { if (id === 'throws') throw new Error('postgres://secret:password@host'); return { currency: 'CNY', run: id === 'candidate' ? { ...run(), output: { text: 'wrong' } } : run() }; });
  expect(report.passed).toBe(false); expect(report.cases).toHaveLength(3); expect(report.cases[0]!.failures).toContain('output'); expect(report.cases[1]!.errorCode).toBe('AGENT_EVAL_EXECUTION_FAILED'); expect(report.cases[2]!.passed).toBe(true);
  expect(report.summary).toMatchObject({ completion: { completed: 1, total: 3, unknown: 1 }, costMicros: null, chargedCostMicros: null }); expect(JSON.stringify(report)).not.toContain('password');
});
it.each(['steps', 'charged', 'unknown', 'reason', 'currency', 'duplicate-spans'] as const)('rejects inconsistent execution evidence instead of counting it as success: %s', kind => {
  const value = run(); if (kind === 'steps') value.steps = 2; if (kind === 'charged') value.charged.tokens = 4; if (kind === 'unknown') value.usageUnknown = true; if (kind === 'reason') value.reason = 'BUDGET_LIMIT'; if (kind === 'duplicate-spans') { value.spans.push(structuredClone(value.spans[0]!)); value.steps = 2; value.charged = { tokens: 6, costMicros: 8 }; }
  return runAgentEvaluations(suite(), async () => ({ currency: kind === 'currency' ? 'USD' : 'CNY', run: value })).then(report => { expect(report.passed).toBe(false); expect(report.cases[0]!.errorCode).toBe('AGENT_EVAL_RESULT_INVALID'); expect(report.summary.completion.unknown).toBe(1); });
});
it('rejects baseline metric/trace regressions, changed oracles and corrupted reports', async () => {
  const first = await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: run() }));
  const changed = await runAgentEvaluations(suite(), async () => ({ currency: 'CNY', run: { ...run(), spans: [{ ...run().spans[0]!, inputDigest: 'f'.repeat(64) }] } }));
  expect(() => assertAgentEvaluationBaseline(changed, first)).toThrow('AGENT_BASELINE_REGRESSION');
  const input = suite(); input.version = '1.0.1'; const different = await runAgentEvaluations(input, async () => ({ currency: 'CNY', run: run() })); expect(() => assertAgentEvaluationBaseline(different, first)).toThrow('AGENT_BASELINE_REGRESSION');
  expect(() => validateAgentEvaluationReport({ ...first, summary: { ...first.summary, decisionCycles: '999' } })).toThrow('INVALID_AGENT_EVAL_REPORT');
  expect(() => assertAgentEvaluationBaseline(first, { ...first, passed: false })).toThrow('INVALID_AGENT_EVAL_REPORT');
});
it('captures suite declarations before an asynchronous executor can mutate them', async () => {
  const input = suite(); const report = await runAgentEvaluations(input, async () => { input.cases[0]!.expected.outputDigest = digest({ text: 'changed' }); return { currency: 'CNY', run: run() }; }); expect(report.passed).toBe(true);
});
it('rejects malformed, empty and duplicate case declarations before executing', async () => {
  for (const input of [{ ...suite(), cases: [] }, { ...suite(), evidence: 'live_model' }, { ...suite(), cases: [suite().cases[0]!, suite().cases[0]!] }, { ...suite(), cases: [{ id: 'case', expected: { ...suite().cases[0]!.expected, state: 'blocked', reason: null } }] }]) await expect(runAgentEvaluations(input as AgentEvaluationSuite, async () => { throw new Error('must not execute'); })).rejects.toThrow('INVALID_AGENT_EVAL_SUITE');
});

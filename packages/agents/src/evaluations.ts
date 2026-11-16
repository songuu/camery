import { z } from 'zod';
import { canonical, digest, freeze, jsonCopy, Pin } from '@camery/methods';
import { AgentError, Name } from './registry.js';
import { AgentRunReportSchema } from './runtime.js';
import type { AgentRunReport } from './runtime.js';
import { validateReviewLoop } from './review-loop.js';
import type { ReviewLoop } from './review-loop.js';
import { meterModelUsage } from './metering.js';

const count = z.int().min(0).max(100000); const integer = z.string().regex(/^(0|[1-9]\d*)$/).max(100);
const reviewState = z.enum(['none', 'awaiting_review', 'revision_required', 'reviewed_candidate', 'needs_human']);
const Expected = z.strictObject({ state: z.enum(['candidate', 'blocked']), reason: z.string().regex(/^[A-Z_]{1,64}$/).nullable(), outputDigest: Pin.shape.digest, reviewState });
const Suite = z.strictObject({ id: Name, version: z.string().regex(/^\d+\.\d+\.\d+$/), currency: z.string().regex(/^[A-Z]{3}$/), evidence: z.literal('synthetic_contract'), cases: z.array(z.strictObject({ id: Name, expected: Expected })).min(1).max(100) });
export type AgentEvaluationSuite = z.infer<typeof Suite>;
export interface AgentEvaluationResult { currency: string; run: AgentRunReport; review?: ReviewLoop }
const Observed = z.strictObject({ agent: Pin, state: z.enum(['candidate', 'blocked']), reason: Expected.shape.reason, outputDigest: Pin.shape.digest,
  steps: count, decisionCycles: count, toolCalls: count, questions: count, reviewRounds: z.int().min(0).max(2), reviewState,
  taskCompleted: z.boolean(), humanEscalated: z.boolean(), humanAssisted: z.boolean(),
  tokens: integer.nullable(), costMicros: integer.nullable(), knownTokens: integer, knownCostMicros: integer, chargedTokens: integer, chargedCostMicros: integer, traceDigest: Pin.shape.digest });
type Observation = z.infer<typeof Observed>;
const Failure = z.enum(['state', 'reason', 'output', 'review', 'execution']);
const Case = z.strictObject({ id: Name, passed: z.boolean(), failures: z.array(Failure).max(5), observed: Observed.nullable(), errorCode: z.enum(['AGENT_EVAL_EXECUTION_FAILED', 'AGENT_EVAL_RESULT_INVALID']).nullable() });
type CaseResult = z.infer<typeof Case>;
const Summary = z.strictObject({ completion: z.strictObject({ completed: count, total: count, unknown: count }), humanEscalation: z.strictObject({ escalated: count, total: count, unknown: count }), humanAssistance: z.strictObject({ assisted: count, total: count, unknown: count }),
  decisionCycles: integer, toolCalls: integer, questions: integer, reviewRounds: integer, measuredCases: count, tokens: integer.nullable(), costMicros: integer.nullable(), knownTokens: integer, knownCostMicros: integer, chargedTokens: integer.nullable(), chargedCostMicros: integer.nullable() });
const Report = z.strictObject({ version: z.literal(1), suite: Suite, contractDigest: Pin.shape.digest, passed: z.boolean(), cases: z.array(Case).min(1).max(100), summary: Summary, reportDigest: Pin.shape.digest });
export type AgentEvaluationReport = z.infer<typeof Report>;
function data<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  try { const result = schema.safeParse(jsonCopy(input)); if (result.success) return freeze(result.data) as T; } catch { /* Diagnostics must not contain source, output or executor credentials. */ }
  throw new AgentError(code);
}
function suiteData(input: unknown): AgentEvaluationSuite {
  const value = data(Suite, input, 'INVALID_AGENT_EVAL_SUITE');
  if (new Set(value.cases.map(item => item.id)).size !== value.cases.length || value.cases.some(item => (item.expected.state === 'candidate') !== (item.expected.reason === null))) throw new AgentError('INVALID_AGENT_EVAL_SUITE');
  return value;
}
function failures(expected: z.infer<typeof Expected>, observed: Observation): z.infer<typeof Failure>[] {
  const output: z.infer<typeof Failure>[] = [];
  if (expected.state !== observed.state) output.push('state'); if (expected.reason !== observed.reason) output.push('reason');
  if (expected.outputDigest !== observed.outputDigest) output.push('output'); if (expected.reviewState !== observed.reviewState) output.push('review'); return output;
}
function observe(input: AgentEvaluationResult, currency: string): Observation {
  const captured = data(z.strictObject({ currency: z.string(), run: AgentRunReportSchema, review: z.unknown().optional() }), input, 'AGENT_EVAL_RESULT_INVALID');
  const run = captured.run;
  if (captured.currency !== currency || run.steps !== run.spans.length || new Set(run.spans.map(span => span.id)).size !== run.steps || (run.state === 'candidate') !== (run.reason === null) || (run.state === 'blocked' && run.output !== null)) throw new AgentError('AGENT_EVAL_RESULT_INVALID');
  let chargedTokens = 0n; let chargedCost = 0n; let knownTokens = 0n; let knownCost = 0n; let tokensUnknown = false; let costUnknown = false;
  for (const span of run.spans) {
    if (span.modelCall?.evidence === 'live_model' || span.outcome === 'unknown') throw new AgentError('AGENT_EVAL_RESULT_INVALID');
    if (span.modelCall && (span.kind !== 'decision' || canonical(meterModelUsage(span.modelCall.usage, undefined, false).usage) !== canonical(span.usage))) throw new AgentError('AGENT_EVAL_RESULT_INVALID');
    const partialTokens = span.modelCall ? BigInt(span.modelCall.usage.inputTokens ?? 0) + BigInt(span.modelCall.usage.outputTokens ?? 0) : 0n;
    if ((span.usage.tokens !== null && span.usage.tokens !== span.charged.tokens) || (span.usage.costMicros !== null && span.usage.costMicros !== span.charged.costMicros) || BigInt(span.charged.tokens) < partialTokens) throw new AgentError('AGENT_EVAL_RESULT_INVALID');
    chargedTokens += BigInt(span.charged.tokens); chargedCost += BigInt(span.charged.costMicros);
    knownTokens += span.usage.tokens === null ? partialTokens : BigInt(span.usage.tokens); knownCost += BigInt(span.usage.costMicros ?? 0);
    tokensUnknown ||= span.usage.tokens === null; costUnknown ||= span.usage.costMicros === null;
  }
  if (chargedTokens !== BigInt(run.charged.tokens) || chargedCost !== BigInt(run.charged.costMicros) || run.usageUnknown !== (tokensUnknown || costUnknown)) throw new AgentError('AGENT_EVAL_RESULT_INVALID');
  let review: ReviewLoop | undefined;
  if (captured.review !== undefined) {
    const identity = data(z.object({ loopDigest: Pin.shape.digest }).passthrough(), captured.review, 'AGENT_EVAL_RESULT_INVALID'); review = validateReviewLoop(captured.review, identity.loopDigest);
    if (run.state !== 'candidate' || canonical(review.producer.agent) !== canonical(run.agent) || (review.rounds[0]?.candidateDigest ?? review.candidateDigest) !== digest(run.output)) throw new AgentError('AGENT_EVAL_RESULT_INVALID');
  }
  const state = review?.state ?? 'none'; const escalated = state === 'needs_human'; const questions = run.spans.filter(span => span.kind === 'question').length;
  return data(Observed, { agent: run.agent, state: run.state, reason: run.reason, outputDigest: digest(run.output), steps: run.steps, decisionCycles: run.spans.filter(span => span.kind === 'decision').length, toolCalls: run.spans.filter(span => span.kind === 'tool').length, questions,
    reviewRounds: review?.rounds.length ?? 0, reviewState: state, taskCompleted: run.state === 'candidate' && (state === 'none' || state === 'reviewed_candidate'), humanEscalated: escalated, humanAssisted: escalated || questions > 0,
    tokens: tokensUnknown ? null : knownTokens.toString(), costMicros: costUnknown ? null : knownCost.toString(), knownTokens: knownTokens.toString(), knownCostMicros: knownCost.toString(), chargedTokens: chargedTokens.toString(), chargedCostMicros: chargedCost.toString(), traceDigest: digest({ run, ...(review ? { review } : {}) }) }, 'AGENT_EVAL_RESULT_INVALID');
}
function seal(suite: AgentEvaluationSuite, cases: CaseResult[]): AgentEvaluationReport {
  const measured = cases.flatMap(item => item.observed ? [item.observed] : []); const unknown = cases.length - measured.length;
  const sum = (key: 'decisionCycles' | 'toolCalls' | 'questions' | 'reviewRounds' | 'knownTokens' | 'knownCostMicros' | 'chargedTokens' | 'chargedCostMicros'): string => measured.reduce((total, item) => total + BigInt(item[key]), 0n).toString();
  const summary = { completion: { completed: measured.filter(item => item.taskCompleted).length, total: cases.length, unknown }, humanEscalation: { escalated: measured.filter(item => item.humanEscalated).length, total: cases.length, unknown }, humanAssistance: { assisted: measured.filter(item => item.humanAssisted).length, total: cases.length, unknown },
    decisionCycles: sum('decisionCycles'), toolCalls: sum('toolCalls'), questions: sum('questions'), reviewRounds: sum('reviewRounds'), measuredCases: measured.length,
    tokens: unknown || measured.some(item => item.tokens === null) ? null : sum('knownTokens'), costMicros: unknown || measured.some(item => item.costMicros === null) ? null : sum('knownCostMicros'), knownTokens: sum('knownTokens'), knownCostMicros: sum('knownCostMicros'), chargedTokens: unknown ? null : sum('chargedTokens'), chargedCostMicros: unknown ? null : sum('chargedCostMicros') };
  const body = { version: 1 as const, suite, contractDigest: digest(suite), passed: cases.every(item => item.passed), cases, summary };
  return freeze({ ...body, reportDigest: digest(body) });
}
/** Executes trusted, bounded fixtures once each. Success assertions and business completion have distinct denominators. */
export async function runAgentEvaluations(input: AgentEvaluationSuite, execute: (caseId: string) => Promise<AgentEvaluationResult>): Promise<AgentEvaluationReport> {
  const suite = suiteData(input); if (typeof execute !== 'function') throw new AgentError('INVALID_AGENT_EVAL_SUITE'); const cases: CaseResult[] = [];
  for (const item of suite.cases) {
    let result: AgentEvaluationResult;
    try { result = await execute(item.id); } catch { cases.push({ id: item.id, passed: false, failures: ['execution'], observed: null, errorCode: 'AGENT_EVAL_EXECUTION_FAILED' }); continue; }
    try { const measured = observe(result, suite.currency); const failed = failures(item.expected, measured); const observed = freeze({ ...measured, taskCompleted: measured.taskCompleted && failed.length === 0 }); cases.push({ id: item.id, passed: failed.length === 0, failures: failed, observed, errorCode: null }); }
    catch { cases.push({ id: item.id, passed: false, failures: ['execution'], observed: null, errorCode: 'AGENT_EVAL_RESULT_INVALID' }); }
  }
  return seal(suite, cases);
}
export function validateAgentEvaluationReport(input: unknown): AgentEvaluationReport {
  const value = data(Report, input, 'INVALID_AGENT_EVAL_REPORT');
  try {
    const suite = suiteData(value.suite);
    if (value.cases.length !== suite.cases.length || value.cases.some((item, index) => {
      if (item.id !== suite.cases[index]!.id) return true;
      const expected = item.observed ? failures(suite.cases[index]!.expected, item.observed) : ['execution'];
      if (item.observed) {
        const observed = item.observed; const completed = expected.length === 0 && observed.state === 'candidate' && ['none', 'reviewed_candidate'].includes(observed.reviewState);
        if (observed.taskCompleted !== completed || observed.humanEscalated !== (observed.reviewState === 'needs_human') || observed.humanAssisted !== (observed.humanEscalated || observed.questions > 0) || observed.steps !== observed.decisionCycles + observed.toolCalls + observed.questions
          || (observed.state === 'candidate') !== (observed.reason === null) || (observed.tokens !== null && observed.tokens !== observed.knownTokens) || (observed.costMicros !== null && observed.costMicros !== observed.knownCostMicros) || BigInt(observed.knownTokens) > BigInt(observed.chargedTokens) || BigInt(observed.knownCostMicros) > BigInt(observed.chargedCostMicros)) return true;
      }
      return canonical(item.failures) !== canonical(expected) || item.passed !== (item.observed !== null && expected.length === 0) || (item.observed === null) !== (item.errorCode !== null);
    }) || canonical(seal(suite, value.cases)) !== canonical(value)) throw new Error();
    return value;
  } catch { throw new AgentError('INVALID_AGENT_EVAL_REPORT'); }
}
/** Exact deterministic baseline includes suite/oracles, counters, accounting and redacted trace digests. */
export function assertAgentEvaluationBaseline(current: AgentEvaluationReport, prior: unknown): void {
  const observed = validateAgentEvaluationReport(current); const baseline = validateAgentEvaluationReport(prior);
  if (!observed.passed || !baseline.passed || canonical(observed) !== canonical(baseline)) throw new AgentError('AGENT_BASELINE_REGRESSION');
}

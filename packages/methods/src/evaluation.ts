import { z } from 'zod';
import { ModelError } from '@camery/model-modes';
import type { CallContext, Json, Outcome } from '@camery/model-modes';
import { canonical, captureContext, digest, jsonCopy, MethodError } from './data.js';
import { Pin } from './schema.js';
import type { MethodPin } from './schema.js';
import type { MethodRegistry } from './registry.js';
import type { MethodExecution, MethodRunner } from './runner.js';
import { validateMethodRules } from './rules.js';
import { ModelReceiptSchema } from './model-call.js';

const id = z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const Category = z.enum(['process', 'content', 'structure', 'quality']);
type Category = z.infer<typeof Category>;
const ReviewEvidence = z.enum(['live_model', 'synthetic_replay', 'human_record']);
const Assertion = z.discriminatedUnion('kind', [
  z.strictObject({ id, category: z.literal('process'), kind: z.literal('required_tool'), tool: id }),
  z.strictObject({ id, category: z.literal('process'), kind: z.literal('offline') }),
  z.strictObject({ id, category: z.literal('content'), kind: z.literal('path_equals'), pointer: z.string().max(1000).refine(value => (value === '' || value.startsWith('/')) && !/~(?![01])/u.test(value)), expected: z.json() }),
  z.strictObject({ id, category: z.literal('structure'), kind: z.literal('output_valid') }),
  z.strictObject({ id, category: z.literal('quality'), kind: z.literal('boundary_f1'), expectedStarts: z.array(z.int().min(0)).min(1).max(10000).refine(value => new Set(value).size === value.length), minimum: z.number().min(0).max(1) }),
  z.strictObject({ id, category: z.literal('quality'), kind: z.literal('review_score'), metric: id, reviewer: z.enum(['llm', 'human']), minimum: z.number().min(1).max(5), requiredEvidence: ReviewEvidence.optional(), rubricDigest: hash.optional() }),
]);
const Suite = z.strictObject({ id, version: Pin.shape.version, cases: z.array(z.strictObject({ id, input: z.json(), assertions: z.array(Assertion).min(1).max(100) })).min(1).max(100) });
export type EvaluationSuite = z.infer<typeof Suite>;
// oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
const identity = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const Rating = z.strictObject({ caseId: id, metric: id, source: z.enum(['llm', 'human']), reviewerId: z.string().min(1).max(200), recordId: z.string().min(1).max(200), methodDigest: hash, outputDigest: hash, score: z.number().min(1).max(5),
  tenantId: identity.optional(), evidence: ReviewEvidence.optional(), rubricDigest: hash.optional(), inputDigest: hash.optional(), producerModeDigest: hash.optional(), producerModelIdentity: identity.optional(), reviewerModeDigest: hash.optional(), reviewerModelIdentity: identity.optional(),
}).refine(value => {
  if ([value.evidence, value.rubricDigest, value.inputDigest, value.producerModeDigest, value.producerModelIdentity, value.reviewerModeDigest, value.reviewerModelIdentity].every(item => item === undefined)) return true;
  if (!value.evidence || !value.tenantId || !value.rubricDigest || !value.inputDigest || !value.producerModeDigest || !value.producerModelIdentity) return false;
  return value.evidence === 'human_record' ? value.source === 'human' && value.reviewerModeDigest === undefined && value.reviewerModelIdentity === undefined
    : value.source === 'llm' && value.reviewerModeDigest !== undefined && value.reviewerModelIdentity !== undefined && value.reviewerModeDigest !== value.producerModeDigest && value.reviewerModelIdentity !== value.producerModelIdentity;
});
export type ReviewRating = z.infer<typeof Rating>;
const Result = z.strictObject({ id, category: Category, status: z.enum(['passed', 'failed', 'unscored']), score: z.number().min(0).max(1).nullable(), evidence: z.enum(['deterministic', 'llm', 'human']), reviewRecordId: z.string().nullable(), provenance: ReviewEvidence.optional() });
const Artifact = z.strictObject({ output: z.json(), trace: z.array(z.strictObject({ tool: id, effect: z.enum(['read', 'paid']), network: z.boolean(), evidence: z.enum(['deterministic', 'synthetic_replay', 'live_model']), status: z.literal('completed'), modelCall: ModelReceiptSchema.optional() })).length(1) });
const Report = z.strictObject({
  version: z.literal(2), suite: z.strictObject({ id, version: Pin.shape.version, digest: hash }), subject: z.strictObject({ tenantId: identity, connectionId: identity, method: Pin, modeDigest: hash }),
  reviews: z.array(Rating).max(10000),
  state: z.enum(['passed', 'failed', 'incomplete']), cases: z.array(z.strictObject({ id, inputDigest: hash, outputDigest: hash.nullable(), artifact: Artifact.nullable(), error: z.string().regex(/^[A-Z_]{1,64}$/).nullable(), errorOutcome: z.enum(['not_sent', 'unknown', 'rejected', 'completed', 'not_applicable']).optional(), assertions: z.array(Result).max(100) })).min(1).max(100),
});
export type EvaluationReport = z.infer<typeof Report>;
type AssertionResult = z.infer<typeof Result>;
export function validateEvaluationReport(input: unknown): EvaluationReport {
  const parsed = Report.safeParse(jsonCopy(input));
  if (!parsed.success) throw new MethodError('INVALID_REPORT', 'method evaluation report');
  return parsed.data;
}

export function validateEvaluationSuite(input: unknown): EvaluationSuite {
  const result = Suite.safeParse(jsonCopy(input));
  if (!result.success || new Set(result.data.cases.map(value => value.id)).size !== result.data.cases.length || result.data.cases.some(value => new Set(value.assertions.map(assertion => assertion.id)).size !== value.assertions.length)) throw new MethodError('INVALID_SUITE', 'method evaluation');
  return result.data;
}
function pointer(value: Json, path: string): Json | undefined {
  if (path === '') return value;
  let current: Json | undefined = value;
  for (const segment of path.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key) || (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key))) return undefined;
    current = Array.isArray(current) ? current[Number(key)] : current[key];
  }
  return current;
}
function boundaryScore(output: Json, expected: number[]): number {
  const chapters = pointer(output, '/chapters');
  if (!Array.isArray(chapters)) return 0;
  const starts = chapters.filter(value => value !== null && typeof value === 'object' && !Array.isArray(value) && value['kind'] === 'chapter').map(value => (value as Record<string, Json>)['start']);
  if (starts.some(value => typeof value !== 'number' || !Number.isSafeInteger(value)) || new Set(starts).size !== starts.length || !starts.length) return 0;
  const correct = starts.filter(value => expected.includes(value as number)).length;
  return 2 * correct / (starts.length + expected.length);
}
function reportState(cases: EvaluationReport['cases']): EvaluationReport['state'] {
  if (cases.some(value => value.error || value.assertions.some(assertion => assertion.status === 'failed'))) return 'failed';
  return cases.some(value => value.assertions.some(assertion => assertion.status === 'unscored')) ? 'incomplete' : 'passed';
}
function floor(assertion: z.infer<typeof Assertion>): number { return assertion.kind === 'boundary_f1' ? assertion.minimum : assertion.kind === 'review_score' ? (assertion.minimum - 1) / 4 : 1; }
function unscored(example: EvaluationSuite['cases'][number]): AssertionResult[] {
  return example.assertions.map(assertion => ({ id: assertion.id, category: assertion.category, status: 'unscored', score: null, evidence: assertion.kind === 'review_score' ? assertion.reviewer : 'deterministic', reviewRecordId: null }));
}
function validateReviews(suite: EvaluationSuite, pin: MethodPin, ratings: ReviewRating[], modeDigest: string, tenantId: string): void {
  const keys = ratings.map(rating => `${rating.caseId}/${rating.metric}/${rating.source}`);
  if (new Set(keys).size !== keys.length || ratings.some(rating => rating.methodDigest !== pin.digest || !suite.cases.some(value => value.id === rating.caseId && value.assertions.some(assertion => assertion.kind === 'review_score' && assertion.metric === rating.metric && assertion.reviewer === rating.source)))) throw new MethodError('INVALID_REVIEW', 'method evaluation review identity');
  for (const rating of ratings) {
    const example = suite.cases.find(value => value.id === rating.caseId)!;
    if (rating.tenantId !== undefined && rating.tenantId !== tenantId) throw new MethodError('INVALID_REVIEW', 'method evaluation review tenant');
    if (rating.evidence && (rating.inputDigest !== digest(example.input) || rating.producerModeDigest !== modeDigest)) throw new MethodError('INVALID_REVIEW', 'method evaluation source binding');
    if (example.assertions.some(assertion => assertion.kind === 'review_score' && assertion.metric === rating.metric && assertion.reviewer === rating.source && assertion.requiredEvidence !== undefined && assertion.requiredEvidence !== rating.evidence)) throw new MethodError('INVALID_REVIEW', 'method evaluation required evidence');
    if (example.assertions.some(assertion => assertion.kind === 'review_score' && assertion.metric === rating.metric && assertion.reviewer === rating.source && assertion.rubricDigest !== undefined && assertion.rubricDigest !== rating.rubricDigest)) throw new MethodError('INVALID_REVIEW', 'method evaluation required rubric');
  }
}
function scoreAssertions(registry: MethodRegistry, pin: MethodPin, example: EvaluationSuite['cases'][number], execution: z.infer<typeof Artifact>, ratings: ReviewRating[]): AssertionResult[] {
  const outputDigest = digest(execution.output);
  return example.assertions.map(assertion => {
    let score: number | null; let reviewRecordId: string | null = null; let provenance: ReviewRating['evidence'];
    switch (assertion.kind) {
      case 'required_tool': score = Number(execution.trace.some(event => event.tool === assertion.tool && event.status === 'completed')); break;
      case 'offline': score = Number(execution.trace.every(event => !event.network)); break;
      case 'path_equals': { const actual = pointer(execution.output, assertion.pointer); score = Number(actual !== undefined && canonical(actual) === canonical(assertion.expected)); break; }
      case 'output_valid': score = Number(registry.validateOutput(pin, execution.output)); break;
      case 'boundary_f1': score = boundaryScore(execution.output, assertion.expectedStarts); break;
      case 'review_score': {
        const rating = ratings.find(value => value.caseId === example.id && value.metric === assertion.metric && value.source === assertion.reviewer);
        if (rating && rating.outputDigest !== outputDigest) throw new MethodError('INVALID_REVIEW', 'method evaluation stale output');
        if (rating?.evidence && execution.trace[0]?.modelCall && rating.producerModelIdentity !== execution.trace[0].modelCall.modelIdentity) throw new MethodError('INVALID_REVIEW', 'method evaluation producer identity');
        score = rating ? (rating.score - 1) / 4 : null; reviewRecordId = rating?.recordId ?? null; break;
      }
    }
    if (assertion.kind === 'review_score') provenance = ratings.find(value => value.caseId === example.id && value.metric === assertion.metric && value.source === assertion.reviewer)?.evidence;
    return { id: assertion.id, category: assertion.category, status: score === null ? 'unscored' : score >= floor(assertion) ? 'passed' : 'failed', score, evidence: assertion.kind === 'review_score' ? assertion.reviewer : 'deterministic', reviewRecordId, ...(provenance ? { provenance } : {}) };
  });
}

/** Uses executable method results. Human/LLM scores are explicit, artifact-bound host records, never synthesized. */
export async function evaluateSuite(registry: MethodRegistry, runner: MethodRunner, input: EvaluationSuite, suppliedPin: MethodPin, original: CallContext, reviews: readonly ReviewRating[] = []): Promise<EvaluationReport> {
  const suite = validateEvaluationSuite(input); const pin = jsonCopy(suppliedPin); registry.resolve(pin);
  const context = captureContext(original, 'method evaluation');
  const parsedReviews = z.array(Rating).max(10000).safeParse(jsonCopy(reviews));
  if (!parsedReviews.success) throw new MethodError('INVALID_REVIEW', 'method evaluation review');
  const ratings = parsedReviews.data;
  validateReviews(suite, pin, ratings, context.modeDigest, context.tenantId);
  const cases: EvaluationReport['cases'] = []; const suiteDigest = digest(suite);
  let observedOutcome: Outcome = 'not_applicable';
  const observe = (outcome: Outcome): void => {
    const order: Outcome[] = ['not_applicable', 'not_sent', 'rejected', 'completed', 'unknown'];
    if (order.indexOf(outcome) > order.indexOf(observedOutcome)) observedOutcome = outcome;
  };
  try {
    for (const example of suite.cases) {
      if (context.signal.aborted) throw new MethodError('ABORTED', 'method evaluation', observedOutcome);
      let execution: MethodExecution;
      try { execution = await runner.run(pin, example.input, { ...context, idempotencyKey: digest({ parent: context.idempotencyKey, suite: suiteDigest, method: pin.digest, case: example.id }) }); }
      catch (error) {
        const errorOutcome = error instanceof MethodError || error instanceof ModelError ? error.outcome : 'unknown'; observe(errorOutcome);
        if (context.signal.aborted) throw new MethodError('ABORTED', 'method evaluation', observedOutcome);
        cases.push({ id: example.id, inputDigest: digest(example.input), outputDigest: null, artifact: null, error: error instanceof MethodError ? error.code : 'EXECUTION_FAILED', errorOutcome, assertions: unscored(example) });
        continue;
      }
      if (execution.trace.some(value => value.effect === 'paid')) observe('completed');
      const artifact = jsonCopy({ output: execution.output, trace: execution.trace });
      cases.push({ id: example.id, inputDigest: digest(example.input), outputDigest: digest(execution.output), artifact, error: null, assertions: scoreAssertions(registry, pin, example, artifact, ratings) });
    }
    if (ratings.some(rating => !cases.some(value => value.id === rating.caseId && value.outputDigest === rating.outputDigest))) throw new MethodError('INVALID_REVIEW', 'method evaluation missing output');
    return Report.parse(jsonCopy({ version: 2, suite: { id: suite.id, version: suite.version, digest: suiteDigest }, subject: { tenantId: context.tenantId, connectionId: context.connectionId, method: pin, modeDigest: context.modeDigest }, reviews: ratings, state: reportState(cases), cases }));
  } catch (error) {
    if (error instanceof MethodError || error instanceof ModelError) {
      observe(error.outcome);
      throw new MethodError(error.code, error instanceof MethodError ? error.operation : 'method evaluation', observedOutcome);
    }
    throw new MethodError('EVALUATION_FAILED', 'method evaluation result', observedOutcome);
  }
}

function checkedReport(registry: MethodRegistry, suite: EvaluationSuite, input: unknown): EvaluationReport {
  const report = validateEvaluationReport(input);
  const pack = registry.resolve(report.subject.method); validateReviews(suite, report.subject.method, report.reviews, report.subject.modeDigest, report.subject.tenantId);
  if (report.suite.id !== suite.id || report.suite.version !== suite.version || report.suite.digest !== digest(suite) || report.cases.length !== suite.cases.length || new Set(report.cases.map(value => value.id)).size !== report.cases.length || report.state !== reportState(report.cases)) throw new MethodError('INVALID_REPORT', 'evaluation gate suite');
  for (const example of suite.cases) {
    const result = report.cases.find(value => value.id === example.id);
    if (!result || result.inputDigest !== digest(example.input) || result.assertions.length !== example.assertions.length || new Set(result.assertions.map(value => value.id)).size !== result.assertions.length || (result.error === null) !== (result.outputDigest !== null)) throw new MethodError('INVALID_REPORT', 'evaluation gate case');
    if (result.error !== null) {
      if (result.artifact !== null || canonical(result.assertions) !== canonical(unscored(example))) throw new MethodError('INVALID_REPORT', 'evaluation gate failed case');
    } else {
      const artifact = result.artifact;
      if (!artifact || result.errorOutcome !== undefined || digest(artifact.output) !== result.outputDigest || artifact.trace[0]!.tool !== pack.manifest.tool || !registry.validateOutput(report.subject.method, artifact.output) || !validateMethodRules(pack, example.input, artifact.output) || canonical(result.assertions) !== canonical(scoreAssertions(registry, report.subject.method, example, artifact, report.reviews))) throw new MethodError('INVALID_REPORT', 'evaluation gate evidence');
      const event = artifact.trace[0]!; const model = event.modelCall;
      if ((event.evidence !== 'deterministic' && !model) || (model && (model.tenantId !== report.subject.tenantId || model.connectionId !== report.subject.connectionId || model.modeDigest !== report.subject.modeDigest || model.outputDigest !== result.outputDigest || model.evidence !== event.evidence || event.network !== (model.evidence === 'live_model') || event.effect !== (model.evidence === 'live_model' ? 'paid' : 'read')))) throw new MethodError('INVALID_REPORT', 'evaluation gate model receipt');
    }
    for (const assertion of example.assertions) {
      const value = result.assertions.find(item => item.id === assertion.id);
      if (!value || value.category !== assertion.category || value.evidence !== (assertion.kind === 'review_score' ? assertion.reviewer : 'deterministic') || value.status !== (value.score === null ? 'unscored' : value.score >= floor(assertion) ? 'passed' : 'failed') || (assertion.kind !== 'review_score' && value.reviewRecordId !== null)) throw new MethodError('INVALID_REPORT', 'evaluation gate assertion');
      if (assertion.kind === 'review_score' && ((value.score === null) !== (value.reviewRecordId === null) || value.reviewRecordId === '')) throw new MethodError('INVALID_REPORT', 'evaluation gate review record');
    }
  }
  if (report.reviews.some(rating => !report.cases.some(value => value.id === rating.caseId && value.outputDigest === rating.outputDigest))) throw new MethodError('INVALID_REPORT', 'evaluation gate review output');
  return report;
}
/** Scores retained artifacts after review. No producer, transport or model invocation exists on this path. */
export function updateEvaluationReviews(registry: MethodRegistry, input: EvaluationSuite, prior: EvaluationReport, incoming: readonly ReviewRating[]): EvaluationReport {
  const suite = validateEvaluationSuite(input); const report = checkedReport(registry, suite, prior);
  const parsed = z.array(Rating).max(10000).safeParse(jsonCopy(incoming));
  if (!parsed.success) throw new MethodError('INVALID_REVIEW', 'method evaluation review update');
  const reviews = [...report.reviews, ...parsed.data];
  validateReviews(suite, report.subject.method, reviews, report.subject.modeDigest, report.subject.tenantId);
  const cases = report.cases.map(value => ({ ...value, assertions: value.artifact ? scoreAssertions(registry, report.subject.method, suite.cases.find(example => example.id === value.id)!, value.artifact, reviews) : value.assertions }));
  return checkedReport(registry, suite, { ...report, reviews, cases, state: reportState(cases) });
}
/** Missing/incomparable evidence blocks the gate. Summary flags and caller-provided means are never trusted. */
export function evaluationGate(registry: MethodRegistry, input: EvaluationSuite, before: EvaluationReport, after: EvaluationReport, allowedDrop: Partial<Record<Category, number>> = {}): { allowed: boolean; reasons: string[] } {
  const suite = validateEvaluationSuite(input); const baseline = checkedReport(registry, suite, before); const candidate = checkedReport(registry, suite, after);
  const drops = z.strictObject({ process: z.number().min(0).max(1).optional(), content: z.number().min(0).max(1).optional(), structure: z.number().min(0).max(1).optional(), quality: z.number().min(0).max(1).optional() }).safeParse(jsonCopy(allowedDrop));
  if (!drops.success || baseline.subject.method.id !== candidate.subject.method.id || baseline.subject.tenantId !== candidate.subject.tenantId) throw new MethodError('INVALID_COMPARISON', 'evaluation gate');
  const reasons: string[] = [];
  if (baseline.state !== 'passed') reasons.push('BASELINE_NOT_PASSED');
  if (candidate.state !== 'passed') reasons.push('CANDIDATE_NOT_PASSED');
  for (const example of suite.cases) for (const assertion of example.assertions) {
    if (assertion.kind !== 'review_score') continue;
    const find = (report: EvaluationReport): ReviewRating | undefined => report.reviews.find(value => value.caseId === example.id && value.metric === assertion.metric && value.source === assertion.reviewer);
    const old = find(baseline); const current = find(candidate);
    if (old && current && (old.rubricDigest !== current.rubricDigest || old.evidence !== current.evidence || old.reviewerModeDigest !== current.reviewerModeDigest || old.reviewerModelIdentity !== current.reviewerModelIdentity)) reasons.push('INCOMPARABLE_REVIEW');
  }
  for (const category of Category.options) {
    const old = baseline.cases.flatMap(value => value.assertions).filter(value => value.category === category);
    const current = candidate.cases.flatMap(value => value.assertions).filter(value => value.category === category);
    if (!old.length || old.some(value => value.score === null) || current.some(value => value.score === null)) continue;
    const mean = (values: AssertionResult[]): number => values.reduce((sum, value) => sum + value.score!, 0) / values.length;
    if (mean(old) - mean(current) > (drops.data[category] ?? 0) + 1e-12) reasons.push(`REGRESSION_${category.toUpperCase()}`);
  }
  return { allowed: reasons.length === 0, reasons };
}

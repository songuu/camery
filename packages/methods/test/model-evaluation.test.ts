import { expect, it, vi } from 'vitest';
import type { Json } from '@camery/model-modes';
import { ModelError } from '@camery/model-modes';
import { chapterPack, createStructuredGenerationExecutor, digest, evaluateSuite, evaluationGate, MethodRegistry, MethodRunner, ModelSession, updateEvaluationReviews } from '../src/index.js';
import { createHumanReviewForm, submitHumanReview } from '../src/review.js';
import type { EvaluationSuite, ReviewRating } from '../src/index.js';
const ctx = () => ({ tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), idempotencyKey: 'eval-a', signal: new AbortController().signal });
const suite = (requiredEvidence: 'synthetic_replay' | 'live_model' = 'synthetic_replay'): EvaluationSuite => ({ id: 'model-review', version: '1.0.0', cases: [{ id: 'one', input: { text: 'original source' }, assertions: [{ id: 'quality', category: 'quality', kind: 'review_score', metric: 'faithfulness', reviewer: 'llm', minimum: 3, requiredEvidence }] }] });
function setup() {
  const value: Json = { summary: 'candidate' }; const complete = vi.fn(async () => ({ providerRequestId: 'p1', content: JSON.stringify(value), value, finishReason: 'stop' as const, usage: { inputTokens: null, outputTokens: 2 } }));
  const session = new ModelSession({ complete }, { tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), modelIdentity: 'provider/producer', evidence: 'synthetic_replay', maxCalls: 1, timeoutMs: 1000 });
  const registry = new MethodRegistry(); const pin = registry.register({ ...chapterPack, rules: [], manifest: { ...chapterPack.manifest, tool: 'method.generate', modelTier: 'balanced', outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } } });
  return { registry, pin, complete, runner: new MethodRunner(registry, [createStructuredGenerationExecutor(session)]) };
}
it('applies bound reviews to existing artifacts without making a second generation call', async () => {
  const { registry, pin, runner, complete } = setup(); const data = suite(); const initial = await evaluateSuite(registry, runner, data, pin, ctx());
  expect(initial.state).toBe('incomplete');
  const rating: ReviewRating = { caseId: 'one', metric: 'faithfulness', source: 'llm', reviewerId: 'grader', recordId: 'record-a', methodDigest: pin.digest, outputDigest: initial.cases[0]!.outputDigest!, score: 4,
    tenantId: 'tenant-a', evidence: 'synthetic_replay', rubricDigest: 'c'.repeat(64), inputDigest: digest(data.cases[0]!.input), producerModeDigest: ctx().modeDigest, producerModelIdentity: 'provider/producer', reviewerModeDigest: 'b'.repeat(64), reviewerModelIdentity: 'provider/grader' };
  const report = updateEvaluationReviews(registry, data, initial, [rating]);
  expect(report.state).toBe('passed'); expect(report.cases[0]!.assertions[0]).toMatchObject({ provenance: 'synthetic_replay' }); expect(complete).toHaveBeenCalledOnce();
  expect(report.cases[0]!.artifact).toEqual(initial.cases[0]!.artifact); expect(evaluationGate(registry, data, report, report).allowed).toBe(true);
  expect(() => updateEvaluationReviews(registry, data, report, [rating])).toThrow();
  expect(() => updateEvaluationReviews(registry, { ...data, cases: [{ ...data.cases[0]!, assertions: [{ ...data.cases[0]!.assertions[0]!, requiredEvidence: 'live_model' } as never] }] }, initial, [rating])).toThrow();
});
it('rejects wrong input/producer bindings and synthetic ratings for live-only assertions', async () => {
  const { registry, pin, runner } = setup(); const data = suite('live_model'); const initial = await evaluateSuite(registry, runner, data, pin, ctx());
  const rating: ReviewRating = { caseId: 'one', metric: 'faithfulness', source: 'llm', reviewerId: 'grader', recordId: 'record-a', methodDigest: pin.digest, outputDigest: initial.cases[0]!.outputDigest!, score: 4,
    tenantId: 'tenant-a', evidence: 'synthetic_replay', rubricDigest: 'c'.repeat(64), inputDigest: digest(data.cases[0]!.input), producerModeDigest: ctx().modeDigest, producerModelIdentity: 'provider/producer', reviewerModeDigest: 'b'.repeat(64), reviewerModelIdentity: 'provider/grader' };
  expect(() => updateEvaluationReviews(registry, data, initial, [rating])).toThrow();
  for (const wrong of [{ inputDigest: 'b'.repeat(64) }, { producerModeDigest: 'c'.repeat(64) }, { producerModelIdentity: 'other/producer' }, { reviewerModelIdentity: 'provider/producer' }]) expect(() => updateEvaluationReviews(registry, data, initial, [{ ...rating, evidence: 'live_model', ...wrong }])).toThrow();
});
it('does not compare human scores made under different rubrics', async () => {
  const { registry, pin, runner } = setup(); const data: EvaluationSuite = { ...suite(), cases: [{ ...suite().cases[0]!, assertions: [{ id: 'quality', category: 'quality', kind: 'review_score', metric: 'faithfulness', reviewer: 'human', minimum: 3, requiredEvidence: 'human_record' }] }] };
  const initial = await evaluateSuite(registry, runner, data, pin, ctx());
  const subject = { tenantId: 'tenant-a', caseId: 'one', method: pin, input: data.cases[0]!.input, output: initial.cases[0]!.artifact!.output, producer: { modelIdentity: 'provider/producer', modeDigest: ctx().modeDigest } };
  const rubric = { id: 'quality', version: '1.0.0', metrics: [{ id: 'faithfulness', description: 'strictly faithful', anchors: { one: 'bad', three: 'fair', five: 'excellent' } }] };
  const beforeForm = createHumanReviewForm(registry, subject, rubric); const afterForm = createHumanReviewForm(registry, subject, { ...rubric, version: '1.0.1', metrics: [{ ...rubric.metrics[0]!, description: 'more lenient' }] });
  const before = updateEvaluationReviews(registry, data, initial, submitHumanReview(beforeForm, { reviewerId: 'test-human', scores: [{ metric: 'faithfulness', score: 4, note: 'test strict score' }] }, beforeForm.formDigest).ratings);
  const after = updateEvaluationReviews(registry, data, initial, submitHumanReview(afterForm, { reviewerId: 'test-human', scores: [{ metric: 'faithfulness', score: 5, note: 'test lenient score' }] }, afterForm.formDigest).ratings);
  expect(evaluationGate(registry, data, before, after).allowed).toBe(false);
});
it('keeps evidence-bearing human records scoped to the reviewed tenant', async () => {
  const { registry, pin, runner } = setup(); const data: EvaluationSuite = { ...suite(), cases: [{ ...suite().cases[0]!, assertions: [{ id: 'quality', category: 'quality', kind: 'review_score', metric: 'faithfulness', reviewer: 'human', minimum: 3, requiredEvidence: 'human_record' }] }] };
  const initial = await evaluateSuite(registry, runner, data, pin, ctx()); const subject = { tenantId: 'tenant-a', caseId: 'one', method: pin, input: data.cases[0]!.input, output: initial.cases[0]!.artifact!.output, producer: { modelIdentity: 'provider/producer', modeDigest: ctx().modeDigest } };
  const rubric = { id: 'quality', version: '1.0.0', metrics: [{ id: 'faithfulness', description: 'faithful', anchors: { one: 'bad', three: 'fair', five: 'excellent' } }] };
  const form = createHumanReviewForm(registry, subject, rubric); const ratings = submitHumanReview(form, { reviewerId: 'test-human', scores: [{ metric: 'faithfulness', score: 4, note: 'test record' }] }, form.formDigest).ratings;
  const other = structuredClone(initial); (other.subject as unknown as { tenantId: string }).tenantId = 'tenant-b';
  const event = other.cases[0]!.artifact!.trace[0]!; event.modelCall!.tenantId = 'tenant-b';
  expect(() => updateEvaluationReviews(registry, data, other, ratings)).toThrow();
});
it('preserves unknown paid state when evaluation is cancelled during an active producer', async () => {
  const { registry, pin } = setup(); const controller = new AbortController(); let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const runner = new MethodRunner(registry, [{ id: 'method.generate', effect: 'paid', network: true, evidence: 'deterministic', execute: async () => { started(); return new Promise(() => {}); } }]);
  const pending = evaluateSuite(registry, runner, suite(), pin, { ...ctx(), signal: controller.signal }); const observed = pending.catch(error => error);
  await ready; controller.abort(); expect(await observed).toMatchObject({ code: 'ABORTED', outcome: 'unknown' });
});
it('keeps earlier completed paid work visible when a later case is cancelled before dispatch', async () => {
  const { registry, pin } = setup(); const controller = new AbortController();
  const runner = new MethodRunner(registry, [{ id: 'method.generate', effect: 'paid', network: true, evidence: 'deterministic', execute: async () => ({ summary: 'candidate' }) }]);
  const validate = registry.validateOutput.bind(registry); let checks = 0;
  vi.spyOn(registry, 'validateOutput').mockImplementation((pin, value) => { const valid = validate(pin, value); if (++checks === 2) controller.abort(); return valid; });
  const data: EvaluationSuite = { ...suite(), cases: ['one', 'two'].map(id => ({ id, input: {}, assertions: [{ id: 'shape', category: 'structure', kind: 'output_valid' }] })) };
  await expect(evaluateSuite(registry, runner, data, pin, { ...ctx(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED', outcome: 'completed' });
});
it.each([false, true])('preserves paid state across stale-review postprocessing (earlier unknown: %j)', async unknown => {
  const { registry, pin } = setup(); let calls = 0;
  const session = new ModelSession({ complete: async () => { if (++calls === 1 && unknown) throw new ModelError('NETWORK_FAILED', 'test-only provider', 'unknown'); return { providerRequestId: 'test-response', content: '{"summary":"candidate"}', value: { summary: 'candidate' }, finishReason: 'stop', usage: { inputTokens: null, outputTokens: null } }; } },
    { tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), modelIdentity: 'test-only-provider/producer', evidence: 'live_model', maxCalls: 2, timeoutMs: 1000 });
  const runner = new MethodRunner(registry, [createStructuredGenerationExecutor(session)]);
  const data: EvaluationSuite = { id: 'postprocessing', version: '1.0.0', cases: (unknown ? ['one', 'two'] : ['two']).map(id => ({ id, input: {}, assertions: [{ id: 'quality', category: 'quality', kind: 'review_score', reviewer: 'human', metric: 'faithfulness', minimum: 3 }] })) };
  const rating: ReviewRating = { caseId: 'two', metric: 'faithfulness', source: 'human', reviewerId: 'legacy-test-record', recordId: 'record', methodDigest: pin.digest, outputDigest: 'b'.repeat(64), score: 4 };
  await expect(evaluateSuite(registry, runner, data, pin, ctx(), [rating])).rejects.toMatchObject({ code: 'INVALID_REVIEW', outcome: unknown ? 'unknown' : 'completed' });
  expect(calls).toBe(unknown ? 2 : 1);
});
it('preserves completed paid state if artifact serialization exceeds the report limit', async () => {
  const { registry, pin } = setup();
  const runner = new MethodRunner(registry, [{ id: 'method.generate', effect: 'paid', network: true, evidence: 'deterministic', execute: async () => ({ summary: 'x'.repeat(2_097_120) }) }]);
  await expect(evaluateSuite(registry, runner, suite(), pin, ctx())).rejects.toMatchObject({ code: 'DATA_LIMIT', outcome: 'completed' });
});
it('rejects unscoped report v1 rather than inventing a tenant during review updates', async () => {
  const { registry, pin, runner } = setup(); const data = suite(); const report = await evaluateSuite(registry, runner, data, pin, ctx());
  const prior = { ...report, version: 1, subject: { method: pin, modeDigest: ctx().modeDigest } };
  expect(() => updateEvaluationReviews(registry, data, prior as never, [])).toThrow('INVALID_REPORT');
});
it.each(['tenantId', 'connectionId', 'modeDigest', 'outputDigest'] as const)('rejects a retained artifact whose model receipt has a mismatched %s', async field => {
  const { registry, pin, runner } = setup(); const data = suite(); const report = await evaluateSuite(registry, runner, data, pin, ctx());
  const altered = structuredClone(report); altered.cases[0]!.artifact!.trace[0]!.modelCall![field] = field.endsWith('Digest') ? 'b'.repeat(64) : 'other';
  expect(() => updateEvaluationReviews(registry, data, altered, [])).toThrow('INVALID_REPORT');
});

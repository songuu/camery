import { expect, it } from 'vitest';
import { chapterExecutor, chapterPack, digest, evaluateSuite, evaluationGate, MethodRegistry, MethodRunner } from '../src/index.js';
import type { EvaluationSuite, ReviewRating } from '../src/index.js';
const context = () => ({ tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), idempotencyKey: 'eval-a', signal: new AbortController().signal });
const source = '第一集 开门\n小满捡到一把钥匙。\n第二集 找人\n她询问邻居。\n第三集 回家\n门后的旧钟重新响起。';
const suite: EvaluationSuite = { id: 'chapter-original', version: '1.0.0', cases: [{ id: 'three-episodes', input: { text: source }, assertions: [
  { id: 'tool-called', category: 'process', kind: 'required_tool', tool: 'chapter.segment' },
  { id: 'offline-only', category: 'process', kind: 'offline' },
  { id: 'source-bound', category: 'content', kind: 'path_equals', pointer: '/sourceDigest', expected: digest(source) },
  { id: 'valid-output', category: 'structure', kind: 'output_valid' },
  { id: 'boundary-quality', category: 'quality', kind: 'boundary_f1', expectedStarts: [0, source.indexOf('第二集'), source.indexOf('第三集')], minimum: 1 },
] }] };
const setup = () => { const registry = new MethodRegistry(); const pin = registry.register(chapterPack); return { registry, pin, runner: new MethodRunner(registry, [chapterExecutor]) }; };
it('executes version-bound cases and separates process, content, structure and deterministic quality', async () => {
  const { registry, pin, runner } = setup(); const report = await evaluateSuite(registry, runner, suite, pin, context());
  expect(report.state).toBe('passed'); expect(report.suite.digest).toBe(digest(suite)); expect(report.subject.method).toEqual(pin);
  expect(report.cases[0]?.assertions.map(value => value.category)).toEqual(['process', 'process', 'content', 'structure', 'quality']);
  expect(evaluationGate(registry, suite, report, report).allowed).toBe(true);
});
it('keeps missing human/LLM scores unscored and binds supplied reviews to the exact output', async () => {
  const { registry, pin, runner } = setup(); const reviewed: EvaluationSuite = structuredClone(suite);
  reviewed.cases[0]!.assertions.push({ id: 'human-quality', category: 'quality', kind: 'review_score', metric: 'faithfulness', reviewer: 'human', minimum: 3.5 });
  const first = await evaluateSuite(registry, runner, reviewed, pin, context()); expect(first.state).toBe('incomplete'); expect(evaluationGate(registry, reviewed, first, first).allowed).toBe(false);
  const rating: ReviewRating = { caseId: 'three-episodes', metric: 'faithfulness', source: 'human', reviewerId: 'synthetic-test-reviewer', recordId: 'test-record', methodDigest: pin.digest, outputDigest: first.cases[0]!.outputDigest!, score: 4 };
  const scored = await evaluateSuite(registry, runner, reviewed, pin, context(), [rating]); expect(scored.state).toBe('passed');
  expect(scored.cases[0]?.assertions.at(-1)).toMatchObject({ evidence: 'human', reviewRecordId: 'test-record', score: 0.75 });
  await expect(evaluateSuite(registry, runner, reviewed, pin, context(), [{ ...rating, outputDigest: 'b'.repeat(64) }])).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
});
it('blocks regressions even when both evaluations pass their individual score floor', async () => {
  const { registry, pin, runner } = setup(); const reviewed: EvaluationSuite = structuredClone(suite);
  reviewed.cases[0]!.assertions = [{ id: 'quality', category: 'quality', kind: 'review_score', metric: 'faithfulness', reviewer: 'llm', minimum: 3 }];
  const initial = await evaluateSuite(registry, runner, reviewed, pin, context());
  const rating: ReviewRating = { caseId: 'three-episodes', metric: 'faithfulness', source: 'llm', reviewerId: 'synthetic-test-model', recordId: 'test-record', methodDigest: pin.digest, outputDigest: initial.cases[0]!.outputDigest!, score: 5 };
  const baseline = await evaluateSuite(registry, runner, reviewed, pin, context(), [rating]);
  const candidate = await evaluateSuite(registry, runner, reviewed, pin, context(), [{ ...rating, score: 4 }]);
  expect(candidate.state).toBe('passed'); expect(evaluationGate(registry, reviewed, baseline, candidate, { quality: 0.1 }).allowed).toBe(false);
  expect(evaluationGate(registry, reviewed, baseline, candidate, { quality: 0.25 }).allowed).toBe(true);
});
it('does not accept missing cases, changed assertions or forged summary status', async () => {
  const { registry, pin, runner } = setup(); const report = await evaluateSuite(registry, runner, suite, pin, context());
  expect(() => evaluationGate(registry, { ...suite, version: '1.0.1' }, report, report)).toThrow();
  expect(() => evaluationGate(registry, suite, report, { ...report, cases: [] })).toThrow();
  const forged = structuredClone(report); forged.cases[0]!.assertions[0]!.score = 0;
  expect(() => evaluationGate(registry, suite, report, forged)).toThrow();
});
it('recomputes deterministic assertions when a failed report is forged into a consistent passing summary', async () => {
  const { registry, pin, runner } = setup(); const missingTool: EvaluationSuite = structuredClone(suite);
  missingTool.cases[0]!.assertions = [{ id: 'missing', category: 'process', kind: 'required_tool', tool: 'missing.tool' }];
  const failed = await evaluateSuite(registry, runner, missingTool, pin, context()); expect(failed.state).toBe('failed');
  const forged = structuredClone(failed); forged.state = 'passed'; forged.cases[0]!.assertions[0]!.score = 1; forged.cases[0]!.assertions[0]!.status = 'passed';
  expect(() => evaluationGate(registry, missingTool, forged, forged)).toThrow();
});

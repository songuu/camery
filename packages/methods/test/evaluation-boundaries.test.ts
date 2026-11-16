import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Json } from '@camery/model-modes';
import fixture from './fixtures/original-three-episodes.json';
import { chapterExecutor, chapterPack, digest, evaluateSuite, evaluationGate, MethodError, MethodRegistry, MethodRunner } from '../src/index.js';
import type { EvaluationSuite, ReviewRating } from '../src/index.js';
const context = () => ({ tenantId: 'tenant-a', connectionId: 'connection-a', modeDigest: 'a'.repeat(64), idempotencyKey: 'eval-a', signal: new AbortController().signal });
const base: EvaluationSuite = { id: 'boundaries', version: '1.0.0', cases: [{ id: 'one', input: { text: '第一集 开门\n正文' }, assertions: [{ id: 'tool', category: 'process', kind: 'required_tool', tool: 'chapter.segment' }] }] };
const setup = () => { const registry = new MethodRegistry(); const pin = registry.register(chapterPack); return { registry, pin, runner: new MethodRunner(registry, [chapterExecutor]) }; };
it('executes an explicitly original three-episode golden source with independent title and coverage oracles', async () => {
  const { registry, pin, runner } = setup(); const result = await runner.run(pin, { text: fixture.text }, context());
  expect(result.output).toMatchObject({ sourceDigest: createHash('sha256').update(JSON.stringify(fixture.text)).digest('hex') });
  const output = result.output as { chapters: { title: string; start: number; end: number }[] };
  expect(output.chapters.map(value => value.title)).toEqual(fixture.expectedTitles);
  expect(output.chapters.map(value => fixture.text.slice(value.start, value.end)).join('')).toBe(fixture.text);
  const suite: EvaluationSuite = { ...base, cases: [{ ...base.cases[0]!, input: { text: fixture.text }, assertions: [
    { id: 'offline', category: 'process', kind: 'offline' }, { id: 'structure', category: 'structure', kind: 'output_valid' },
    { id: 'boundaries', category: 'quality', kind: 'boundary_f1', expectedStarts: fixture.expectedTitles.map(title => fixture.text.indexOf(title)), minimum: 1 },
    { id: 'first-title', category: 'content', kind: 'path_equals', pointer: '/chapters/0/title', expected: fixture.expectedTitles[0]! },
  ] }] };
  const report = await evaluateSuite(registry, runner, suite, pin, context()); expect(report.state).toBe('passed'); expect(evaluationGate(registry, suite, report, report).allowed).toBe(true);
});
it('reports execution failure per case, without treating unexecuted assertions as passed', async () => {
  const { registry, pin } = setup(); const runner = new MethodRunner(registry, [{ ...chapterExecutor, execute: async () => { throw new MethodError('INVALID_INPUT', 'synthetic'); } }]);
  const report = await evaluateSuite(registry, runner, base, pin, context());
  expect(report.state).toBe('failed'); expect(report.cases[0]).toMatchObject({ error: 'INVALID_INPUT', outputDigest: null, assertions: [{ status: 'unscored', score: null }] });
  expect(evaluationGate(registry, base, report, report).reasons).toEqual(['BASELINE_NOT_PASSED', 'CANDIDATE_NOT_PASSED']);
});
it('records process and content failures without inventing successful tool calls or network checks', async () => {
  const { registry, pin } = setup(); const runner = new MethodRunner(registry, [{ ...chapterExecutor, network: true }]);
  const suite: EvaluationSuite = { ...base, cases: [{ ...base.cases[0]!, assertions: [
    { id: 'offline', category: 'process', kind: 'offline' }, { id: 'missing-tool', category: 'process', kind: 'required_tool', tool: 'web.search' },
    { id: 'missing-path', category: 'content', kind: 'path_equals', pointer: '/missing', expected: null },
    { id: 'array-property', category: 'content', kind: 'path_equals', pointer: '/chapters/length', expected: 1 },
    { id: 'leading-zero', category: 'content', kind: 'path_equals', pointer: '/chapters/00', expected: {} },
    { id: 'scalar-child', category: 'content', kind: 'path_equals', pointer: '/offsetUnit/child', expected: null },
  ] }] };
  const report = await evaluateSuite(registry, runner, suite, pin, context()); expect(report.state).toBe('failed'); expect(report.cases[0]!.assertions.every(value => value.score === 0)).toBe(true);
});
it('evaluates escaped JSON pointers and complete output equality', async () => {
  const registry = new MethodRegistry(); const output = { 'a/b': { 't~x': 'ok' } };
  const pin = registry.register({ ...chapterPack, rules: [], manifest: { ...chapterPack.manifest, outputSchema: { type: 'object', properties: { 'a/b': { type: 'object', properties: { 't~x': { type: 'string' } }, required: ['t~x'], additionalProperties: false } }, required: ['a/b'], additionalProperties: false } } });
  const runner = new MethodRunner(registry, [{ ...chapterExecutor, execute: async () => output }]);
  const suite: EvaluationSuite = { ...base, cases: [{ ...base.cases[0]!, assertions: [
    { id: 'escaped', category: 'content', kind: 'path_equals', pointer: '/a~1b/t~0x', expected: 'ok' }, { id: 'root', category: 'content', kind: 'path_equals', pointer: '', expected: output },
    { id: 'no-boundary', category: 'quality', kind: 'boundary_f1', expectedStarts: [0], minimum: 1 },
  ] }] };
  const report = await evaluateSuite(registry, runner, suite, pin, context()); expect(report.cases[0]!.assertions.map(value => value.score)).toEqual([1, 1, 0]);
});
it.each([[], [{ kind: 'chapter', start: 'bad' }], [{ kind: 'chapter', start: 0 }, { kind: 'chapter', start: 0 }], [{ kind: 'frontmatter', start: 0 }]].map(chapters => ({ chapters })))('scores invalid boundary evidence as zero: $chapters', async ({ chapters }) => {
  const registry = new MethodRegistry();
  const pin = registry.register({ ...chapterPack, rules: [], manifest: { ...chapterPack.manifest, outputSchema: { type: 'object', properties: { chapters: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, start: { type: typeof chapters[0]?.start === 'number' ? 'integer' : 'string' } }, required: ['kind'], additionalProperties: false } } }, required: ['chapters'], additionalProperties: false } } });
  const runner = new MethodRunner(registry, [{ ...chapterExecutor, execute: async () => ({ chapters }) as Json }]);
  const suite: EvaluationSuite = { ...base, cases: [{ ...base.cases[0]!, assertions: [{ id: 'boundary', category: 'quality', kind: 'boundary_f1', expectedStarts: [0], minimum: 1 }] }] };
  const report = await evaluateSuite(registry, runner, suite, pin, context()); expect(report.cases[0]!.assertions[0]!.score).toBe(0);
});
it('rejects invalid suite identities, review records and context before execution', async () => {
  const { registry, pin, runner } = setup();
  for (const suite of [{ ...base, cases: [] }, { ...base, cases: [base.cases[0], base.cases[0]] }, { ...base, cases: [{ ...base.cases[0], assertions: [base.cases[0]!.assertions[0], base.cases[0]!.assertions[0]] }] }]) await expect(evaluateSuite(registry, runner, suite as EvaluationSuite, pin, context())).rejects.toMatchObject({ code: 'INVALID_SUITE' });
  await expect(evaluateSuite(registry, runner, base, pin, context(), [{ score: 9 } as ReviewRating])).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
  const controller = new AbortController(); controller.abort(); await expect(evaluateSuite(registry, runner, base, pin, { ...context(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  await expect(evaluateSuite(registry, runner, base, pin, { ...context(), modeDigest: 'bad' })).rejects.toMatchObject({ code: 'INVALID_CONTEXT' });
});
it('observes cancellation during case execution instead of turning it into a quality failure', async () => {
  const { registry, pin } = setup(); const controller = new AbortController();
  const runner = new MethodRunner(registry, [{ ...chapterExecutor, execute: async () => { controller.abort(); return {}; } }]);
  await expect(evaluateSuite(registry, runner, base, pin, { ...context(), signal: controller.signal })).rejects.toMatchObject({ code: 'ABORTED' });
});
it('rejects unknown, duplicate and wrongly bound reviews', async () => {
  const { registry, pin, runner } = setup(); const report = await evaluateSuite(registry, runner, base, pin, context());
  const rating: ReviewRating = { caseId: 'one', metric: 'quality', source: 'human', reviewerId: 'test', recordId: 'test', methodDigest: pin.digest, outputDigest: report.cases[0]!.outputDigest!, score: 4 };
  await expect(evaluateSuite(registry, runner, base, pin, context(), [rating])).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
  const reviewed: EvaluationSuite = { ...base, cases: [{ ...base.cases[0]!, assertions: [{ id: 'quality', category: 'quality', kind: 'review_score', metric: 'quality', reviewer: 'human', minimum: 3 }] }] };
  await expect(evaluateSuite(registry, runner, reviewed, pin, context(), [rating, rating])).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
  await expect(evaluateSuite(registry, runner, reviewed, pin, context(), [{ ...rating, methodDigest: 'b'.repeat(64) }])).rejects.toMatchObject({ code: 'INVALID_REVIEW' });
});
it('rejects report schema errors, case drift, assertion drift and invalid regression policy', async () => {
  const { registry, pin, runner } = setup(); const report = await evaluateSuite(registry, runner, base, pin, context());
  for (const mutate of [
    (value: typeof report) => { value.version = 9 as never; }, (value: typeof report) => { value.cases[0]!.inputDigest = 'b'.repeat(64); },
    (value: typeof report) => { value.cases[0]!.assertions[0]!.category = 'quality'; }, (value: typeof report) => { value.cases[0]!.assertions[0]!.reviewRecordId = 'forged'; },
  ]) { const forged = structuredClone(report); mutate(forged); expect(() => evaluationGate(registry, base, report, forged)).toThrow(); }
  expect(() => evaluationGate(registry, base, report, report, { quality: NaN })).toThrow();
  expect(() => evaluationGate(registry, base, report, { ...report, subject: { ...report.subject, method: { ...pin, id: 'another-method' } } })).toThrow();
  expect(report.cases[0]!.inputDigest).toBe(digest(base.cases[0]!.input));
});

import { expect, it } from 'vitest';
import fixture from './fixtures/original-three-episodes.json';
import { chapterPack, digest } from '../src/index.js';
import { runGoldenEvaluations } from '../src/node/golden.js';
const suite = { id: 'original-three', version: '1.0.0', cases: [{ id: 'episodes', input: { text: fixture.text }, assertions: [{ id: 'structure', category: 'structure', kind: 'output_valid' }, { id: 'title', category: 'content', kind: 'path_equals', pointer: '/chapters/0/title', expected: fixture.expectedTitles[0]! }] }] };
it('runs packaged evaluations and compares against an explicit stored baseline pack', async () => {
  const pack = { ...chapterPack, evals: [suite] }; const baseline = await runGoldenEvaluations(pack);
  expect(baseline.reports).toHaveLength(1); expect(baseline.reports[0]?.state).toBe('passed');
  expect((await runGoldenEvaluations(pack, baseline)).reports).toEqual(baseline.reports);
});
it('refuses an empty pack or omitted baseline report instead of blessing no evidence', async () => {
  await expect(runGoldenEvaluations(chapterPack)).rejects.toMatchObject({ code: 'EVALS_REQUIRED' });
  const pack = { ...chapterPack, evals: [suite] }; const baseline = await runGoldenEvaluations(pack);
  await expect(runGoldenEvaluations(pack, { ...baseline, reports: [] })).rejects.toThrow();
});
it('rejects a baseline pack paired with the current candidate report', async () => {
  const oldPack = { ...chapterPack, evals: [suite] }; const currentPack = { ...oldPack, manifest: { ...oldPack.manifest, version: '1.0.1' } };
  const oldBaseline = await runGoldenEvaluations(oldPack); const candidate = await runGoldenEvaluations(currentPack);
  await expect(runGoldenEvaluations(currentPack, { ...oldBaseline, reports: candidate.reports })).rejects.toMatchObject({ code: 'INVALID_BASELINE' });
});
it('requires baseline reports to belong to the suites declared by the baseline pack', async () => {
  const oldSuite = { ...suite, id: 'old-suite' }; const oldPack = { ...chapterPack, evals: [oldSuite] };
  const candidatePack = { ...chapterPack, manifest: { ...chapterPack.manifest, version: '1.0.1' }, evals: [suite] };
  const prior = await runGoldenEvaluations(oldPack); prior.reports[0]!.suite = { id: suite.id, version: suite.version, digest: digest(suite) };
  await expect(runGoldenEvaluations(candidatePack, prior)).rejects.toMatchObject({ code: 'INVALID_BASELINE' });
});
it('fails bad golden assertions and compares correctly across declared method versions', async () => {
  const badSuite = structuredClone(suite); badSuite.cases[0]!.assertions[1]!.expected = 'wrong';
  await expect(runGoldenEvaluations({ ...chapterPack, evals: [badSuite] })).rejects.toMatchObject({ code: 'EVALUATION_NOT_PASSED' });
  const pack = { ...chapterPack, evals: [suite] }; const prior = await runGoldenEvaluations(pack);
  expect((await runGoldenEvaluations({ ...pack, manifest: { ...pack.manifest, version: '1.0.1' } }, prior)).reports[0]?.state).toBe('passed');
});

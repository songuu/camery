import { z } from 'zod';
import { chapterExecutor } from '../chapter.js';
import { canonical, digest, jsonCopy, MethodError } from '../data.js';
import { evaluateSuite, evaluationGate, validateEvaluationReport, validateEvaluationSuite } from '../evaluation.js';
import type { EvaluationReport } from '../evaluation.js';
import { MethodRegistry } from '../registry.js';
import { MethodRunner } from '../runner.js';
import { Pack } from '../schema.js';
import type { MethodPack } from '../schema.js';
export interface GoldenBaseline { version: 1; pack: MethodPack; reports: EvaluationReport[] }
const Baseline = z.strictObject({ version: z.literal(1), pack: Pack, reports: z.array(z.json()).min(1).max(100) });

/** Local deterministic oracle run. No LLM/GPU result or human rating is invented by this command. */
export async function runGoldenEvaluations(input: MethodPack, prior?: unknown): Promise<GoldenBaseline> {
  const registry = new MethodRegistry(); const pack = jsonCopy(input); const pin = registry.register(pack);
  if (!pack.evals.length) throw new MethodError('EVALS_REQUIRED', 'golden evaluation');
  let baseline: GoldenBaseline | undefined;
  if (prior !== undefined) {
    const parsed = Baseline.safeParse(jsonCopy(prior));
    if (!parsed.success) throw new MethodError('INVALID_BASELINE', 'golden evaluation');
    baseline = { version: 1, pack: parsed.data.pack, reports: parsed.data.reports.map(validateEvaluationReport) };
    const priorPin = registry.register(baseline.pack); const priorSuites = baseline.pack.evals.map(validateEvaluationSuite);
    if (baseline.reports.length !== pack.evals.length || baseline.reports.length !== priorSuites.length || new Set(baseline.reports.map(value => value.suite.id)).size !== baseline.reports.length || baseline.reports.some(report => canonical(report.subject.method) !== canonical(priorPin) || !priorSuites.some(suite => suite.id === report.suite.id && suite.version === report.suite.version && digest(suite) === report.suite.digest))) throw new MethodError('INVALID_BASELINE', 'golden evaluation suites and method');
  }
  const runner = new MethodRunner(registry, [chapterExecutor]); const reports: EvaluationReport[] = [];
  for (const value of pack.evals) {
    const suite = validateEvaluationSuite(value);
    const report = await evaluateSuite(registry, runner, suite, pin, { tenantId: 'local-golden', connectionId: 'deterministic-chapter', modeDigest: digest({ tool: chapterExecutor.id, evidence: chapterExecutor.evidence }), idempotencyKey: `golden-${suite.id}`, signal: new AbortController().signal });
    if (report.state !== 'passed') throw new MethodError('EVALUATION_NOT_PASSED', 'golden evaluation');
    if (baseline) {
      const previous = baseline.reports.find(item => item.suite.id === suite.id);
      if (!previous || !evaluationGate(registry, suite, previous, report).allowed) throw new MethodError('REGRESSION', 'golden evaluation');
    }
    reports.push(report);
  }
  return { version: 1, pack, reports };
}

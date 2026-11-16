import { fileURLToPath } from 'node:url';
import { readGoldenBaseline, writeGoldenBaseline } from '@camery/methods/node';
import { AgentError } from '../registry.js';
import { runAgentBehaviorEvaluations } from './agent-evals.js';

async function main(args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--write-baseline')) throw new AgentError('INVALID_AGENT_EVAL_ARGUMENT');
  const update = args[0] === '--write-baseline'; const directory = fileURLToPath(new URL('../../', import.meta.url));
  const report = await runAgentBehaviorEvaluations(update ? undefined : await readGoldenBaseline(directory));
  if (update) await writeGoldenBaseline(directory, report);
  const { completion, humanEscalation, decisionCycles, reviewRounds, costMicros, chargedCostMicros } = report.summary;
  console.log(`Agent synthetic evaluations passed: ${report.cases.length} cases. Completion ${completion.completed}/${completion.total}; human escalation ${humanEscalation.escalated}/${humanEscalation.total}; decision cycles ${decisionCycles}; review rounds ${reviewRounds}; actual cost ${costMicros ?? 'unknown'} ${report.suite.currency} micros; charged ${chargedCostMicros ?? 'unknown'}. Baseline ${update ? 'written; review this change before adoption' : 'matched'}.`);
}
main(process.argv.slice(2)).catch(error => { console.error(error instanceof AgentError && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'AGENT_EVALUATION_IO'); process.exitCode = 1; });

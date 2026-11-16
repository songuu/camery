import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { DurableWorker, PostgresDurableStore } from '@camery/durable';
import { MethodRegistry, MethodRunner } from '@camery/methods';
import { loadMethodPack } from '@camery/methods/node';
import { createChapterResearchWorkflow } from '../../src/producer.js';
const tenantId = process.env['CAMERY_AGENT_TEST_TENANT']; const taskId = process.env['CAMERY_AGENT_TEST_TASK']; const phase = process.env['CAMERY_AGENT_TEST_PHASE'];
if (!tenantId || !taskId || !['crash', 'resume'].includes(phase ?? '') || !process.env['CAMERY_TEST_DATABASE_URL']) throw new Error('Missing local agent fault-test identity');
const pool = new Pool({ connectionString: process.env['CAMERY_TEST_DATABASE_URL'], max: 2 });
try {
  const store = new PostgresDurableStore(pool); const methods = new MethodRegistry();
  const method = methods.register(await loadMethodPack(fileURLToPath(new URL('../../../../method-packs/chapter-segmentation/', import.meta.url))));
  const original = MethodRunner.prototype.run;
  MethodRunner.prototype.run = async function (...args) { process.send?.({ event: 'method' }); return original.apply(this, args); };
  const budget = { maxSteps: 8, maxTokens: 0, maxCostMicros: 0, currency: 'CNY' };
  const workflow = createChapterResearchWorkflow({ name: 'agent-test', version: 1, methods, method, bindingFor: async key => ({ ...key, projectId: 'project-a', objectIds: ['source-a'], stage: 'understanding', writers: [], taskBudget: budget, projectAllocation: budget, allocationId: `allocated-${key.taskId}` }) });
  const worker = new DurableWorker(store, { leaseMs: 1000, runTimeoutMs: 30000 });
  worker.register({ ...workflow, async run(input, context) {
    return workflow.run(input, { ...context, step: async (key, options, execute) => {
      if (phase === 'crash' && key === 'agent.2.decision') { process.send?.({ event: 'blocked' }); return new Promise(() => {}); }
      return context.step(key, options, execute);
    } });
  } });
  const result = await worker.runOne(tenantId, `fault-${phase}`); process.send?.({ event: 'done', status: result?.status });
} finally { await pool.end(); process.disconnect?.(); }

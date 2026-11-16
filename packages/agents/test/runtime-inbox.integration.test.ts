import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { migrateAgents } from '../src/node/migrate.js';
import { relayOutbox } from '../src/relay.js';
import { inboxSetup } from './fixtures/inbox-support.js';

const url = process.env['CAMERY_TEST_DATABASE_URL']; if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for runtime inbox tests');
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 }); const durable = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); await migrateAgents(pool); }); afterAll(async () => { await pool.end(); });
async function fixture() {
  const scope = { tenantId: randomUUID(), projectId: randomUUID() }; const treeKey = { ...scope, treeId: randomUUID() }; const key = { ...scope, taskId: 'logical-research' }; const decisions = vi.fn(); const setup = inboxSetup(pool, { decision: decisions });
  await setup.ledger.createProject({ ...scope, currency: 'CNY', limits: { steps: 24, tokens: 0, costMicros: 0 } }, 'host-producer');
  await setup.collaboration.createTree({ ...treeKey, tasks: [{ taskId: key.taskId, parentId: null, agent: setup.agent, input: { text: 'source' }, dependencies: [], scope: { ...scope, objectIds: ['source'] }, status: 'queued' }], routes: [{ agent: setup.agent, workflow: 'agent-inbox', version: 1, maxAttempts: 3, outputKind: 'agent_report' }] }, 'host-producer');
  await setup.collaboration.queueReady(treeKey); expect((await relayOutbox(setup.collaboration, durable, scope)).pending).toEqual([]);
  const physical = { tenantId: scope.tenantId, taskId: (await setup.collaboration.loadTask(key)).durableTaskId! }; return { ...setup, scope, treeKey, key, physical, decisions };
}
it('automatically persists a runtime Question and resumes a budgeted task only after a host answer is delivered', async () => {
  const f = await fixture(); const first = new DurableWorker(durable); first.register(f.workflow); expect((await first.runOne(f.scope.tenantId, 'first'))?.status).toBe('waiting');
  const opened = await f.collaboration.getQuestion(f.key, 'question-1'); expect(opened.question).toMatchObject({ taskId: f.key.taskId, status: 'open', choices: ['one', 'two'] }); expect(opened).toMatchObject({ gateKey: 'agent.1.question', durableTaskId: f.physical.taskId, delivery: 'none' });
  expect((await f.collaboration.syncTask(f.key)).task.status).toBe('waiting'); expect(f.decisions).toHaveBeenCalledOnce();
  await f.collaboration.answerQuestion(f.key, 'question-1', 'host-human', 'two', opened.question.questionDigest); expect((await relayOutbox(f.collaboration, durable, f.scope)).pending).toEqual([]);
  const next = inboxSetup(pool, { decision: f.decisions }); const replacement = new DurableWorker(durable); replacement.register(next.workflow); const result = await replacement.runOne(f.scope.tenantId, 'replacement');
  expect(result).toMatchObject({ status: 'succeeded', output: { state: 'candidate', steps: 3, output: { text: 'host-selected candidate' } } }); expect(f.decisions).toHaveBeenCalledTimes(2);
  expect((await next.collaboration.syncTask(f.key)).task.output).toEqual({ text: 'host-selected candidate' }); expect((await next.collaboration.getQuestion(f.key, 'question-1')).delivery).toBe('delivered');
  const events = await durable.events(f.physical); expect(events.filter(value => value.action === 'gate_signalled')).toHaveLength(1);
  const held = await pool.query<{ state: string }>('SELECT state FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND project_id=$2', [f.scope.tenantId, f.scope.projectId]); expect(held.rows.map(value => value.state)).toEqual(['held']);
});
it('survives a killed process after Question commit but before step acknowledgement, preserving an early human answer', async () => {
  const f = await fixture();
  function child(phase: 'crash' | 'resume') {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/inbox-worker.ts', import.meta.url))], { cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...globalThis.process.env, CAMERY_INBOX_TENANT: f.scope.tenantId, CAMERY_INBOX_PHASE: phase }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const messages: { event: string; status?: string }[] = []; const exit = once(process, 'exit'); let wake: () => void = () => {};
    process.on('message', message => { if (message && typeof message === 'object' && 'event' in message) { messages.push(message as { event: string }); wake(); } });
    async function wait(event: string) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([new Promise<void>(resolve => { wake = () => { if (messages.some(value => value.event === event)) resolve(); }; wake(); }), exit.then(() => { if (!messages.some(value => value.event === event)) throw new Error(`Inbox worker exited before ${event}`); }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Inbox worker did not reach ${event}`)), 20000); })]); }
      finally { clearTimeout(timer); }
    }
    return { process, exit, wait, messages };
  }
  const first = child('crash');
  try {
    await first.wait('opened'); expect(first.messages.filter(value => value.event === 'decision')).toHaveLength(1); const opened = await f.collaboration.getQuestion(f.key, 'question-1');
    expect((await durable.steps(f.physical)).at(-1)).toMatchObject({ key: 'agent.1.question.open', kind: 'replayable', status: 'running' });
    await f.collaboration.answerQuestion(f.key, 'question-1', 'host-human', 'two', opened.question.questionDigest); expect((await relayOutbox(f.collaboration, durable, f.scope)).pending).toMatchObject([{ code: 'RELAY_NOT_READY' }]);
    first.process.kill('SIGKILL'); await first.exit; await pool.query("UPDATE camery_durable.tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND task_id=$2", [f.physical.tenantId, f.physical.taskId]);
    const resumed = child('resume');
    try { await resumed.wait('done'); await resumed.exit; expect(resumed.messages).toContainEqual({ event: 'done', status: 'waiting' }); expect(resumed.messages.filter(value => value.event === 'decision')).toHaveLength(0); }
    finally { resumed.process.kill(); }
    expect((await f.collaboration.getQuestion(f.key, 'question-1')).question).toMatchObject({ status: 'answered', answer: { actorId: 'host-human', value: 'two' } }); expect((await relayOutbox(f.collaboration, durable, f.scope)).pending).toEqual([]);
    const final = new DurableWorker(durable); final.register(f.workflow); expect((await final.runOne(f.scope.tenantId, 'final'))?.status).toBe('succeeded'); expect(f.decisions).toHaveBeenCalledOnce();
    const rows = await pool.query<{ action: string; count: string }>("SELECT action,count(*)::text AS count FROM camery_agents.agent_events WHERE tenant_id=$1 AND project_id=$2 AND action IN ('question_opened','question_answered') GROUP BY action ORDER BY action", [f.scope.tenantId, f.scope.projectId]); expect(rows.rows).toEqual([{ action: 'question_answered', count: '1' }, { action: 'question_opened', count: '1' }]);
    expect((await durable.events(f.physical)).filter(value => value.action === 'gate_signalled')).toHaveLength(1);
  } finally { first.process.kill(); const current = await durable.get(f.physical); if (current && !['succeeded', 'failed', 'cancelled'].includes(current.status)) await durable.cancel(f.physical, 'fault-test-cleanup'); }
});

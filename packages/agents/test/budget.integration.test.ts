import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import { migrateAgentBudgets, PostgresBudgetLedger } from '../src/node/budgets.js';
import { createBudgetedAgentWorkflow } from '../src/budget.js';
import { protocolProvider, researchRuntime, source } from './model-support.js';
const url = process.env['CAMERY_TEST_DATABASE_URL'];
if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for project budget tests');
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 }); const store = new PostgresDurableStore(pool); const ledger = new PostgresBudgetLedger(pool);
beforeAll(async () => { await migrateDurable(pool); await migrateAgentBudgets(pool); }); afterAll(async () => { await pool.end(); });
const agent = { id: 'research', version: '1.0.0', digest: 'a'.repeat(64) };
async function project(limits = { steps: 10, tokens: 100, costMicros: 100 }) {
  const key = { tenantId: randomUUID(), projectId: randomUUID() }; const definition = { ...key, currency: 'CNY', limits }; await ledger.createProject(definition, 'host-operator'); return { key, definition };
}
async function task(tenantId: string) { const key = { tenantId, taskId: randomUUID() }; await store.enqueue({ ...key, workflow: 'budget-test', version: 1, input: { source: 'synthetic' }, maxAttempts: 1, availableAt: new Date('2026-01-01') }); return key; }
const share = { maxSteps: 5, maxTokens: 100, maxCostMicros: 100, currency: 'CNY' };
it('serializes competing project allocations so only one task receives the last share', async () => {
  const p = await project(); const tasks = await Promise.all([task(p.key.tenantId), task(p.key.tenantId)]);
  const results = await Promise.allSettled(tasks.map(key => ledger.allocate({ ...p.key, ...key, allocationId: randomUUID(), agent, budget: share })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'PROJECT_BUDGET_LIMIT' } });
  expect(await ledger.project(p.key)).toMatchObject({ used: { steps: '5', tokens: '100', costMicros: '100' }, remaining: { steps: '5', tokens: '0', costMicros: '0' } });
});
it('makes allocation exact-content idempotent and refuses cross-project or altered grants for a task', async () => {
  const p = await project(); const key = await task(p.key.tenantId); const request = { ...p.key, ...key, allocationId: randomUUID(), agent, budget: share };
  const allocation = await ledger.allocate(request); expect(await ledger.allocate(request)).toEqual(allocation);
  for (const changes of [{ allocationId: randomUUID() }, { agent: { ...agent, digest: 'b'.repeat(64) } }, { budget: { ...share, maxTokens: 99 } }]) await expect(ledger.allocate({ ...request, ...changes })).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' });
  const second = { ...p.definition, projectId: randomUUID() }; await ledger.createProject(second, 'host-operator'); await expect(ledger.allocate({ ...request, projectId: second.projectId })).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' });
  expect((await ledger.events(p.key)).filter(event => event.action === 'allocated')).toHaveLength(1);
});
it('keeps unknown cancelled work reserved until reconciliation and an explicit known-usage confirmation', async () => {
  const p = await project(); const key = await task(p.key.tenantId); const allocationId = randomUUID(); await ledger.allocate({ ...p.key, ...key, allocationId, agent, budget: share });
  const worker = new DurableWorker(store); worker.register({ name: 'budget-test', version: 1, run: async (_input, ctx) => ctx.step('synthetic-paid', { kind: 'external', input: null }, async () => { throw new Error('uncertain test-only result'); }) });
  expect((await worker.runOne(key.tenantId, 'worker'))?.status).toBe('reconciling'); await store.cancel(key, 'host-operator');
  const settlement = { ...p.key, ...key, allocationId, actorId: 'host-operator', receiptId: 'receipt-1', reference: 'confirmed-provider-and-journal-usage', actual: { steps: 1, tokens: 12, costMicros: 20 } };
  await expect(ledger.settleConfirmed(settlement)).rejects.toMatchObject({ code: 'BUDGET_UNCERTAIN' }); expect((await ledger.project(p.key)).used.costMicros).toBe('100');
  await store.reconcile({ ...key, stepKey: 'synthetic-paid', actorId: 'host-operator', resolution: { kind: 'completed', output: { confirmed: true } } });
  const settled = await ledger.settleConfirmed(settlement); expect(settled.state).toBe('settled'); expect(await ledger.settleConfirmed(settlement)).toEqual(settled);
  expect((await ledger.project(p.key)).used).toEqual({ steps: '1', tokens: '12', costMicros: '20' });
  await expect(ledger.settleConfirmed({ ...settlement, receiptId: 'new-receipt', actual: { steps: 0, tokens: 0, costMicros: 0 } })).rejects.toMatchObject({ code: 'SETTLEMENT_CONFLICT' });
});
it('does not settle a nonterminal task or infer actual amounts from its reservation', async () => {
  const p = await project(); const key = await task(p.key.tenantId); const allocationId = randomUUID(); await ledger.allocate({ ...p.key, ...key, allocationId, agent, budget: share });
  const settlement = { ...p.key, ...key, allocationId, actorId: 'host-operator', receiptId: 'r1', reference: 'confirmed', actual: { steps: 0, tokens: 0, costMicros: 0 } };
  await expect(ledger.settleConfirmed(settlement)).rejects.toMatchObject({ code: 'TASK_NOT_TERMINAL' }); await store.cancel(key, 'host-operator');
  await expect(ledger.settleConfirmed({ ...settlement, actual: { steps: 0, tokens: null, costMicros: 0 } } as never)).rejects.toMatchObject({ code: 'INVALID_BUDGET_INPUT' }); expect((await ledger.project(p.key)).used.tokens).toBe('100');
});
it('records confirmed overrun debt instead of rejecting already-spent amounts or granting more budget', async () => {
  const p = await project(); const key = await task(p.key.tenantId); const allocationId = randomUUID(); await ledger.allocate({ ...p.key, ...key, allocationId, agent, budget: share }); await store.cancel(key, 'host-operator');
  await ledger.settleConfirmed({ ...p.key, ...key, allocationId, actorId: 'host-operator', receiptId: 'overrun', reference: 'verified-final-bill', actual: { steps: 5, tokens: 150, costMicros: 140 } });
  expect(await ledger.project(p.key)).toMatchObject({ used: { tokens: '150', costMicros: '140' }, debt: { tokens: '50', costMicros: '40' } }); const next = await task(p.key.tenantId);
  await expect(ledger.allocate({ ...p.key, ...next, allocationId: randomUUID(), agent, budget: { ...share, maxTokens: 0, maxCostMicros: 0 } })).rejects.toMatchObject({ code: 'PROJECT_BUDGET_LIMIT' });
});
it('keeps project configuration immutable and isolates missing tenant/project/task or wrong-currency requests', async () => {
  const p = await project(); expect(await ledger.createProject(p.definition, 'second-host-operator')).toEqual(p.definition);
  await expect(ledger.createProject({ ...p.definition, limits: { ...p.definition.limits, tokens: 101 } }, 'host-operator')).rejects.toMatchObject({ code: 'PROJECT_BUDGET_CONFLICT' });
  expect((await ledger.events(p.key)).filter(event => event.action === 'project_created')).toHaveLength(1);
  await expect(ledger.project({ tenantId: randomUUID(), projectId: p.key.projectId })).rejects.toMatchObject({ code: 'PROJECT_BUDGET_NOT_FOUND' });
  const key = await task(p.key.tenantId); const request = { ...p.key, ...key, allocationId: randomUUID(), agent, budget: share };
  await expect(ledger.allocate({ ...request, taskId: randomUUID() })).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  await expect(ledger.allocate({ ...request, budget: { ...share, currency: 'USD' } })).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  await store.cancel(key, 'host-operator'); await expect(ledger.allocate(request)).rejects.toMatchObject({ code: 'TASK_NOT_ALLOCATABLE' });
});
it('rejects reused allocation and receipt identities, and changed durable task fingerprints', async () => {
  const p = await project({ steps: 20, tokens: 200, costMicros: 200 }); const one = await task(p.key.tenantId); const two = await task(p.key.tenantId); const allocationId = randomUUID();
  const request = { ...p.key, ...one, allocationId, agent, budget: share }; await ledger.allocate(request);
  await expect(ledger.allocate({ ...request, ...two })).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' });
  const other = { ...p.key, ...two, allocationId: randomUUID(), agent, budget: share }; await ledger.allocate(other);
  await store.cancel(one, 'host-operator'); await store.cancel(two, 'host-operator');
  const confirmation = { actorId: 'host-operator', receiptId: 'shared-receipt', reference: 'explicit-confirmed-record', actual: { steps: 0, tokens: 0, costMicros: 0 } };
  await ledger.settleConfirmed({ ...p.key, ...one, allocationId, ...confirmation });
  await expect(ledger.settleConfirmed({ ...other, ...confirmation })).rejects.toMatchObject({ code: 'INVALID_BUDGET_INPUT' });
  const { agent: _agent, budget: _budget, ...otherKey } = other;
  await expect(ledger.settleConfirmed({ ...otherKey, ...confirmation })).rejects.toMatchObject({ code: 'RECEIPT_CONFLICT' });
  await pool.query('UPDATE camery_durable.tasks SET input=$3::jsonb WHERE tenant_id=$1 AND task_id=$2', [two.tenantId, two.taskId, '{"changed":true}']);
  await expect(ledger.allocate(other)).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' });
  await expect(ledger.settleConfirmed({ ...otherKey, ...confirmation, receiptId: 'new-receipt' })).rejects.toMatchObject({ code: 'ALLOCATION_CONFLICT' });
});
it('does not backdate a new reservation after any external step has already begun', async () => {
  const p = await project(); const key = await task(p.key.tenantId); const request = { ...p.key, ...key, allocationId: randomUUID(), agent, budget: share }; let errorCode = '';
  const worker = new DurableWorker(store); worker.register({ name: 'budget-test', version: 1, async run(_input, ctx) {
    await ctx.step('already-paid', { kind: 'external', input: null }, async () => null);
    try { await ledger.allocate(request); } catch (error) { errorCode = (error as { code: string }).code; } return { errorCode };
  } });
  expect((await worker.runOne(key.tenantId, 'unallocated-test-worker'))?.status).toBe('succeeded'); expect(errorCode).toBe('ALLOCATION_TOO_LATE'); expect((await ledger.project(p.key)).used.tokens).toBe('0');
});
it('keeps exposure exact even when confirmed totals exceed JavaScript safe integer range', async () => {
  const p = await project({ steps: 20, tokens: Number.MAX_SAFE_INTEGER, costMicros: Number.MAX_SAFE_INTEGER });
  for (let index = 0; index < 2; index++) {
    const key = await task(p.key.tenantId); const allocationId = randomUUID(); await ledger.allocate({ ...p.key, ...key, allocationId, agent, budget: { ...share, maxTokens: 0, maxCostMicros: 0 } }); await store.cancel(key, 'host-operator');
    await ledger.settleConfirmed({ ...p.key, ...key, allocationId, actorId: 'host-operator', receiptId: `large-${index}`, reference: 'explicit-large-actual-record', actual: { steps: 1, tokens: Number.MAX_SAFE_INTEGER, costMicros: Number.MAX_SAFE_INTEGER } });
  }
  const snapshot = await ledger.project(p.key); expect(snapshot.used.tokens).toBe(String(2n * BigInt(Number.MAX_SAFE_INTEGER))); expect(snapshot.debt.costMicros).toBe(String(Number.MAX_SAFE_INTEGER));
  const next = await task(p.key.tenantId); await expect(ledger.allocate({ ...p.key, ...next, allocationId: randomUUID(), agent, budget: { ...share, maxTokens: 0, maxCostMicros: 0 } })).rejects.toMatchObject({ code: 'PROJECT_BUDGET_LIMIT' });
});
async function fault(tenantId: string, table: 'budget_allocations' | 'budget_events', action: 'INSERT' | 'UPDATE', returnsNull: boolean) {
  if (!/^[a-f0-9-]{36}$/.test(tenantId)) throw new Error('Fault tests require a generated tenant UUID');
  const name = `fault_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE FUNCTION camery_agents.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${tenantId}' THEN ${returnsNull ? 'RETURN NULL;' : "RAISE EXCEPTION 'injected budget test fault';"} END IF; RETURN NEW; END $$; CREATE TRIGGER ${name} BEFORE ${action} ON camery_agents.${table} FOR EACH ROW EXECUTE FUNCTION camery_agents.${name}()`);
  return async () => { await pool.query(`DROP TRIGGER ${name} ON camery_agents.${table}; DROP FUNCTION camery_agents.${name}()`); };
}
it('rolls allocation and settlement back if audit insertion fails or a write returns zero rows', async () => {
  const p = await project(); const key = await task(p.key.tenantId); const allocationId = randomUUID(); const request = { ...p.key, ...key, allocationId, agent, budget: share };
  for (const table of ['budget_events', 'budget_allocations'] as const) {
    const cleanup = await fault(p.key.tenantId, table, 'INSERT', table === 'budget_allocations');
    try { await expect(ledger.allocate(request)).rejects.toMatchObject({ code: table === 'budget_events' ? 'BUDGET_STORAGE_FAILED' : 'BUDGET_WRITE_FAILED' }); expect((await ledger.project(p.key)).used.tokens).toBe('0'); expect((await ledger.events(p.key)).filter(event => event.action === 'allocated')).toHaveLength(0); }
    finally { await cleanup(); }
  }
  await ledger.allocate(request); await store.cancel(key, 'host-operator'); const confirmation = { ...p.key, ...key, allocationId, actorId: 'host-operator', receiptId: 'rollback-test', reference: 'confirmed', actual: { steps: 1, tokens: 1, costMicros: 1 } };
  for (const table of ['budget_events', 'budget_allocations'] as const) {
    const cleanup = await fault(p.key.tenantId, table, table === 'budget_events' ? 'INSERT' : 'UPDATE', table === 'budget_allocations');
    try { await expect(ledger.settleConfirmed(confirmation)).rejects.toMatchObject({ code: table === 'budget_events' ? 'BUDGET_STORAGE_FAILED' : 'BUDGET_WRITE_FAILED' }); expect((await ledger.project(p.key)).used.tokens).toBe('100'); expect((await ledger.events(p.key)).filter(event => event.action === 'settled')).toHaveLength(0); }
    finally { await cleanup(); }
  }
  expect((await ledger.settleConfirmed(confirmation)).state).toBe('settled');
});
it('binds a real model workflow to one database share and does not reserve it again after a worker restart', async () => {
  const p = await project({ steps: 8, tokens: 256, costMicros: 0 }); const item = { tenantId: p.key.tenantId, taskId: randomUUID(), workflow: 'budgeted-model', version: 1, input: source, maxAttempts: 1, availableAt: new Date('2026-01-01') }; await store.enqueue(item);
  const allocationId = randomUUID(); const allocate = vi.spyOn(ledger, 'allocate'); const provider = protocolProvider();
  async function workflow(transport: ReturnType<typeof protocolProvider>['transport']) {
    const setup = await researchRuntime(transport, item); const inner = createBudgetedAgentWorkflow({ name: item.workflow, version: 1, runtime: setup.runtime, agent: setup.pin, ledger, planFor: async () => ({ projectId: p.key.projectId, objectIds: [source.sourceId], stage: 'understanding', writers: [], taskBudget: setup.binding.taskBudget, allocationBudget: setup.binding.taskBudget, allocationId }) });
    return { ...inner, async run(input: Parameters<typeof inner.run>[0], ctx: Parameters<typeof inner.run>[1]) { const report = await inner.run(input, ctx); await ctx.waitForSignal('review', null); return report; } };
  }
  try {
    const first = new DurableWorker(store); first.register(await workflow(provider.transport)); expect((await first.runOne(item.tenantId, 'first'))?.status).toBe('waiting'); expect(allocate).toHaveBeenCalledOnce(); expect((await ledger.project(p.key)).used.tokens).toBe('256');
    await store.signal({ ...item, gateKey: 'review', signalId: 'reviewed', actorId: 'host-human', value: true }); const replacement = protocolProvider(); const next = new DurableWorker(store); next.register(await workflow(replacement.transport));
    expect((await next.runOne(item.tenantId, 'replacement'))?.status).toBe('succeeded'); expect(allocate).toHaveBeenCalledOnce(); expect(replacement.calls()).toBe(0); expect(provider.calls()).toBe(2); expect((await ledger.project(p.key)).used.tokens).toBe('256');
    await ledger.settleConfirmed({ ...p.key, taskId: item.taskId, allocationId, actorId: 'host-operator', receiptId: 'explicit-post-run-confirmation', reference: 'synthetic-provider-total-confirmed-after-run', actual: { steps: 3, tokens: 40, costMicros: 0 } }); expect((await ledger.project(p.key)).remaining.tokens).toBe('216');
  } finally { allocate.mockRestore(); }
});
it('recovers a committed allocation whose journal acknowledgement was lost without reserving twice', async () => {
  const p = await project({ steps: 8, tokens: 256, costMicros: 0 }); const item = { tenantId: p.key.tenantId, taskId: randomUUID(), workflow: 'allocation-ack-loss', version: 1, input: source, maxAttempts: 3, availableAt: new Date('2026-01-01') }; await store.enqueue(item);
  const provider = protocolProvider(); const setup = await researchRuntime(provider.transport, item); const allocationId = randomUUID(); const original = ledger.allocate.bind(ledger); let interrupted = false;
  const allocate = vi.spyOn(ledger, 'allocate').mockImplementation(async request => { const result = await original(request); if (!interrupted) { interrupted = true; throw new Error('synthetic loss after ledger commit'); } return result; });
  const workflow = createBudgetedAgentWorkflow({ name: item.workflow, version: 1, agent: setup.pin, runtime: setup.runtime, ledger, planFor: async () => ({ projectId: p.key.projectId, objectIds: [source.sourceId], stage: 'understanding', writers: [], taskBudget: setup.binding.taskBudget, allocationBudget: setup.binding.taskBudget, allocationId }) });
  const worker = new DurableWorker(store, { retryDelayMs: 1 }); worker.register(workflow);
  try {
    expect((await worker.runOne(item.tenantId, 'interrupted'))?.status).toBe('queued'); expect(provider.calls()).toBe(0); expect((await ledger.project(p.key)).used.tokens).toBe('256');
    await pool.query('UPDATE camery_durable.tasks SET available_at=clock_timestamp() WHERE tenant_id=$1 AND task_id=$2', [item.tenantId, item.taskId]);
    expect((await worker.runOne(item.tenantId, 'recovered'))?.status).toBe('succeeded'); expect(allocate).toHaveBeenCalledTimes(2); expect(provider.calls()).toBe(2);
    expect((await ledger.events(p.key)).filter(event => event.action === 'allocated')).toHaveLength(1); expect((await ledger.project(p.key)).used.tokens).toBe('256');
  } finally { allocate.mockRestore(); }
});

import type { Pool, PoolClient } from 'pg';
import { canonical, digest, freeze, jsonCopy } from '@camery/methods';
import { Allocation, AllocationRequest, budgetData, BudgetLedgerError, ConfirmSettlement, ProjectBudgetDefinition, ProjectBudgetKey } from '../budget.js';
import type { BudgetAllocation, BudgetLedger, ProjectBudgetSnapshot } from '../budget.js';
import { Name } from '../registry.js';

export { migrateAgents as migrateAgentBudgets } from './migrate.js';
type ProjectRow = { tenant_id: string; project_id: string; currency: string; limit_steps: string; limit_tokens: string; limit_cost: string; definition_digest: string };
type AllocationRow = { tenant_id: string; project_id: string; allocation_id: string; task_id: string; agent: unknown; task_fingerprint: string; reserved_steps: string; reserved_tokens: string; reserved_cost: string; state: string; actual_steps: string | null; actual_tokens: string | null; actual_cost: string | null; actor_id: string | null; receipt_id: string | null; reference: string | null; settlement_digest: string | null };
type TaskRow = { tenant_id: string; task_id: string; workflow: string; version: number; input: unknown; max_attempts: number; enqueue_identity: string; status: string };
type Totals = { steps: string; tokens: string; costMicros: string };
const integer = (value: string): bigint => { if (!/^(0|[1-9]\d*)$/.test(value)) throw new BudgetLedgerError('BUDGET_DATA_CORRUPT'); return BigInt(value); };
function project(row: ProjectRow): ProjectBudgetDefinition {
  const result = budgetData(ProjectBudgetDefinition, { tenantId: row.tenant_id, projectId: row.project_id, currency: row.currency, limits: { steps: Number(row.limit_steps), tokens: Number(row.limit_tokens), costMicros: Number(row.limit_cost) } });
  if (digest(result) !== row.definition_digest) throw new BudgetLedgerError('BUDGET_DATA_CORRUPT'); return result;
}
function allocation(row: AllocationRow, currency: string): BudgetAllocation {
  return budgetData(Allocation, { tenantId: row.tenant_id, projectId: row.project_id, taskId: row.task_id, allocationId: row.allocation_id, agent: row.agent, budget: { maxSteps: Number(row.reserved_steps), maxTokens: Number(row.reserved_tokens), maxCostMicros: Number(row.reserved_cost), currency }, taskFingerprint: row.task_fingerprint, state: row.state,
    confirmation: row.state === 'held' ? null : { actorId: row.actor_id, receiptId: row.receipt_id, reference: row.reference, actual: { steps: Number(row.actual_steps), tokens: Number(row.actual_tokens), costMicros: Number(row.actual_cost) } } });
}
const requestOf = (value: BudgetAllocation): AllocationRequest => ({ tenantId: value.tenantId, projectId: value.projectId, taskId: value.taskId, allocationId: value.allocationId, agent: value.agent, budget: value.budget });
const fingerprint = (task: TaskRow): string => digest({ tenantId: task.tenant_id, taskId: task.task_id, workflow: task.workflow, version: task.version, input: task.input, maxAttempts: task.max_attempts, enqueueAt: task.enqueue_identity });
/** Task → project → allocation lock order. No transaction spans a model call. */
export class PostgresBudgetLedger implements BudgetLedger {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try { client = await this.pool.connect(); } catch { throw new BudgetLedgerError('BUDGET_STORAGE_FAILED'); }
    try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch { throw new BudgetLedgerError('BUDGET_STORAGE_FAILED'); } if (error instanceof BudgetLedgerError) throw error; throw new BudgetLedgerError('BUDGET_STORAGE_FAILED'); }
    finally { client.release(); }
  }
  private async task(client: PoolClient, key: { tenantId: string; taskId: string }): Promise<TaskRow> {
    const result = await client.query<TaskRow>(`SELECT tenant_id,task_id,workflow,version,input,max_attempts,status,to_char(enqueue_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS enqueue_identity FROM camery_durable.tasks WHERE tenant_id=$1 AND task_id=$2 FOR UPDATE`, [key.tenantId, key.taskId]);
    if (!result.rows[0]) throw new BudgetLedgerError('TASK_NOT_FOUND'); return result.rows[0];
  }
  private async lockedProject(client: PoolClient, key: { tenantId: string; projectId: string }): Promise<ProjectBudgetDefinition> {
    const result = await client.query<ProjectRow>('SELECT * FROM camery_agents.budget_projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE', [key.tenantId, key.projectId]);
    if (!result.rows[0]) throw new BudgetLedgerError('PROJECT_BUDGET_NOT_FOUND'); return project(result.rows[0]);
  }
  private async totals(client: PoolClient, key: { tenantId: string; projectId: string }): Promise<Totals> {
    const result = await client.query<Totals>(`SELECT COALESCE(SUM(CASE WHEN state='held' THEN reserved_steps ELSE actual_steps END),0)::text AS steps,COALESCE(SUM(CASE WHEN state='held' THEN reserved_tokens ELSE actual_tokens END),0)::text AS tokens,COALESCE(SUM(CASE WHEN state='held' THEN reserved_cost ELSE actual_cost END),0)::text AS "costMicros" FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND project_id=$2`, [key.tenantId, key.projectId]);
    const totals = result.rows[0]!; for (const value of Object.values(totals)) integer(value); return totals;
  }
  private async event(client: PoolClient, key: { tenantId: string; projectId: string }, allocationId: string | null, action: string, detail: unknown): Promise<void> {
    const result = await client.query('INSERT INTO camery_agents.budget_events(tenant_id,project_id,allocation_id,action,detail) VALUES($1,$2,$3,$4,$5::jsonb)', [key.tenantId, key.projectId, allocationId, action, canonical(detail)]);
    if (result.rowCount !== 1) throw new BudgetLedgerError('BUDGET_WRITE_FAILED');
  }
  async createProject(input: ProjectBudgetDefinition, actor: string): Promise<ProjectBudgetDefinition> {
    const definition = budgetData(ProjectBudgetDefinition, input); const actorId = budgetData(Name, actor);
    return this.transaction(async client => {
      const inserted = await client.query('INSERT INTO camery_agents.budget_projects(tenant_id,project_id,currency,limit_steps,limit_tokens,limit_cost,definition_digest) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [definition.tenantId, definition.projectId, definition.currency, definition.limits.steps, definition.limits.tokens, definition.limits.costMicros, digest(definition)]);
      const existing = await this.lockedProject(client, definition); if (canonical(existing) !== canonical(definition)) throw new BudgetLedgerError('PROJECT_BUDGET_CONFLICT');
      if (inserted.rowCount === 1) await this.event(client, definition, null, 'project_created', { actorId, digest: digest(definition) }); return existing;
    });
  }
  async allocate(input: AllocationRequest): Promise<BudgetAllocation> {
    const request = budgetData(AllocationRequest, input);
    return this.transaction(async client => {
      const task = await this.task(client, request); const definition = await this.lockedProject(client, request);
      const existing = await client.query<AllocationRow>('SELECT * FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND task_id=$2 FOR UPDATE', [request.tenantId, request.taskId]);
      if (existing.rows[0]) {
        const found = allocation(existing.rows[0], definition.currency);
        if (canonical(requestOf(found)) !== canonical(request) || found.taskFingerprint !== fingerprint(task)) throw new BudgetLedgerError('ALLOCATION_CONFLICT'); return found;
      }
      if (request.budget.currency !== definition.currency) throw new BudgetLedgerError('CURRENCY_MISMATCH');
      const collision = await client.query('SELECT 1 FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND project_id=$2 AND allocation_id=$3', [request.tenantId, request.projectId, request.allocationId]);
      if (collision.rows.length) throw new BudgetLedgerError('ALLOCATION_CONFLICT');
      if (!['queued', 'running'].includes(task.status)) throw new BudgetLedgerError('TASK_NOT_ALLOCATABLE');
      const effects = await client.query("SELECT 1 FROM camery_durable.steps WHERE tenant_id=$1 AND task_id=$2 AND kind='external' LIMIT 1", [request.tenantId, request.taskId]);
      if (effects.rows.length) throw new BudgetLedgerError('ALLOCATION_TOO_LATE');
      const used = await this.totals(client, request); const amounts = { steps: request.budget.maxSteps, tokens: request.budget.maxTokens, costMicros: request.budget.maxCostMicros };
      for (const key of ['steps', 'tokens', 'costMicros'] as const) if (integer(used[key]) + BigInt(amounts[key]) > BigInt(definition.limits[key])) throw new BudgetLedgerError('PROJECT_BUDGET_LIMIT');
      const result = await client.query<AllocationRow>("INSERT INTO camery_agents.budget_allocations(tenant_id,project_id,allocation_id,task_id,agent,task_fingerprint,reserved_steps,reserved_tokens,reserved_cost,state) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,'held') RETURNING *", [request.tenantId, request.projectId, request.allocationId, request.taskId, canonical(request.agent), fingerprint(task), amounts.steps, amounts.tokens, amounts.costMicros]);
      if (result.rowCount !== 1) throw new BudgetLedgerError('BUDGET_WRITE_FAILED'); await this.event(client, request, request.allocationId, 'allocated', request); return allocation(result.rows[0]!, definition.currency);
    });
  }
  async settleConfirmed(input: ConfirmSettlement): Promise<BudgetAllocation> {
    const confirmed = budgetData(ConfirmSettlement, input);
    return this.transaction(async client => {
      const task = await this.task(client, confirmed); const definition = await this.lockedProject(client, confirmed);
      const result = await client.query<AllocationRow>('SELECT * FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND project_id=$2 AND allocation_id=$3 FOR UPDATE', [confirmed.tenantId, confirmed.projectId, confirmed.allocationId]); const row = result.rows[0];
      if (!row || row.task_id !== confirmed.taskId || row.task_fingerprint !== fingerprint(task)) throw new BudgetLedgerError('ALLOCATION_CONFLICT');
      const identity = digest(confirmed);
      if (row.state === 'settled') { if (row.settlement_digest !== identity) throw new BudgetLedgerError('SETTLEMENT_CONFLICT'); return allocation(row, definition.currency); }
      if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) throw new BudgetLedgerError('TASK_NOT_TERMINAL');
      const unknown = await client.query("SELECT 1 FROM camery_durable.steps WHERE tenant_id=$1 AND task_id=$2 AND kind='external' AND status IN ('running','unknown') LIMIT 1", [confirmed.tenantId, confirmed.taskId]);
      if (unknown.rows.length) throw new BudgetLedgerError('BUDGET_UNCERTAIN');
      const duplicate = await client.query('SELECT 1 FROM camery_agents.budget_allocations WHERE tenant_id=$1 AND project_id=$2 AND receipt_id=$3', [confirmed.tenantId, confirmed.projectId, confirmed.receiptId]); if (duplicate.rows.length) throw new BudgetLedgerError('RECEIPT_CONFLICT');
      // A confirmed bill may exceed its quote: preserve the debt rather than discarding spent money.
      const updated = await client.query<AllocationRow>("UPDATE camery_agents.budget_allocations SET state='settled',actual_steps=$4,actual_tokens=$5,actual_cost=$6,actor_id=$7,receipt_id=$8,reference=$9,settlement_digest=$10 WHERE tenant_id=$1 AND project_id=$2 AND allocation_id=$3 AND state='held' RETURNING *", [confirmed.tenantId, confirmed.projectId, confirmed.allocationId, confirmed.actual.steps, confirmed.actual.tokens, confirmed.actual.costMicros, confirmed.actorId, confirmed.receiptId, confirmed.reference, identity]);
      if (updated.rowCount !== 1) throw new BudgetLedgerError('BUDGET_WRITE_FAILED'); await this.event(client, confirmed, confirmed.allocationId, 'settled', confirmed); return allocation(updated.rows[0]!, definition.currency);
    });
  }
  async project(input: { tenantId: string; projectId: string }): Promise<ProjectBudgetSnapshot> {
    const key = budgetData(ProjectBudgetKey, input);
    return this.transaction(async client => {
      const definition = await this.lockedProject(client, key); const used = await this.totals(client, key); const remaining = { steps: '0', tokens: '0', costMicros: '0' }; const debt = { ...remaining };
      for (const metric of ['steps', 'tokens', 'costMicros'] as const) { const difference = BigInt(definition.limits[metric]) - integer(used[metric]); remaining[metric] = difference > 0n ? String(difference) : '0'; debt[metric] = difference < 0n ? String(-difference) : '0'; }
      return freeze({ definition, used, remaining, debt });
    });
  }
  async events(input: { tenantId: string; projectId: string }): Promise<{ action: string; detail: unknown }[]> {
    const key = budgetData(ProjectBudgetKey, input);
    return this.transaction(async client => { const result = await client.query<{ action: string; detail: unknown }>('SELECT action,detail FROM camery_agents.budget_events WHERE tenant_id=$1 AND project_id=$2 ORDER BY event_id', [key.tenantId, key.projectId]); return jsonCopy(result.rows); });
  }
}

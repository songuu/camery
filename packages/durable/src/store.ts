import { sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { DurableError, type ClaimedTask, type DurableStore, type EnqueueTask, type Event, type Json, type Lease, type OpenStep, type ReconcileInput, type SignalInput, type Step, type StepSpec, type Task, type TaskKey } from './types.js';
import { canonicalJson, validateActor, validateDuration, validateEnqueue, validateJson, validateKey, validateLease, validateName, validateReconcile, validateSignal, validateStep } from './validation.js';

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];
type TaskRow = {
  tenant_id: string; task_id: string; workflow: string; version: number; input: Json; max_attempts: number;
  failure_count: number; status: Task['status']; attempts: number; fence: number; owner: string | null;
  lease_until: string | null; available_at: string | null; enqueue_at: string; output: Json; error: string | null;
};
type StepRow = { step_key: string; position: number; kind: Step['kind']; input: Json; fingerprint: string; idempotency_key: string; status: Step['status']; output: Json; error: string | null; due_at: string | null };
const where = (key: TaskKey): SQL => sql`tenant_id=${key.tenantId} AND task_id=${key.taskId}`;
const json = (value: Json): SQL => sql`${canonicalJson(value)}::jsonb`;
const date = (value: string | null): Date | null => value === null ? null : new Date(value);
const toTask = (row: TaskRow): Task => ({ tenantId: row.tenant_id, taskId: row.task_id, workflow: row.workflow, version: row.version, input: row.input, maxAttempts: row.max_attempts, availableAt: date(row.available_at), status: row.status, attempts: row.attempts, fence: row.fence, owner: row.owner, leaseUntil: date(row.lease_until), output: row.output, error: row.error });
const toStep = (row: StepRow): Step => ({ key: row.step_key, position: row.position, kind: row.kind, input: row.input, fingerprint: row.fingerprint, idempotencyKey: row.idempotency_key, status: row.status, output: row.output, error: row.error, dueAt: date(row.due_at) });
function errorMessage(value: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new DurableError('INVALID_INPUT', 'Failure detail must contain 1–4000 characters');
}
async function event(tx: Tx, key: TaskKey, action: string, detail: Json = null): Promise<void> {
  await tx.execute(sql`INSERT INTO camery_durable.events(tenant_id,task_id,action,detail) VALUES (${key.tenantId},${key.taskId},${action},${json(detail)})`);
}

/** Every transition locks the task row before its journal, so cancellation and lease writes share one order. */
export class PostgresDurableStore implements DurableStore {
  private readonly db: NodePgDatabase;
  constructor(pool: Pool) { this.db = drizzle(pool); }

  private async locked<T>(key: TaskKey, operation: (tx: Tx, row: TaskRow) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      const result = await tx.execute<TaskRow>(sql`SELECT * FROM camery_durable.tasks WHERE ${where(key)} FOR UPDATE`);
      const row = result.rows[0];
      if (!row) throw new DurableError('TASK_NOT_FOUND', `Task ${key.taskId} does not exist in this tenant`);
      return operation(tx, row);
    });
  }
  private async live(tx: Tx, row: TaskRow, lease: Lease): Promise<void> {
    const clock = await tx.execute<{ live: boolean }>(sql`SELECT ${row.lease_until}::timestamptz > clock_timestamp() AS live`);
    if (row.status !== 'running' || row.owner !== lease.owner || row.fence !== lease.fence || !clock.rows[0]?.live) {
      throw new DurableError('LEASE_LOST', `Task ${lease.taskId} lease is no longer live for fence ${lease.fence}`);
    }
  }
  async enqueue(input: EnqueueTask): Promise<Task> {
    validateEnqueue(input);
    return this.db.transaction(async tx => {
      await tx.execute(sql`INSERT INTO camery_durable.tasks(tenant_id,task_id,workflow,version,input,max_attempts,status,available_at,enqueue_at)
        VALUES (${input.tenantId},${input.taskId},${input.workflow},${input.version},${json(input.input)},${input.maxAttempts},'queued',${input.availableAt},${input.availableAt}) ON CONFLICT DO NOTHING`);
      const result = await tx.execute<TaskRow>(sql`SELECT * FROM camery_durable.tasks WHERE ${where(input)} FOR UPDATE`);
      const row = result.rows[0]!;
      if (row.workflow !== input.workflow || row.version !== input.version || row.max_attempts !== input.maxAttempts || canonicalJson(row.input) !== canonicalJson(input.input) || new Date(row.enqueue_at).getTime() !== input.availableAt.getTime()) {
        throw new DurableError('TASK_CONFLICT', `Task ${input.taskId} was already enqueued with different content`);
      }
      // ON CONFLICT may be a retry after success; creation events remain unique under this row lock.
      await tx.execute(sql`INSERT INTO camery_durable.events(tenant_id,task_id,action,detail)
        SELECT ${input.tenantId},${input.taskId},'enqueued','null'::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM camery_durable.events WHERE ${where(input)} AND action='enqueued')`);
      return toTask(row);
    });
  }
  async get(key: TaskKey): Promise<Task | null> {
    validateKey(key);
    const result = await this.db.execute<TaskRow>(sql`SELECT * FROM camery_durable.tasks WHERE ${where(key)}`);
    return result.rows[0] ? toTask(result.rows[0]) : null;
  }
  async steps(key: TaskKey): Promise<Step[]> {
    validateKey(key);
    const result = await this.db.execute<StepRow>(sql`SELECT * FROM camery_durable.steps WHERE ${where(key)} ORDER BY position`);
    return result.rows.map(toStep);
  }
  async events(key: TaskKey): Promise<Event[]> {
    validateKey(key);
    const result = await this.db.execute<{ action: string; detail: Json }>(sql`SELECT action,detail FROM camery_durable.events WHERE ${where(key)} ORDER BY event_id`);
    return result.rows;
  }
  async claim(tenantId: string, workerId: string, leaseMs: number): Promise<ClaimedTask | null> {
    validateName(tenantId, 'tenantId'); validateName(workerId, 'workerId'); validateDuration(leaseMs, 'leaseMs');
    return this.claimEligible(sql`tenant_id=${tenantId}`, workerId, leaseMs);
  }
  async claimTask(input: TaskKey, workerId: string, leaseMs: number): Promise<ClaimedTask | null> {
    validateKey(input); const key = Object.freeze({ tenantId: input.tenantId, taskId: input.taskId });
    validateName(workerId, 'workerId'); validateDuration(leaseMs, 'leaseMs');
    return this.claimEligible(where(key), workerId, leaseMs);
  }
  private async claimEligible(predicate: SQL, workerId: string, leaseMs: number): Promise<ClaimedTask | null> {
    return this.db.transaction(async tx => {
      while (true) {
        const selected = await tx.execute<TaskRow>(sql`SELECT * FROM camery_durable.tasks WHERE ${predicate}
          AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='waiting' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<=clock_timestamp()))
          ORDER BY COALESCE(available_at,lease_until),created_at,task_id FOR UPDATE SKIP LOCKED LIMIT 1`);
        const row = selected.rows[0]; if (!row) return null;
        const key = { tenantId: row.tenant_id, taskId: row.task_id };
        if (row.status === 'running') {
          const uncertain = await tx.execute(sql`UPDATE camery_durable.steps SET status='unknown',error='Worker lease expired with external outcome unknown',updated_at=clock_timestamp()
            WHERE ${where(key)} AND kind='external' AND status='running' RETURNING step_key`);
          if (uncertain.rows.length) {
            await tx.execute(sql`UPDATE camery_durable.tasks SET status='reconciling',owner=NULL,lease_until=NULL,available_at=NULL,error='External outcome requires reconciliation',updated_at=clock_timestamp() WHERE ${where(key)}`);
            await event(tx, key, 'reconciliation_required', { reason: 'lease_expired' }); continue;
          }
          row.failure_count += 1;
          await tx.execute(sql`UPDATE camery_durable.steps SET status='failed',error='Worker lease expired',updated_at=clock_timestamp() WHERE ${where(key)} AND status='running'`);
          await event(tx, key, 'lease_expired', { fence: row.fence });
        }
        if (row.failure_count >= row.max_attempts) {
          await tx.execute(sql`UPDATE camery_durable.tasks SET status='failed',failure_count=${row.failure_count},owner=NULL,lease_until=NULL,available_at=NULL,error='Execution failure budget exhausted',updated_at=clock_timestamp() WHERE ${where(key)}`);
          await event(tx, key, 'failed', { reason: 'failure_budget' }); continue;
        }
        if (row.status === 'waiting') {
          const resumed = await tx.execute(sql`UPDATE camery_durable.steps SET status='completed',output='null'::jsonb,updated_at=clock_timestamp() WHERE ${where(key)} AND kind='timer' AND status='waiting' AND due_at<=clock_timestamp() RETURNING step_key`);
          if (!resumed.rows.length) throw new DurableError('JOURNAL_INCOMPLETE', `Task ${row.task_id} has no due timer`);
          await event(tx, key, 'timer_elapsed');
        }
        const result = await tx.execute<TaskRow>(sql`UPDATE camery_durable.tasks SET status='running',attempts=attempts+1,fence=fence+1,owner=${workerId},lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond',available_at=NULL,failure_count=${row.failure_count},error=NULL,updated_at=clock_timestamp() WHERE ${where(key)} RETURNING *`);
        const task = toTask(result.rows[0]!);
        await event(tx, key, 'claimed', { owner: workerId, fence: task.fence });
        return { task, lease: { ...key, owner: workerId, fence: task.fence } };
      }
    });
  }
  async heartbeat(lease: Lease, leaseMs: number): Promise<void> {
    validateLease(lease); validateDuration(leaseMs, 'leaseMs');
    await this.locked(lease, async (tx, row) => {
      await this.live(tx, row, lease);
      await tx.execute(sql`UPDATE camery_durable.tasks SET lease_until=clock_timestamp()+${leaseMs}*interval '1 millisecond',updated_at=clock_timestamp() WHERE ${where(lease)}`);
    });
  }
  async openStep(lease: Lease, spec: StepSpec, dueAt?: Date): Promise<OpenStep> {
    validateLease(lease); validateStep(spec);
    if ((spec.kind === 'timer') !== (dueAt !== undefined) || (dueAt !== undefined && (!(dueAt instanceof Date) || !Number.isFinite(dueAt.getTime())))) throw new DurableError('INVALID_INPUT', 'Only timer steps require a finite dueAt');
    return this.locked(lease, async (tx, row) => {
      await this.live(tx, row, lease);
      const records = await tx.execute<StepRow>(sql`SELECT * FROM camery_durable.steps WHERE ${where(lease)} ORDER BY position`);
      const existing = records.rows.find(item => item.step_key === spec.key || item.position === spec.position);
      if (existing) {
        if (existing.step_key !== spec.key || existing.position !== spec.position || existing.kind !== spec.kind || existing.fingerprint !== spec.fingerprint || existing.idempotency_key !== spec.idempotencyKey || canonicalJson(existing.input) !== canonicalJson(spec.input)) throw new DurableError('STEP_CONFLICT', `Step ${spec.key} differs from its durable journal`);
        if (existing.status === 'completed') return { state: 'cached', output: existing.output };
        if (existing.status !== 'failed' || existing.kind === 'gate' || existing.kind === 'timer') throw new DurableError('STEP_CONFLICT', `Step ${spec.key} is already ${existing.status}`);
        await tx.execute(sql`UPDATE camery_durable.steps SET status='running',error=NULL,updated_at=clock_timestamp() WHERE ${where(lease)} AND step_key=${spec.key}`);
        await event(tx, lease, 'step_started', { key: spec.key });
        return { state: 'execute' };
      }
      if (spec.position !== records.rows.length || records.rows.some(item => item.status !== 'completed')) throw new DurableError('STEP_CONFLICT', `Step ${spec.key} must follow the completed journal`);
      let status: Step['status'] = 'running';
      if (spec.kind === 'gate') status = 'waiting';
      if (spec.kind === 'timer') {
        const clock = await tx.execute<{ due: boolean }>(sql`SELECT ${dueAt}::timestamptz<=clock_timestamp() AS due`);
        status = clock.rows[0]!.due ? 'completed' : 'waiting';
      }
      await tx.execute(sql`INSERT INTO camery_durable.steps(tenant_id,task_id,step_key,position,kind,input,fingerprint,idempotency_key,status,due_at)
        VALUES (${lease.tenantId},${lease.taskId},${spec.key},${spec.position},${spec.kind},${json(spec.input)},${spec.fingerprint},${spec.idempotencyKey},${status},${dueAt ?? null})`);
      await event(tx, lease, status === 'waiting' ? 'step_waiting' : status === 'completed' ? 'timer_elapsed' : 'step_started', { key: spec.key, kind: spec.kind });
      if (status === 'waiting') {
        await tx.execute(sql`UPDATE camery_durable.tasks SET status='waiting',owner=NULL,lease_until=NULL,available_at=${dueAt ?? null},updated_at=clock_timestamp() WHERE ${where(lease)}`);
        return { state: 'suspended' };
      }
      return status === 'completed' ? { state: 'cached', output: null } : { state: 'execute' };
    });
  }
  async completeStep(lease: Lease, key: string, output: Json): Promise<void> {
    validateLease(lease); validateName(key, 'stepKey'); validateJson(output);
    await this.locked(lease, async (tx, row) => {
      await this.live(tx, row, lease);
      const done = await tx.execute(sql`UPDATE camery_durable.steps SET status='completed',output=${json(output)},error=NULL,updated_at=clock_timestamp() WHERE ${where(lease)} AND step_key=${key} AND status='running' RETURNING step_key`);
      if (!done.rows.length) throw new DurableError('STEP_CONFLICT', `Step ${key} is not running`);
      await event(tx, lease, 'step_completed', { key });
    });
  }
  async failStep(lease: Lease, key: string, error: string, uncertain: boolean): Promise<void> {
    validateLease(lease); validateName(key, 'stepKey'); errorMessage(error);
    if (typeof uncertain !== 'boolean') throw new DurableError('INVALID_INPUT', 'uncertain must be boolean');
    await this.locked(lease, async (tx, row) => {
      await this.live(tx, row, lease);
      const result = await tx.execute<StepRow>(sql`SELECT * FROM camery_durable.steps WHERE ${where(lease)} AND step_key=${key}`);
      const current = result.rows[0];
      if (!current || current.status !== 'running' || (uncertain !== (current.kind === 'external'))) throw new DurableError('STEP_CONFLICT', `Step ${key} must preserve external uncertainty until reconciliation`);
      await tx.execute(sql`UPDATE camery_durable.steps SET status=${uncertain ? 'unknown' : 'failed'},error=${error},updated_at=clock_timestamp() WHERE ${where(lease)} AND step_key=${key}`);
      if (uncertain) await tx.execute(sql`UPDATE camery_durable.tasks SET status='reconciling',owner=NULL,lease_until=NULL,available_at=NULL,error=${error},updated_at=clock_timestamp() WHERE ${where(lease)}`);
      await event(tx, lease, uncertain ? 'reconciliation_required' : 'step_failed', { key });
    });
  }
  async finish(lease: Lease, output: Json, visitedSteps: number): Promise<void> {
    validateLease(lease); validateJson(output);
    if (!Number.isSafeInteger(visitedSteps) || visitedSteps < 0) throw new DurableError('INVALID_INPUT', 'visitedSteps must be a nonnegative integer');
    await this.locked(lease, async (tx, row) => {
      await this.live(tx, row, lease);
      const journal = await tx.execute<StepRow>(sql`SELECT * FROM camery_durable.steps WHERE ${where(lease)}`);
      if (journal.rows.length !== visitedSteps || journal.rows.some(item => item.status !== 'completed')) throw new DurableError('JOURNAL_INCOMPLETE', `Task ${lease.taskId} did not replay its complete journal`);
      await tx.execute(sql`UPDATE camery_durable.tasks SET status='succeeded',output=${json(output)},owner=NULL,lease_until=NULL,available_at=NULL,error=NULL,updated_at=clock_timestamp() WHERE ${where(lease)}`);
      await event(tx, lease, 'succeeded');
    });
  }
  async fail(lease: Lease, error: string, retryDelayMs: number): Promise<void> {
    validateLease(lease); errorMessage(error);
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 86400000) throw new DurableError('INVALID_INPUT', 'retryDelayMs must be 0–86400000 milliseconds');
    await this.locked(lease, async (tx, row) => {
      await this.live(tx, row, lease);
      const unknown = await tx.execute(sql`UPDATE camery_durable.steps SET status='unknown',error=${error},updated_at=clock_timestamp() WHERE ${where(lease)} AND kind='external' AND status IN ('running','unknown') RETURNING step_key`);
      if (unknown.rows.length) {
        await tx.execute(sql`UPDATE camery_durable.tasks SET status='reconciling',owner=NULL,lease_until=NULL,available_at=NULL,error=${error},updated_at=clock_timestamp() WHERE ${where(lease)}`);
        await event(tx, lease, 'reconciliation_required'); return;
      }
      const failures = row.failure_count + 1;
      const status = failures >= row.max_attempts ? 'failed' : 'queued';
      await tx.execute(sql`UPDATE camery_durable.steps SET status='failed',error=${error},updated_at=clock_timestamp() WHERE ${where(lease)} AND status='running'`);
      await tx.execute(sql`UPDATE camery_durable.tasks SET status=${status},failure_count=${failures},owner=NULL,lease_until=NULL,available_at=CASE WHEN ${status}='queued' THEN clock_timestamp()+${retryDelayMs}*interval '1 millisecond' ELSE NULL END,error=${error},updated_at=clock_timestamp() WHERE ${where(lease)}`);
      await event(tx, lease, status === 'queued' ? 'retry_scheduled' : 'failed', { failures });
    });
  }
  async cancel(key: TaskKey, actorId: string): Promise<void> {
    validateKey(key); validateActor(actorId);
    await this.locked(key, async (tx, row) => {
      if (row.status === 'cancelled') return;
      if (row.status === 'succeeded' || row.status === 'failed') throw new DurableError('TERMINAL_TASK', `Task ${key.taskId} is already ${row.status}`);
      await tx.execute(sql`UPDATE camery_durable.steps SET status=CASE WHEN kind='external' THEN 'unknown' ELSE 'failed' END,error='Task cancelled',updated_at=clock_timestamp() WHERE ${where(key)} AND status IN ('running','waiting')`);
      await tx.execute(sql`UPDATE camery_durable.tasks SET status='cancelled',owner=NULL,lease_until=NULL,available_at=NULL,error='Task cancelled',updated_at=clock_timestamp() WHERE ${where(key)}`);
      await event(tx, key, 'cancelled', { actorId });
    });
  }
  async signal(input: SignalInput): Promise<void> {
    validateSignal(input);
    await this.locked(input, async (tx, row) => {
      const prior = await tx.execute<{ actor_id: string; step_key: string; value: Json }>(sql`SELECT actor_id,step_key,value FROM camery_durable.signals WHERE ${where(input)} AND signal_id=${input.signalId}`);
      const previous = prior.rows[0];
      if (previous) {
        if (previous.actor_id !== input.actorId || previous.step_key !== input.gateKey || canonicalJson(previous.value) !== canonicalJson(input.value)) throw new DurableError('SIGNAL_CONFLICT', `Signal ${input.signalId} already has different content`);
        return;
      }
      const gate = await tx.execute<StepRow>(sql`SELECT * FROM camery_durable.steps WHERE ${where(input)} AND step_key=${input.gateKey}`);
      if (row.status !== 'waiting' || gate.rows[0]?.kind !== 'gate' || gate.rows[0].status !== 'waiting') throw new DurableError('GATE_NOT_WAITING', `Gate ${input.gateKey} is not waiting`);
      await tx.execute(sql`INSERT INTO camery_durable.signals(tenant_id,task_id,signal_id,step_key,actor_id,value) VALUES (${input.tenantId},${input.taskId},${input.signalId},${input.gateKey},${input.actorId},${json(input.value)})`);
      await tx.execute(sql`UPDATE camery_durable.steps SET status='completed',output=${json(input.value)},updated_at=clock_timestamp() WHERE ${where(input)} AND step_key=${input.gateKey}`);
      await tx.execute(sql`UPDATE camery_durable.tasks SET status='queued',available_at=clock_timestamp(),updated_at=clock_timestamp() WHERE ${where(input)}`);
      await event(tx, input, 'gate_signalled', { actorId: input.actorId, signalId: input.signalId, key: input.gateKey });
    });
  }
  async reconcile(input: ReconcileInput): Promise<void> {
    validateReconcile(input);
    await this.locked(input, async (tx, row) => {
      const result = await tx.execute<StepRow>(sql`SELECT * FROM camery_durable.steps WHERE ${where(input)} AND step_key=${input.stepKey}`);
      const step = result.rows[0];
      if ((row.status !== 'reconciling' && row.status !== 'cancelled') || step?.status !== 'unknown' || step.kind !== 'external') throw new DurableError('NOT_UNCERTAIN', `Step ${input.stepKey} does not have an unknown external outcome`);
      const resolution = input.resolution;
      await tx.execute(sql`UPDATE camery_durable.steps SET status=${resolution.kind === 'completed' ? 'completed' : 'failed'},output=${json(resolution.kind === 'completed' ? resolution.output : null)},error=${resolution.kind === 'retry' ? resolution.reason : null},updated_at=clock_timestamp() WHERE ${where(input)} AND step_key=${input.stepKey}`);
      if (row.status !== 'cancelled') await tx.execute(sql`UPDATE camery_durable.tasks SET status='queued',available_at=clock_timestamp(),error=NULL,updated_at=clock_timestamp() WHERE ${where(input)}`);
      await event(tx, input, 'reconciled', { actorId: input.actorId, key: input.stepKey, resolution });
    });
  }
}

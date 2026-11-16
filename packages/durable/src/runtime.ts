import { createHash } from 'node:crypto';
import { DurableError } from './types.js';
import type { ClaimedTask, DurableStore, Json, StepKind, StepSpec, Task, TaskKey } from './types.js';
import { canonicalJson, validateDate, validateDuration, validateJson, validateKey, validateLease, validateName } from './validation.js';

export interface EffectOptions { kind: 'replayable' | 'external'; input: Json; timeoutMs?: number }
export interface EffectContext { input: Json; idempotencyKey: string; signal: AbortSignal }
export interface WorkflowContext {
  readonly task: Readonly<TaskKey>;
  readonly signal: AbortSignal;
  step(key: string, options: EffectOptions, effect: (context: EffectContext) => Promise<Json>): Promise<Json>;
  waitForSignal(key: string, input?: Json): Promise<Json>;
  sleepUntil(key: string, at: Date): Promise<Json>;
}
export interface Workflow { name: string; version: number; run(input: Json, context: WorkflowContext): Promise<Json> }
export interface WorkerOptions { leaseMs?: number; runTimeoutMs?: number; retryDelayMs?: number; maxSteps?: number }
class Suspended extends Error {}
const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Shared with adapters so restored receipts can be checked without executing an effect. */
export function stepIdempotencyKey(task: TaskKey, key: string): string {
  validateName(task.tenantId, 'tenant ID'); validateName(task.taskId, 'task ID'); validateName(key, 'step key');
  return `camery_${hash({ tenantId: task.tenantId, taskId: task.taskId, key })}`;
}
const isLeaseLost = (error: unknown): boolean => error instanceof DurableError && error.code === 'LEASE_LOST';
// User callbacks may throw credential-bearing provider errors; persist only our codes, never arbitrary messages/stacks.
function diagnostic(error: unknown, context: string): string {
  return error instanceof DurableError ? `${context}: ${error.code}` : `${context}: WORKFLOW_FAILED`;
}
async function interrupted<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return execute(); }), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
function workflowKey(name: string, version: number): string {
  validateName(name, 'workflow name');
  if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647) throw new DurableError('INVALID_INPUT', 'Workflow needs a positive version');
  return `${name}:${version}`;
}

/** Single task attempt. Scheduling processes call runOne; the journal, not this process, owns durable state. */
export class DurableWorker {
  private readonly workflows = new Map<string, Workflow>();
  private readonly leaseMs: number;
  private readonly runTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxSteps: number;
  constructor(private readonly store: DurableStore, options: WorkerOptions = {}) {
    this.leaseMs = options.leaseMs ?? 30_000; this.runTimeoutMs = options.runTimeoutMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 1000; this.maxSteps = options.maxSteps ?? 1000;
    validateDuration(this.leaseMs, 'lease duration'); validateDuration(this.runTimeoutMs, 'run deadline'); validateDuration(this.retryDelayMs, 'retry delay');
    if (this.leaseMs < 30 || !Number.isInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 10_000) throw new DurableError('INVALID_INPUT', 'Lease must be at least 30ms; maxSteps must be 1..10000');
  }
  register(workflow: Workflow): void {
    const key = workflowKey(workflow.name, workflow.version);
    if (typeof workflow.run !== 'function') throw new DurableError('INVALID_INPUT', 'Workflow needs a handler');
    if (this.workflows.has(key)) throw new DurableError('WORKFLOW_EXISTS', `Workflow ${key} already registered`);
    this.workflows.set(key, { ...workflow });
  }
  hasWorkflow(name: string, version: number): boolean { return this.workflows.has(workflowKey(name, version)); }
  async runOne(tenantId: string, workerId: string): Promise<Task | null> {
    validateName(tenantId, 'tenant ID'); validateName(workerId, 'worker ID');
    const claimed = await this.store.claim(tenantId, workerId, this.leaseMs);
    if (!claimed) return null;
    return this.runClaimed(claimed);
  }
  /** Exact dispatch must never fall back to another queued task, including after target reconciliation. */
  async runTask(input: TaskKey, workerId: string): Promise<Task | null> {
    validateKey(input); const key = Object.freeze({ tenantId: input.tenantId, taskId: input.taskId }); validateName(workerId, 'worker ID');
    // oxlint-disable-next-line typescript/unbound-method -- The validated method is invoked with this.store via call below.
    const claimTask = this.store.claimTask;
    if (typeof claimTask !== 'function') throw new DurableError('STORE_CAPABILITY', 'Store does not support exact task claiming');
    const result = await claimTask.call(this.store, key, workerId, this.leaseMs); if (!result) return null;
    let claimed: ClaimedTask;
    try {
      claimed = { task: { ...result.task, input: validateJson(result.task.input) }, lease: { ...result.lease } };
      validateKey(claimed.task); validateLease(claimed.lease);
      if (claimed.task.tenantId !== key.tenantId || claimed.task.taskId !== key.taskId || claimed.lease.tenantId !== key.tenantId || claimed.lease.taskId !== key.taskId
        || claimed.lease.owner !== workerId || claimed.task.owner !== workerId || claimed.task.fence !== claimed.lease.fence || claimed.task.status !== 'running') throw new Error();
    } catch { throw new DurableError('STORE_PROTOCOL', 'Exact task claim did not match the requested identity and lease'); }
    return this.runClaimed(claimed);
  }
  private async runClaimed(claimed: ClaimedTask): Promise<Task | null> {
    const { task, lease } = claimed;
    const controller = new AbortController(); let stopped = false; let unknown = false; let cursor = 0; let busy = false;
    let heartbeatTimer: ReturnType<typeof setTimeout>;
    const heartbeat = async (): Promise<void> => {
      try { await this.store.heartbeat(lease, this.leaseMs); }
      catch (error) { controller.abort(error); }
      if (!stopped && !controller.signal.aborted) heartbeatTimer = setTimeout(() => { void heartbeat(); }, Math.floor(this.leaseMs / 3));
    };
    heartbeatTimer = setTimeout(() => { void heartbeat(); }, Math.floor(this.leaseMs / 3));
    const deadline = setTimeout(() => controller.abort(new DurableError('RUN_TIMEOUT', `Workflow ${task.workflow} exceeded its deadline`)), this.runTimeoutMs);
    const keys = new Set<string>();
    const open = async (key: string, kind: StepKind, input: Json, execute?: (spec: StepSpec) => Promise<Json>, at?: Date): Promise<Json> => {
      controller.signal.throwIfAborted(); validateName(key, 'step key');
      if (busy) throw new DurableError('PARALLEL_STEP', 'A workflow must await each step before starting another');
      if (keys.has(key)) throw new DurableError('DUPLICATE_STEP', `Step ${key} already visited`);
      if (cursor >= this.maxSteps) throw new DurableError('STEP_LIMIT', 'Workflow exceeded its step limit');
      busy = true; keys.add(key);
      const spec: StepSpec = { key, kind, input: validateJson(input), position: cursor++, fingerprint: hash({ kind, input }),
        idempotencyKey: stepIdempotencyKey(task, key) };
      try {
        const state = await this.store.openStep(lease, spec, at);
        controller.signal.throwIfAborted();
        if (state.state === 'cached') return validateJson(state.output);
        if (state.state === 'suspended') throw new Suspended();
        if (!execute) throw new DurableError('STORE_PROTOCOL', `Waiting step ${key} cannot execute an effect`);
        try {
          const output = validateJson(await execute(spec));
          controller.signal.throwIfAborted();
          await this.store.completeStep(lease, key, output);
          return validateJson(output);
        } catch (error) {
          if (!isLeaseLost(error) && !isLeaseLost(controller.signal.reason)) {
            await this.store.failStep(lease, key, diagnostic(error, `Step ${key}`), kind === 'external');
            unknown = kind === 'external';
          }
          throw error;
        }
      } finally { busy = false; }
    };
    // Observe each operation internally as well as returning its original rejection to callers who await it.
    // A malformed handler that forgets await must not terminate the worker through an unhandled rejection.
    const tracked = (execute: () => Promise<Json>): Promise<Json> => {
      let promise: Promise<Json>;
      try { promise = execute(); } catch (error) { promise = Promise.reject(error); }
      void promise.catch(error => { controller.abort(error); });
      return promise;
    };
    const context: WorkflowContext = {
      task: Object.freeze({ tenantId: task.tenantId, taskId: task.taskId }),
      signal: controller.signal,
      step: (key, options, effect) => tracked(async () => {
        if (!['replayable', 'external'].includes(options.kind)) return Promise.reject(new DurableError('INVALID_INPUT', 'Effect kind must be replayable or external'));
        const timeoutMs = options.timeoutMs ?? this.runTimeoutMs;
        validateDuration(timeoutMs, 'step deadline');
        return open(key, options.kind, options.input, async spec => {
          const stepController = new AbortController();
          const abort = (): void => stepController.abort(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
          const timeout = setTimeout(() => stepController.abort(new DurableError('STEP_TIMEOUT', `Step ${key} exceeded its deadline`)), timeoutMs);
          try { return await interrupted(stepController.signal, () => effect({ input: validateJson(spec.input), idempotencyKey: spec.idempotencyKey, signal: stepController.signal })); }
          finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); }
        });
      }),
      waitForSignal: (key, input = null) => tracked(() => open(key, 'gate', input)),
      sleepUntil: (key, at) => tracked(() => { validateDate(at, 'timer deadline'); return open(key, 'timer', at.toISOString(), undefined, new Date(at)); }),
    };
    try {
      const workflow = this.workflows.get(`${task.workflow}:${task.version}`);
      if (!workflow) throw new DurableError('WORKFLOW_UNAVAILABLE', `No handler for ${task.workflow}:${task.version}`);
      const output = validateJson(await interrupted(controller.signal, () => workflow.run(validateJson(task.input), context)));
      controller.signal.throwIfAborted();
      if (busy) throw new DurableError('UNAWAITED_STEP', 'Workflow returned before its active step finished');
      await this.store.finish(lease, output, cursor);
    } catch (error) {
      if (!(error instanceof Suspended) && !unknown && !isLeaseLost(error) && !isLeaseLost(controller.signal.reason)) {
        controller.abort(error);
        try { await this.store.fail(lease, diagnostic(error, `Workflow ${task.workflow}:${task.version}`), this.retryDelayMs); }
        catch (failure) { if (!isLeaseLost(failure)) throw failure; }
      }
    } finally {
      stopped = true; clearTimeout(heartbeatTimer); clearTimeout(deadline);
      controller.abort(new DurableError('RUN_STOPPED', 'Task attempt has stopped'));
    }
    return this.store.get(lease);
  }
}

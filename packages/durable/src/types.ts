export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface TaskKey { tenantId: string; taskId: string }
export interface EnqueueTask extends TaskKey {
  workflow: string; version: number; input: Json; maxAttempts: number; availableAt: Date;
}
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
export interface Task extends Omit<EnqueueTask, 'availableAt'> {
  availableAt: Date | null;
  status: TaskStatus; attempts: number; fence: number; owner: string | null; leaseUntil: Date | null;
  output: Json; error: string | null;
}
export interface Lease extends TaskKey { owner: string; fence: number }
export interface ClaimedTask { task: Task; lease: Lease }
export type StepKind = 'replayable' | 'external' | 'gate' | 'timer';
export interface StepSpec {
  key: string; position: number; kind: StepKind; input: Json; fingerprint: string; idempotencyKey: string;
}
export type StepStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'unknown';
export interface Step extends StepSpec { status: StepStatus; output: Json; error: string | null; dueAt: Date | null }
export type OpenStep = { state: 'cached'; output: Json } | { state: 'execute' } | { state: 'suspended' };
export interface Event { action: string; detail: Json }
export interface SignalInput extends TaskKey { gateKey: string; signalId: string; value: Json; actorId: string }
export interface ReconcileInput extends TaskKey {
  stepKey: string; actorId: string; resolution: { kind: 'completed'; output: Json } | { kind: 'retry'; reason: string };
}
/** Internal trusted-host persistence boundary; public APIs must authenticate tenant and human actors separately. */
export interface DurableStore {
  enqueue(input: EnqueueTask): Promise<Task>;
  get(key: TaskKey): Promise<Task | null>;
  steps(key: TaskKey): Promise<Step[]>;
  events(key: TaskKey): Promise<Event[]>;
  claim(tenantId: string, workerId: string, leaseMs: number): Promise<ClaimedTask | null>;
  heartbeat(lease: Lease, leaseMs: number): Promise<void>;
  openStep(lease: Lease, spec: StepSpec, dueAt?: Date): Promise<OpenStep>;
  completeStep(lease: Lease, key: string, output: Json): Promise<void>;
  failStep(lease: Lease, key: string, error: string, uncertain: boolean): Promise<void>;
  finish(lease: Lease, output: Json, visitedSteps: number): Promise<void>;
  fail(lease: Lease, error: string, retryDelayMs: number): Promise<void>;
  cancel(key: TaskKey, actorId: string): Promise<void>;
  signal(input: SignalInput): Promise<void>;
  reconcile(input: ReconcileInput): Promise<void>;
}
export class DurableError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'DurableError'; }
}

import { z } from 'zod';
import { DurableError } from '@camery/durable';
import type { DurableStore, Task, TaskKey } from '@camery/durable';
import { canonical, digest, freeze } from '@camery/methods';
import { AgentError, Name } from './registry.js';
import { validateAgentTask, validateTaskTree } from './collaboration.js';
import { AgentPersistenceError, persistenceData, TreeKeySchema, validateTaskTreeDefinition } from './task-service.js';
import type { LogicalTaskKey, StoredTask, StoredTaskTree, TaskTreeKey } from './task-service.js';
import { relayOutbox, validateOutboxItem } from './relay.js';
import type { OutboxRelayResult, OutboxRepository } from './relay.js';
import { synchronous } from './trusted-callbacks.js';

export interface AgentHostStore extends OutboxRepository {
  tree(key: TaskTreeKey): Promise<StoredTaskTree>;
  syncTask(key: LogicalTaskKey): Promise<StoredTask>;
  queueReady(key: TaskTreeKey): Promise<string[]>;
}
export interface AgentHostWorker {
  hasWorkflow(name: string, version: number): boolean;
  runTask(key: TaskKey, workerId: string): Promise<Task | null>;
}
type RelayStore = Pick<DurableStore, 'enqueue' | 'signal' | 'get' | 'steps'>;
export interface AgentHostOptions {
  tree: TaskTreeKey; workerId: string; collaboration: AgentHostStore; durable: RelayStore; worker: AgentHostWorker;
  maxTasksPerTick?: number; maxExecutionsPerTick?: number; outboxLimit?: number; pollIntervalMs?: number;
}
export interface AgentHostTick {
  tree: TaskTreeKey; state: 'active' | 'waiting' | 'complete' | 'blocked'; queued: string[]; relay: OutboxRelayResult;
  executed: { taskId: string; status: Task['status'] }[];
  tasks: { taskId: string; durableTaskId: string | null; status: StoredTask['task']['status']; revision: number }[];
  blockedTaskIds: string[];
}
const Configuration = z.strictObject({ tree: TreeKeySchema, workerId: Name, maxTasksPerTick: z.int().min(1).max(1000).default(25), maxExecutionsPerTick: z.int().min(1).max(100).default(10), outboxLimit: z.int().min(1).max(100).default(100), pollIntervalMs: z.int().min(50).max(60000).default(1000) });
const Snapshot = z.strictObject({ task: z.unknown(), treeId: Name, revision: z.int().min(0).max(Number.MAX_SAFE_INTEGER), durableTaskId: Name.nullable() });
const terminal = (status: string): boolean => ['succeeded', 'failed', 'cancelled'].includes(status);
const active = (signal?: AbortSignal): void => { if (signal?.aborted) throw new AgentError('AGENT_HOST_ABORTED'); };
function pause(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise(resolve => { const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, milliseconds); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done(); });
}
function safeFailure(error: unknown): never {
  const code = (error instanceof AgentError || error instanceof AgentPersistenceError || error instanceof DurableError) && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'AGENT_HOST_FAILED';
  throw new AgentError(code);
}
/** Scoped trusted-host coordinator. It never claims tenant-wide work or chooses a role/provider. */
export class AgentDispatchHost {
  private readonly config: z.infer<typeof Configuration>;
  private readonly store: AgentHostStore; private readonly durable: RelayStore; private readonly worker: AgentHostWorker;
  private busy = false; private running = false; private syncCursor = 0; private runCursor = 0; private definitionDigest: string | undefined;
  constructor(options: AgentHostOptions) {
    this.config = persistenceData(Configuration, { tree: options.tree, workerId: options.workerId, ...(options.maxTasksPerTick !== undefined ? { maxTasksPerTick: options.maxTasksPerTick } : {}), ...(options.maxExecutionsPerTick !== undefined ? { maxExecutionsPerTick: options.maxExecutionsPerTick } : {}), ...(options.outboxLimit !== undefined ? { outboxLimit: options.outboxLimit } : {}), ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}) });
    try {
      const capture = <T extends object>(object: T, names: readonly (keyof T)[]): T => Object.fromEntries(names.map(name => { const method = object[name]; if (typeof method !== 'function') throw new Error(); return [name, method.bind(object)]; })) as T;
      this.store = capture(options.collaboration, ['tree', 'syncTask', 'queueReady', 'pending', 'acknowledge']); this.durable = capture(options.durable, ['enqueue', 'signal', 'get', 'steps']); this.worker = capture(options.worker, ['hasWorkflow', 'runTask']);
    } catch { throw new AgentError('INVALID_AGENT_HOST'); }
  }
  private physical(taskId: string): string { return `agent_${digest({ ...this.config.tree, taskId })}`; }
  private logical(taskId: string): LogicalTaskKey { return { tenantId: this.config.tree.tenantId, projectId: this.config.tree.projectId, taskId }; }
  private async tree(signal?: AbortSignal): Promise<StoredTaskTree> {
    active(signal); const raw = await this.store.tree(this.config.tree); active(signal);
    const value = persistenceData(z.strictObject({ definition: z.unknown(), tasks: z.array(Snapshot).min(1).max(1000) }), raw); const definition = validateTaskTreeDefinition(value.definition as StoredTaskTree['definition']);
    if (canonical({ tenantId: definition.tenantId, projectId: definition.projectId, treeId: definition.treeId }) !== canonical(this.config.tree) || value.tasks.length !== definition.tasks.length) throw new AgentError('AGENT_HOST_SCOPE');
    const tasks = definition.tasks.map(initial => {
      const rows = value.tasks.filter(row => (row.task as { taskId?: unknown } | null)?.taskId === initial.taskId); const row = rows[0];
      if (rows.length !== 1 || !row) throw new AgentError('AGENT_HOST_SNAPSHOT'); const task = validateAgentTask(row.task);
      const { status: _status, output: _output, errorCode: _error, ...body } = task; const { status: _initialStatus, ...initialBody } = initial;
      if (canonical(body) !== canonical(initialBody) || row.treeId !== this.config.tree.treeId || (row.durableTaskId !== null && row.durableTaskId !== this.physical(task.taskId))) throw new AgentError('AGENT_HOST_SNAPSHOT');
      return { ...row, task };
    });
    validateTaskTree(tasks.map(item => item.task)); const hash = digest(definition); if (this.definitionDigest !== undefined && hash !== this.definitionDigest) throw new AgentError('AGENT_HOST_DEFINITION_CHANGED');
    for (const route of definition.routes) if (synchronous(this.worker.hasWorkflow(route.workflow, route.version)) !== true) throw new AgentError('AGENT_HOST_WORKFLOW');
    this.definitionDigest = hash; return freeze({ definition, tasks });
  }
  private batch(tasks: StoredTask[], cursor: 'syncCursor' | 'runCursor'): StoredTask[] {
    if (!tasks.length) return []; const offset = this[cursor] % tasks.length; const length = Math.min(tasks.length, this.config.maxTasksPerTick); this[cursor] = (offset + length) % tasks.length;
    return Array.from({ length }, (_unused, index) => tasks[(offset + index) % tasks.length]!);
  }
  private result(tree: StoredTaskTree, queued: string[], relay: OutboxRelayResult, executed: AgentHostTick['executed']): AgentHostTick {
    const blocked = new Set(tree.tasks.filter(item => ['failed', 'cancelled'].includes(item.task.status)).map(item => item.task.taskId));
    for (let changed = true; changed;) { changed = false; for (const item of tree.tasks) if (!terminal(item.task.status) && !blocked.has(item.task.taskId) && item.task.dependencies.some(id => blocked.has(id))) { blocked.add(item.task.taskId); changed = true; } }
    const remaining = tree.tasks.filter(item => !terminal(item.task.status) && !blocked.has(item.task.taskId));
    const state = tree.tasks.every(item => item.task.status === 'succeeded') ? 'complete' : remaining.length === 0 ? 'blocked' : remaining.some(item => item.task.status === 'queued' && item.task.dependencies.every(id => tree.tasks.some(parent => parent.task.taskId === id && parent.task.status === 'succeeded'))) ? 'active' : 'waiting';
    return freeze({ tree: this.config.tree, state, queued, relay, executed, tasks: tree.tasks.map(item => ({ taskId: item.task.taskId, durableTaskId: item.durableTaskId, status: item.task.status, revision: item.revision })), blockedTaskIds: [...blocked] });
  }
  private async perform(signal?: AbortSignal): Promise<AgentHostTick> {
    const initial = await this.tree(signal);
    for (const item of this.batch(initial.tasks.filter(item => item.durableTaskId !== null && !terminal(item.task.status)), 'syncCursor')) { active(signal); await this.store.syncTask(this.logical(item.task.taskId)); }
    active(signal); const queued = persistenceData(z.array(Name).max(1000), await this.store.queueReady(this.config.tree)); active(signal);
    const physicalIds = new Set(initial.definition.tasks.map(item => this.physical(item.taskId)));
    const repository: OutboxRepository = { pending: async (scope, limit) => (await this.store.pending(scope, limit)).map(item => validateOutboxItem(item, scope)).filter(item => physicalIds.has(item.payload.taskId)), acknowledge: (...args) => this.store.acknowledge(...args) };
    const relay = await relayOutbox(repository, this.durable, { tenantId: this.config.tree.tenantId, projectId: this.config.tree.projectId }, this.config.outboxLimit); active(signal);
    const ready = await this.tree(signal); const executed: AgentHostTick['executed'] = [];
    const candidates = ready.tasks.filter(item => item.durableTaskId !== null && !terminal(item.task.status));
    for (const item of this.batch(candidates, 'runCursor')) {
      active(signal); if (executed.length >= this.config.maxExecutionsPerTick) break;
      // A smaller execution budget must resume after the last inspected item, not skip the unvisited batch tail.
      this.runCursor = (candidates.indexOf(item) + 1) % candidates.length;
      const key = { tenantId: this.config.tree.tenantId, taskId: item.durableTaskId! }; const task = await this.durable.get(key); active(signal); if (!task) continue;
      const route = ready.definition.routes.find(route => canonical(route.agent) === canonical(item.task.agent))!;
      if (task.tenantId !== key.tenantId || task.taskId !== key.taskId || task.workflow !== route.workflow || task.version !== route.version || task.maxAttempts !== route.maxAttempts || canonical(task.input) !== canonical(item.task.input)) throw new AgentError('AGENT_HOST_JOB_CONFLICT');
      const result = await this.worker.runTask(key, this.config.workerId);
      if (result !== null) { if (result.tenantId !== key.tenantId || result.taskId !== key.taskId || !['queued', 'running', 'waiting', 'reconciling', 'succeeded', 'failed', 'cancelled'].includes(result.status)) throw new AgentError('AGENT_HOST_WORKER_CONFLICT'); executed.push({ taskId: item.task.taskId, status: result.status }); }
      active(signal); await this.store.syncTask(this.logical(item.task.taskId));
    }
    return this.result(await this.tree(signal), queued, relay, executed);
  }
  async tick(signal?: AbortSignal): Promise<AgentHostTick> {
    if (this.busy || this.running) throw new AgentError('AGENT_HOST_BUSY'); this.busy = true;
    try { return await this.perform(signal); } catch (error) { return safeFailure(error); } finally { this.busy = false; }
  }
  /** Abort stops new claims and polling. In-flight attempts drain under their own durable timeout/lease. */
  async run(signal: AbortSignal): Promise<{ reason: 'complete' | 'blocked' | 'aborted'; last: AgentHostTick | null }> {
    if (!(signal instanceof AbortSignal)) throw new AgentError('INVALID_AGENT_HOST'); if (this.busy || this.running) throw new AgentError('AGENT_HOST_BUSY'); this.running = true; let last: AgentHostTick | null = null;
    try { while (!signal.aborted) { last = await this.perform(signal); if (last.state === 'complete' || last.state === 'blocked') return { reason: last.state, last }; await pause(signal, this.config.pollIntervalMs); } return { reason: 'aborted', last }; }
    catch (error) { if (signal.aborted) return { reason: 'aborted', last }; return safeFailure(error); } finally { this.running = false; }
  }
}

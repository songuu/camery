import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { canonical, digest, freeze, jsonCopy, Pin } from '@camery/methods';
import type { Json } from '@camery/durable';
import { AgentRegistry, Name } from '../registry.js';
import { createIssue, createQuestion, submitQuestionAnswer, transitionTask, validateAgentTask, validateTaskTree } from '../collaboration.js';
import type { AgentIssue, AgentQuestion, QuestionInput } from '../collaboration.js';
import { AgentPersistenceError, persistenceData, TaskKeySchema, TreeKeySchema, validateTaskTreeDefinition } from '../task-service.js';
import type { LogicalTaskKey, StoredTask, StoredTaskTree, TaskTreeDefinition, TaskTreeKey } from '../task-service.js';
import { createOutboxItem, OutboxScopeSchema, validateOutboxItem } from '../relay.js';
import type { OutboxItem, OutboxRepository, OutboxScope } from '../relay.js';
import type { CollaborationTransaction, CollaborationTransactions, StoredQuestion } from './collaboration-types.js';
type Job = Extract<OutboxItem, { kind: 'enqueue' }>['payload'];
type TaskRow = { task_id: string; tree_id: string; record: unknown; revision: string; durable_task_id: string | null; job: Job | null };
type QuestionRow = { record: unknown; question_digest: string; gate_key: string | null; durable_task_id: string | null; gate_input_digest: string | null; outbox_id: string | null; delivered: boolean | null };
type PhysicalTask = { tenant_id: string; task_id: string; workflow: string; version: number; input: Json; output: Json; status: string; max_attempts: number; enqueue_at: Date };
const stateFree = (task: ReturnType<typeof validateAgentTask>): unknown => { const { status: _status, output: _output, errorCode: _errorCode, ...body } = task; return body; };
const number = (value: string): number => persistenceData(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), Number(value));
const terminal = (state: string): boolean => ['succeeded', 'failed', 'cancelled'].includes(state);
/** Internal project-scoped blackboard. Queue/signal commands leave the transaction only via the outbox relay. */
export class PostgresCollaborationStore implements CollaborationTransactions, OutboxRepository {
  constructor(private readonly pool: Pool, private readonly agents: AgentRegistry) {}
  private async transaction<T>(scope: OutboxScope, run: (client: PoolClient) => Promise<T>, create = false): Promise<T> {
    let client: PoolClient; try { client = await this.pool.connect(); } catch { throw new AgentPersistenceError('AGENT_STORAGE_FAILED'); }
    try {
      await client.query('BEGIN');
      if (create) await client.query('INSERT INTO camery_agents.agent_projects(tenant_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [scope.tenantId, scope.projectId]);
      const locked = await client.query('SELECT 1 FROM camery_agents.agent_projects WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE', [scope.tenantId, scope.projectId]);
      if (!locked.rows.length) throw new AgentPersistenceError('AGENT_PROJECT_NOT_FOUND');
      const result = await run(client); await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { throw new AgentPersistenceError('AGENT_STORAGE_FAILED'); }
      if (error instanceof AgentPersistenceError) throw error;
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)) throw new AgentPersistenceError(error.code);
      throw new AgentPersistenceError('AGENT_STORAGE_FAILED');
    } finally { client.release(); }
  }
  private async event(client: PoolClient, scope: OutboxScope, taskId: string | null, action: string, detail: Json): Promise<void> {
    const result = await client.query('INSERT INTO camery_agents.agent_events(tenant_id,project_id,task_id,action,detail) VALUES($1,$2,$3,$4,$5::jsonb)', [scope.tenantId, scope.projectId, taskId, action, canonical(detail)]);
    if (result.rowCount !== 1) throw new AgentPersistenceError('AGENT_WRITE_FAILED');
  }
  private async treeTx(client: PoolClient, key: TaskTreeKey): Promise<StoredTaskTree & { rows: TaskRow[] }> {
    const saved = await client.query<{ definition: TaskTreeDefinition; definition_digest: string }>('SELECT definition,definition_digest FROM camery_agents.agent_trees WHERE tenant_id=$1 AND project_id=$2 AND tree_id=$3', [key.tenantId, key.projectId, key.treeId]);
    const header = saved.rows[0]; if (!header) throw new AgentPersistenceError('TASK_TREE_NOT_FOUND');
    const definition = validateTaskTreeDefinition(header.definition);
    if (digest(definition) !== header.definition_digest || definition.tenantId !== key.tenantId || definition.projectId !== key.projectId || definition.treeId !== key.treeId) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT');
    const result = await client.query<TaskRow>('SELECT task_id,tree_id,record,revision,durable_task_id,job FROM camery_agents.agent_tasks WHERE tenant_id=$1 AND project_id=$2 AND tree_id=$3', [key.tenantId, key.projectId, key.treeId]);
    if (result.rows.length !== definition.tasks.length) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT');
    const tasks = definition.tasks.map(initial => {
      const row = result.rows.find(value => value.task_id === initial.taskId); if (!row) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT');
      const task = validateAgentTask(row.record); this.agents.resolve(task.agent);
      if (canonical(stateFree(task)) !== canonical(stateFree(initial)) || (task.status === 'succeeded' && !this.agents.validateOutput(task.agent, task.output!))) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT');
      if (row.job !== null) {
        const route = definition.routes.find(value => canonical(value.agent) === canonical(task.agent))!; const physical = `agent_${digest({ ...key, taskId: task.taskId })}`;
        const encoded = createOutboxItem({ tenantId: key.tenantId, projectId: key.projectId, outboxId: `enqueue_${digest({ ...key, taskId: task.taskId })}`, kind: 'enqueue', payload: row.job });
        if (row.durable_task_id !== physical || encoded.payload.taskId !== physical || encoded.payload.tenantId !== key.tenantId || encoded.payload.workflow !== route.workflow || encoded.payload.version !== route.version || encoded.payload.maxAttempts !== route.maxAttempts || canonical(encoded.payload.input) !== canonical(task.input)) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT');
      } else if (row.durable_task_id !== null) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT');
      return { task, treeId: row.tree_id, revision: number(row.revision), durableTaskId: row.durable_task_id };
    });
    validateTaskTree(tasks.map(value => value.task)); return freeze({ definition, tasks, rows: result.rows });
  }
  private async taskTx(client: PoolClient, key: LogicalTaskKey): Promise<{ snapshot: StoredTask; row: TaskRow; tree: StoredTaskTree }> {
    const result = await client.query<{ tree_id: string }>('SELECT tree_id FROM camery_agents.agent_tasks WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3', [key.tenantId, key.projectId, key.taskId]);
    if (!result.rows[0]) throw new AgentPersistenceError('AGENT_TASK_NOT_FOUND');
    const tree = await this.treeTx(client, { tenantId: key.tenantId, projectId: key.projectId, treeId: result.rows[0].tree_id });
    const snapshot = tree.tasks.find(value => value.task.taskId === key.taskId)!; return { snapshot, row: tree.rows.find(value => value.task_id === key.taskId)!, tree };
  }
  async withTask<T>(supplied: LogicalTaskKey, run: (context: CollaborationTransaction) => Promise<T>): Promise<T> {
    const key = persistenceData(TaskKeySchema, supplied);
    return this.transaction(key, async client => { const saved = await this.taskTx(client, key); return run({ client, task: saved.snapshot.task, revision: saved.snapshot.revision,
      putIssue: (issue, actorId) => this.putIssueTx(client, key, saved.snapshot, issue, actorId),
      openQuestion: (question, actorId, gateKey) => this.openQuestionTx(client, key, saved.snapshot, question, actorId, gateKey),
      event: (action, detail) => this.event(client, key, key.taskId, action, detail) }); });
  }
  async createTree(supplied: TaskTreeDefinition, actor: string): Promise<StoredTaskTree> {
    const definition = validateTaskTreeDefinition(supplied); const actorId = persistenceData(Name, actor); for (const task of definition.tasks) { this.agents.resolve(task.agent); if (Buffer.byteLength(canonical(task.input)) > 1048576) throw new AgentPersistenceError('TASK_INPUT_LIMIT'); }
    return this.transaction(definition, async client => {
      const existing = await client.query<{ definition_digest: string }>('SELECT definition_digest FROM camery_agents.agent_trees WHERE tenant_id=$1 AND project_id=$2 AND tree_id=$3', [definition.tenantId, definition.projectId, definition.treeId]);
      if (existing.rows[0]) { if (existing.rows[0].definition_digest !== digest(definition)) throw new AgentPersistenceError('TASK_TREE_CONFLICT'); const tree = await this.treeTx(client, definition); return { definition: tree.definition, tasks: tree.tasks }; }
      const inserted = await client.query('INSERT INTO camery_agents.agent_trees(tenant_id,project_id,tree_id,definition,definition_digest) VALUES($1,$2,$3,$4::jsonb,$5)', [definition.tenantId, definition.projectId, definition.treeId, canonical(definition), digest(definition)]); if (inserted.rowCount !== 1) throw new AgentPersistenceError('AGENT_WRITE_FAILED');
      for (const task of definition.tasks) { const row = await client.query('INSERT INTO camery_agents.agent_tasks(tenant_id,project_id,task_id,tree_id,record) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING', [definition.tenantId, definition.projectId, task.taskId, definition.treeId, canonical(task)]); if (row.rowCount !== 1) throw new AgentPersistenceError('AGENT_TASK_CONFLICT'); }
      await this.event(client, definition, null, 'tree_created', { treeId: definition.treeId, definitionDigest: digest(definition), actorId }); const tree = await this.treeTx(client, definition); return { definition: tree.definition, tasks: tree.tasks };
    }, true);
  }
  async tree(input: TaskTreeKey): Promise<StoredTaskTree> { const key = persistenceData(TreeKeySchema, input); return this.transaction(key, async client => { const tree = await this.treeTx(client, key); return { definition: tree.definition, tasks: tree.tasks }; }); }
  async loadTask(input: LogicalTaskKey): Promise<StoredTask> { const key = persistenceData(TaskKeySchema, input); return this.transaction(key, async client => (await this.taskTx(client, key)).snapshot); }
  async assignment(input: { tenantId: string; taskId: string }): Promise<StoredTask> {
    const key = persistenceData(z.strictObject({ tenantId: Name, taskId: Name }), input);
    try { const result = await this.pool.query<{ project_id: string; task_id: string }>('SELECT project_id,task_id FROM camery_agents.agent_tasks WHERE tenant_id=$1 AND durable_task_id=$2', [key.tenantId, key.taskId]); if (!result.rows[0]) throw new AgentPersistenceError('AGENT_TASK_NOT_FOUND');
      return await this.loadTask({ tenantId: key.tenantId, projectId: result.rows[0].project_id, taskId: result.rows[0].task_id });
    } catch (error) { if (error instanceof AgentPersistenceError) throw error; throw new AgentPersistenceError('AGENT_STORAGE_FAILED'); }
  }
  private async outboxTx(client: PoolClient, item: OutboxItem): Promise<void> {
    const prior = await client.query<{ record_digest: string }>('SELECT record_digest FROM camery_agents.agent_outbox WHERE tenant_id=$1 AND project_id=$2 AND outbox_id=$3', [item.tenantId, item.projectId, item.outboxId]);
    if (prior.rows[0]) { if (prior.rows[0].record_digest !== item.digest) throw new AgentPersistenceError('OUTBOX_CONFLICT'); return; }
    const result = await client.query('INSERT INTO camery_agents.agent_outbox(tenant_id,project_id,outbox_id,kind,record,record_digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [item.tenantId, item.projectId, item.outboxId, item.kind, canonical(item), item.digest]); if (result.rowCount !== 1) throw new AgentPersistenceError('AGENT_WRITE_FAILED');
  }
  async queueReady(input: TaskTreeKey): Promise<string[]> {
    const key = persistenceData(TreeKeySchema, input);
    return this.transaction(key, async client => {
      const tree = await this.treeTx(client, key); const ids: string[] = [];
      for (const saved of tree.tasks) {
        const row = tree.rows.find(value => value.task_id === saved.task.taskId)!; const task = saved.task;
        if (task.status !== 'queued' || row.job !== null || task.dependencies.some(id => tree.tasks.find(value => value.task.taskId === id)?.task.status !== 'succeeded')) continue;
        const route = tree.definition.routes.find(value => canonical(value.agent) === canonical(task.agent))!; const physical = `agent_${digest({ ...key, taskId: task.taskId })}`; const now = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
        const item = createOutboxItem({ tenantId: key.tenantId, projectId: key.projectId, outboxId: `enqueue_${digest({ ...key, taskId: task.taskId })}`, kind: 'enqueue', payload: { tenantId: key.tenantId, taskId: physical, workflow: route.workflow, version: route.version, maxAttempts: route.maxAttempts, input: task.input, availableAt: now.rows[0]!.now.toISOString() } });
        await this.outboxTx(client, item); const updated = await client.query('UPDATE camery_agents.agent_tasks SET durable_task_id=$4,job=$5::jsonb,revision=revision+1 WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND revision=$6', [key.tenantId, key.projectId, task.taskId, physical, canonical(item.payload), saved.revision]); if (updated.rowCount !== 1) throw new AgentPersistenceError('TASK_REVISION_CONFLICT');
        await this.event(client, key, task.taskId, 'task_queued', { durableTaskId: physical, outboxId: item.outboxId }); ids.push(item.outboxId);
      }
      return ids;
    });
  }
  private sameJob(task: PhysicalTask, job: Job): boolean { return task.tenant_id === job.tenantId && task.task_id === job.taskId && task.workflow === job.workflow && task.version === job.version && task.max_attempts === job.maxAttempts && canonical(task.input) === canonical(job.input) && task.enqueue_at.toISOString() === job.availableAt; }
  async syncTask(input: LogicalTaskKey): Promise<StoredTask> {
    const key = persistenceData(TaskKeySchema, input);
    return this.transaction(key, async client => {
      const { snapshot, row, tree } = await this.taskTx(client, key); if (!row.job || !row.durable_task_id) return snapshot;
      const physical = await client.query<PhysicalTask>('SELECT tenant_id,task_id,workflow,version,input,output,status,max_attempts,enqueue_at FROM camery_durable.tasks WHERE tenant_id=$1 AND task_id=$2', [key.tenantId, row.durable_task_id]); const job = physical.rows[0]; if (!job) return snapshot;
      if (!this.sameJob(job, row.job)) throw new AgentPersistenceError('DURABLE_JOB_CONFLICT');
      let task = snapshot.task; if (task.status === 'queued') task = transitionTask(task, { status: 'running' });
      if (job.status === 'succeeded') {
        const route = tree.definition.routes.find(value => canonical(value.agent) === canonical(task.agent))!; let output: Json = job.output; let error: string | null = null;
        if (route.outputKind === 'agent_report') { const parsed = z.object({ state: z.enum(['candidate', 'blocked']), agent: Pin, output: z.json() }).safeParse(job.output);
          if (!parsed.success || canonical(parsed.data.agent) !== canonical(task.agent)) error = 'AGENT_OUTPUT_INVALID'; else if (parsed.data.state === 'blocked') error = 'AGENT_BLOCKED'; else output = parsed.data.output; }
        if (error === null && !this.agents.validateOutput(task.agent, output)) error = 'AGENT_OUTPUT_INVALID';
        if (!terminal(task.status)) { if (task.status === 'waiting') task = transitionTask(task, { status: 'running' }); task = error ? transitionTask(task, { status: 'failed', errorCode: error }) : transitionTask(task, { status: 'succeeded', output }); }
      } else if (!terminal(task.status)) {
        if (job.status === 'failed') task = transitionTask(task, { status: 'failed', errorCode: 'WORKFLOW_FAILED' }); else if (job.status === 'cancelled') task = transitionTask(task, { status: 'cancelled' });
        else if (['waiting', 'reconciling'].includes(job.status) && task.status === 'running') task = transitionTask(task, { status: 'waiting' }); else if (['queued', 'running'].includes(job.status) && task.status === 'waiting') task = transitionTask(task, { status: 'running' });
      }
      if (canonical(task) === canonical(snapshot.task)) return snapshot;
      const updated = await client.query('UPDATE camery_agents.agent_tasks SET record=$4::jsonb,revision=revision+1 WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND revision=$5', [key.tenantId, key.projectId, key.taskId, canonical(task), snapshot.revision]); if (updated.rowCount !== 1) throw new AgentPersistenceError('TASK_REVISION_CONFLICT');
      await this.event(client, key, key.taskId, 'task_synchronized', { durableTaskId: job.task_id, journalStatus: job.status, outputDigest: digest(job.output), state: task.status }); return { task, treeId: snapshot.treeId, durableTaskId: snapshot.durableTaskId, revision: snapshot.revision + 1 };
    });
  }
  private async putIssueTx(client: PoolClient, key: LogicalTaskKey, saved: StoredTask, input: AgentIssue, actor: string): Promise<void> {
    const issue = createIssue(input); const actorId = persistenceData(Name, actor);
    if (issue.taskId !== key.taskId || issue.scope.tenantId !== key.tenantId || issue.scope.projectId !== key.projectId || !saved.task.scope.objectIds.includes(issue.objectId)) throw new AgentPersistenceError('ISSUE_SCOPE');
    const prior = await client.query<{ record_digest: string }>('SELECT record_digest FROM camery_agents.agent_issues WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND issue_id=$4', [key.tenantId, key.projectId, key.taskId, issue.issueId]);
    if (prior.rows[0]) { if (prior.rows[0].record_digest !== digest(issue)) throw new AgentPersistenceError('ISSUE_CONFLICT'); return; }
    const inserted = await client.query('INSERT INTO camery_agents.agent_issues(tenant_id,project_id,task_id,issue_id,record,record_digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)', [key.tenantId, key.projectId, key.taskId, issue.issueId, canonical(issue), digest(issue)]); if (inserted.rowCount !== 1) throw new AgentPersistenceError('AGENT_WRITE_FAILED'); await this.event(client, key, key.taskId, 'issue_opened', { issueId: issue.issueId, actorId });
  }
  async putIssue(key: LogicalTaskKey, issue: AgentIssue, actorId: string): Promise<void> { const captured = jsonCopy(issue); freeze(captured); return this.withTask(key, context => context.putIssue(captured, actorId)); }
  async listIssues(key: LogicalTaskKey, options: { afterId?: string; limit?: number } = {}): Promise<{ items: AgentIssue[]; nextCursor: string | null }> {
    const page = persistenceData(z.strictObject({ afterId: Name.optional(), limit: z.int().min(1).max(100).default(100) }), options);
    return this.withTask(key, async ({ client, task }) => { const result = await client.query<{ issue_id: string; record: AgentIssue; record_digest: string }>('SELECT issue_id,record,record_digest FROM camery_agents.agent_issues WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND ($4::text IS NULL OR issue_id COLLATE "C">$4::text COLLATE "C") ORDER BY issue_id COLLATE "C" LIMIT $5', [task.scope.tenantId, task.scope.projectId, task.taskId, page.afterId ?? null, page.limit + 1]);
      const items = result.rows.slice(0, page.limit).map(row => { const issue = createIssue(row.record); if (digest(issue) !== row.record_digest || issue.issueId !== row.issue_id || issue.taskId !== task.taskId || canonical(issue.scope) !== canonical({ tenantId: task.scope.tenantId, projectId: task.scope.projectId }) || !task.scope.objectIds.includes(issue.objectId)) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT'); return issue; }); return freeze({ items, nextCursor: result.rows.length > page.limit ? items.at(-1)!.issueId : null });
    });
  }
  private question(row: QuestionRow, key: LogicalTaskKey): StoredQuestion {
    const data = row.record as AgentQuestion; const opened = createQuestion({ questionId: data.questionId, taskId: data.taskId, scope: data.scope, objectIds: data.objectIds, prompt: data.prompt, choices: data.choices });
    const expected = data.status === 'answered' && data.answer ? submitQuestionAnswer(opened, { ...data.scope, actorId: data.answer.actorId }, data.answer.value, opened.questionDigest) : opened;
    if (data.taskId !== key.taskId || data.scope.tenantId !== key.tenantId || data.scope.projectId !== key.projectId || canonical(expected) !== canonical(data) || row.question_digest !== opened.questionDigest || ((row.gate_key !== null) !== (row.durable_task_id !== null && row.gate_input_digest === digest(opened)))) throw new AgentPersistenceError('COLLABORATION_DATA_CORRUPT');
    return freeze({ question: expected, gateKey: row.gate_key, durableTaskId: row.durable_task_id, gateInputDigest: row.gate_input_digest, delivery: row.outbox_id === null ? 'none' : row.delivered ? 'delivered' : 'pending' });
  }
  private async questionTx(client: PoolClient, key: LogicalTaskKey, questionId: string): Promise<QuestionRow | undefined> { const result = await client.query<QuestionRow>('SELECT q.*,o.delivered FROM camery_agents.agent_questions q LEFT JOIN camery_agents.agent_outbox o ON o.tenant_id=q.tenant_id AND o.project_id=q.project_id AND o.outbox_id=q.outbox_id WHERE q.tenant_id=$1 AND q.project_id=$2 AND q.task_id=$3 AND q.question_id=$4', [key.tenantId, key.projectId, key.taskId, questionId]); return result.rows[0]; }
  private async openQuestionTx(client: PoolClient, key: LogicalTaskKey, task: StoredTask, input: QuestionInput, actor: string, suppliedGate?: string): Promise<StoredQuestion> {
    const opened = createQuestion(input); const actorId = persistenceData(Name, actor); const gateKey = suppliedGate === undefined ? null : persistenceData(Name, suppliedGate);
    if (opened.taskId !== key.taskId || opened.scope.tenantId !== key.tenantId || opened.scope.projectId !== key.projectId || opened.objectIds.some(id => !task.task.scope.objectIds.includes(id))) throw new AgentPersistenceError('QUESTION_SCOPE');
    if (gateKey && !task.durableTaskId) throw new AgentPersistenceError('TASK_NOT_DISPATCHED');
    const prior = await this.questionTx(client, key, opened.questionId); if (prior) { const saved = this.question(prior, key); if (saved.question.questionDigest !== opened.questionDigest || saved.gateKey !== gateKey) throw new AgentPersistenceError('QUESTION_CONFLICT'); return saved; }
    const result = await client.query<QuestionRow>('INSERT INTO camery_agents.agent_questions(tenant_id,project_id,task_id,question_id,record,question_digest,gate_key,durable_task_id,gate_input_digest) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING *', [key.tenantId, key.projectId, key.taskId, opened.questionId, canonical(opened), opened.questionDigest, gateKey, gateKey ? task.durableTaskId : null, gateKey ? digest(opened) : null]); if (result.rowCount !== 1) throw new AgentPersistenceError('AGENT_WRITE_FAILED'); await this.event(client, key, key.taskId, 'question_opened', { questionId: opened.questionId, actorId }); return this.question(result.rows[0]!, key);
  }
  async openQuestion(key: LogicalTaskKey, input: QuestionInput, actor: string, gateKey?: string): Promise<StoredQuestion> { const captured = jsonCopy(input); return this.withTask(key, async context => context.openQuestion(captured, actor, gateKey)); }
  async getQuestion(supplied: LogicalTaskKey, questionId: string): Promise<StoredQuestion> { const key = persistenceData(TaskKeySchema, supplied); const id = persistenceData(Name, questionId); return this.withTask(key, async ({ client }) => { const row = await this.questionTx(client, key, id); if (!row) throw new AgentPersistenceError('QUESTION_NOT_FOUND'); return this.question(row, key); }); }
  async answerQuestion(supplied: LogicalTaskKey, suppliedId: string, actor: string, answer: Json, suppliedDigest: string): Promise<StoredQuestion> {
    const key = persistenceData(TaskKeySchema, supplied); const questionId = persistenceData(Name, suppliedId); const actorId = persistenceData(Name, actor); const captured = jsonCopy(answer); const expected = persistenceData(Pin.shape.digest, suppliedDigest);
    return this.withTask(key, async ({ client }) => {
      const row = await this.questionTx(client, key, questionId); if (!row) throw new AgentPersistenceError('QUESTION_NOT_FOUND'); const saved = this.question(row, key);
      if (saved.question.questionDigest !== expected) throw new AgentPersistenceError('STALE_QUESTION');
      if (saved.question.status === 'answered') { if (saved.question.answer!.actorId !== actorId || canonical(saved.question.answer!.value) !== canonical(captured)) throw new AgentPersistenceError('QUESTION_CONFLICT'); return saved; }
      const updated = submitQuestionAnswer(saved.question, { tenantId: key.tenantId, projectId: key.projectId, actorId }, captured, expected); let outboxId: string | null = null;
      if (saved.gateKey && saved.durableTaskId && saved.gateInputDigest) { const item = createOutboxItem({ tenantId: key.tenantId, projectId: key.projectId, outboxId: `answer_${digest({ key, questionId, expected })}`, kind: 'signal', gateInputDigest: saved.gateInputDigest, payload: { tenantId: key.tenantId, taskId: saved.durableTaskId, gateKey: saved.gateKey, signalId: `answer_${digest({ key, questionId, expected })}`, actorId, value: { questionDigest: expected, answer: captured } } }); await this.outboxTx(client, item); outboxId = item.outboxId; }
      const result = await client.query('UPDATE camery_agents.agent_questions SET record=$5::jsonb,outbox_id=$6 WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND question_id=$4 AND question_digest=$7', [key.tenantId, key.projectId, key.taskId, questionId, canonical(updated), outboxId, expected]); if (result.rowCount !== 1) throw new AgentPersistenceError('QUESTION_CONFLICT'); await this.event(client, key, key.taskId, 'question_answered', { questionId, actorId, answerDigest: digest(captured), outboxId }); return this.question((await this.questionTx(client, key, questionId))!, key);
    });
  }
  async pending(input: OutboxScope, limit: number): Promise<OutboxItem[]> {
    const scope = persistenceData(OutboxScopeSchema, input); persistenceData(z.int().min(1).max(100), limit);
    return this.transaction(scope, async client => {
      const result = await client.query<{ outbox_id: string; record: OutboxItem; record_digest: string }>('SELECT outbox_id,record,record_digest FROM camery_agents.agent_outbox WHERE tenant_id=$1 AND project_id=$2 AND NOT delivered ORDER BY last_selected_at,sequence LIMIT $3', [scope.tenantId, scope.projectId, limit]);
      const items = result.rows.map(row => { const item = validateOutboxItem(row.record, scope); if (item.digest !== row.record_digest || item.outboxId !== row.outbox_id) throw new AgentPersistenceError('OUTBOX_CONFLICT'); return item; });
      // Selection is a rotation hint, not a delivery claim. Exact target idempotency still permits concurrent relays.
      if (items.length) { const updated = await client.query('UPDATE camery_agents.agent_outbox SET last_selected_at=clock_timestamp() WHERE tenant_id=$1 AND project_id=$2 AND outbox_id=ANY($3::text[]) AND NOT delivered', [scope.tenantId, scope.projectId, items.map(item => item.outboxId)]); if (updated.rowCount !== items.length) throw new AgentPersistenceError('OUTBOX_CONFLICT'); }
      return items;
    });
  }
  async acknowledge(input: OutboxScope, suppliedId: string, suppliedDigest: string): Promise<void> {
    const scope = persistenceData(OutboxScopeSchema, input); const id = persistenceData(Name, suppliedId); const expected = persistenceData(Pin.shape.digest, suppliedDigest);
    return this.transaction(scope, async client => {
      const result = await client.query<{ record: OutboxItem; record_digest: string; delivered: boolean }>('SELECT record,record_digest,delivered FROM camery_agents.agent_outbox WHERE tenant_id=$1 AND project_id=$2 AND outbox_id=$3', [scope.tenantId, scope.projectId, id]); const row = result.rows[0]; if (!row || row.record_digest !== expected) throw new AgentPersistenceError('OUTBOX_CONFLICT'); const item = validateOutboxItem(row.record, scope); if (item.digest !== expected) throw new AgentPersistenceError('OUTBOX_CONFLICT'); if (row.delivered) return;
      if (item.kind === 'enqueue') { const actual = await client.query<PhysicalTask>('SELECT tenant_id,task_id,workflow,version,input,output,status,max_attempts,enqueue_at FROM camery_durable.tasks WHERE tenant_id=$1 AND task_id=$2', [scope.tenantId, item.payload.taskId]); if (!actual.rows[0] || !this.sameJob(actual.rows[0], item.payload)) throw new AgentPersistenceError('DELIVERY_UNCONFIRMED'); }
      else {
        const signal = await client.query<{ step_key: string; actor_id: string; value: Json }>('SELECT step_key,actor_id,value FROM camery_durable.signals WHERE tenant_id=$1 AND task_id=$2 AND signal_id=$3', [scope.tenantId, item.payload.taskId, item.payload.signalId]); const saved = signal.rows[0];
        const gate = await client.query<{ kind: string; input: Json }>('SELECT kind,input FROM camery_durable.steps WHERE tenant_id=$1 AND task_id=$2 AND step_key=$3', [scope.tenantId, item.payload.taskId, item.payload.gateKey]);
        if (!saved || saved.step_key !== item.payload.gateKey || saved.actor_id !== item.payload.actorId || canonical(saved.value) !== canonical(item.payload.value) || gate.rows[0]?.kind !== 'gate' || digest(gate.rows[0].input) !== item.gateInputDigest) throw new AgentPersistenceError('DELIVERY_UNCONFIRMED');
      }
      const updated = await client.query('UPDATE camery_agents.agent_outbox SET delivered=true WHERE tenant_id=$1 AND project_id=$2 AND outbox_id=$3 AND record_digest=$4', [scope.tenantId, scope.projectId, id, expected]); if (updated.rowCount !== 1) throw new AgentPersistenceError('OUTBOX_CONFLICT'); await this.event(client, scope, null, 'outbox_delivered', { outboxId: id, digest: expected });
    });
  }
}

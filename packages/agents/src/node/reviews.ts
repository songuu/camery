import { z } from 'zod';
import { canonical, digest, freeze, MethodError } from '@camery/methods';
import { AgentError, AgentRegistry, Name } from '../registry.js';
import { AgentCollaborationError } from '../collaboration.js';
import type { AgentTask, QuestionInput } from '../collaboration.js';
import { createReviewLoop, submitReviewRevision, submitReviewRound, validateReviewLoop } from '../review-loop.js';
import type { ReviewLoop, ReviewLoopInput, ReviewRevision, ReviewRoundInput } from '../review-loop.js';
import { AgentPersistenceError, persistenceData, TaskKeySchema } from '../task-service.js';
import type { LogicalTaskKey } from '../task-service.js';
import type { CollaborationTransaction, CollaborationTransactions } from './collaboration-types.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const Operation = z.strictObject({ operationId: Name, actorId: Name, expectedRevision: revision, expectedDigest: hash,
  change: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('round'), submission: z.unknown() }), z.strictObject({ kind: z.literal('revision'), submission: z.unknown() })]) });
export interface ReviewOperation { operationId: string; actorId: string; expectedRevision: number; expectedDigest: string;
  change: { kind: 'round'; submission: ReviewRoundInput } | { kind: 'revision'; submission: ReviewRevision } }
export interface ReviewSnapshot { loop: ReviewLoop; revision: number }
type ReviewRow = { initial_digest: string; record: unknown; revision: string; gate_key: string | null };
type OperationRow = { request_digest: string; record: unknown; revision: string };
const keyParameters = (key: LogicalTaskKey, reviewId: string): string[] => [key.tenantId, key.projectId, key.taskId, reviewId];
/** Reuses the collaboration task/project transaction. No model, tool or network call is made while locks are held. */
export class PostgresReviewStore {
  private readonly transaction: CollaborationTransactions['withTask'];
  private readonly resolve: AgentRegistry['resolve'];
  private readonly validateOutput: AgentRegistry['validateOutput'];
  constructor(transactions: CollaborationTransactions, agents: AgentRegistry) {
    if (typeof transactions.withTask !== 'function') throw new AgentPersistenceError('INVALID_COLLABORATION_INPUT');
    this.transaction = transactions.withTask.bind(transactions); this.resolve = agents.resolve.bind(agents); this.validateOutput = agents.validateOutput.bind(agents);
  }
  private async run<T>(key: LogicalTaskKey, handler: (tx: CollaborationTransaction) => Promise<T>): Promise<T> {
    const failure = (error: unknown): never => {
      if (error instanceof AgentPersistenceError) throw error;
      if ((error instanceof AgentError || error instanceof AgentCollaborationError || error instanceof MethodError) && /^[A-Z_]{1,64}$/.test(error.code)) throw new AgentPersistenceError(error.code);
      throw new AgentPersistenceError('REVIEW_STORAGE_FAILED');
    };
    try { return await this.transaction(key, async tx => { try { return await handler(tx); } catch (error) { return failure(error); } }); }
    catch (error) { return failure(error); }
  }
  private bound(loop: ReviewLoop, key: LogicalTaskKey, task: AgentTask): void {
    if (loop.scope.tenantId !== key.tenantId || loop.scope.projectId !== key.projectId || loop.scope.taskId !== key.taskId || loop.scope.objectIds.some(id => !task.scope.objectIds.includes(id))
      || canonical(loop.producer.agent) !== canonical(task.agent)) throw new AgentPersistenceError('REVIEW_SCOPE');
    const producer = this.resolve(loop.producer.agent); this.resolve(loop.reviewer.agent);
    if (!producer.methods.some(method => canonical(method) === canonical(loop.method))) throw new AgentPersistenceError('REVIEW_METHOD_BINDING');
    if (!this.validateOutput(loop.producer.agent, loop.candidate)) throw new AgentPersistenceError('REVIEW_CANDIDATE');
  }
  private snapshot(row: { record: unknown; revision: string }, key: LogicalTaskKey, task: AgentTask): ReviewSnapshot {
    const identity = persistenceData(z.object({ loopDigest: hash }).passthrough(), row.record);
    const loop = validateReviewLoop(row.record, identity.loopDigest); this.bound(loop, key, task);
    if (!/^(0|[1-9]\d*)$/.test(row.revision) || !Number.isSafeInteger(Number(row.revision))) throw new AgentPersistenceError('REVIEW_CORRUPT');
    return freeze({ loop, revision: Number(row.revision) });
  }
  private async current(tx: CollaborationTransaction, key: LogicalTaskKey, reviewId: string): Promise<ReviewRow> {
    const result = await tx.client.query<ReviewRow>('SELECT initial_digest,record,revision::text,gate_key FROM camery_agents.agent_reviews WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND review_id=$4 FOR UPDATE', keyParameters(key, reviewId));
    if (!result.rows[0]) throw new AgentPersistenceError('REVIEW_NOT_FOUND'); return result.rows[0];
  }
  async create(supplied: LogicalTaskKey, suppliedId: string, input: ReviewLoopInput, actor: string, suppliedGateKey?: string): Promise<ReviewSnapshot> {
    const key = persistenceData(TaskKeySchema, supplied); const reviewId = persistenceData(Name, suppliedId); const actorId = persistenceData(Name, actor);
    const gateKey = suppliedGateKey === undefined ? null : persistenceData(Name, suppliedGateKey); const captured = persistenceData(z.unknown(), input) as ReviewLoopInput;
    return this.run(key, async tx => {
      const loop = createReviewLoop(captured); this.bound(loop, key, tx.task); const initialDigest = digest({ input: captured, gateKey });
      const previous = await tx.client.query<ReviewRow>('SELECT initial_digest,record,revision::text,gate_key FROM camery_agents.agent_reviews WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND review_id=$4 FOR UPDATE', keyParameters(key, reviewId));
      if (previous.rows[0]) { if (previous.rows[0].initial_digest !== initialDigest || previous.rows[0].gate_key !== gateKey) throw new AgentPersistenceError('REVIEW_CONFLICT'); return this.snapshot(previous.rows[0], key, tx.task); }
      const inserted = await tx.client.query('INSERT INTO camery_agents.agent_reviews(tenant_id,project_id,task_id,review_id,initial_digest,record,revision,gate_key) VALUES($1,$2,$3,$4,$5,$6::jsonb,0,$7)', [...keyParameters(key, reviewId), initialDigest, canonical(loop), gateKey]);
      if (inserted.rowCount !== 1) throw new AgentPersistenceError('REVIEW_WRITE_FAILED');
      await tx.event('review_created', { reviewId, actorId, revision: 0, loopDigest: loop.loopDigest });
      return freeze({ loop, revision: 0 });
    });
  }
  async get(supplied: LogicalTaskKey, suppliedId: string): Promise<ReviewSnapshot> {
    const key = persistenceData(TaskKeySchema, supplied); const reviewId = persistenceData(Name, suppliedId);
    return this.run(key, async tx => this.snapshot(await this.current(tx, key, reviewId), key, tx.task));
  }
  async apply(supplied: LogicalTaskKey, suppliedId: string, input: ReviewOperation): Promise<ReviewSnapshot> {
    const key = persistenceData(TaskKeySchema, supplied); const reviewId = persistenceData(Name, suppliedId); const operation = persistenceData(Operation, input) as ReviewOperation;
    return this.run(key, async tx => {
      const requestDigest = digest({ key, reviewId, operation });
      const prior = await tx.client.query<OperationRow>('SELECT request_digest,record,revision::text FROM camery_agents.agent_review_ops WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND review_id=$4 AND operation_id=$5', [...keyParameters(key, reviewId), operation.operationId]);
      if (prior.rows[0]) { if (prior.rows[0].request_digest !== requestDigest) throw new AgentPersistenceError('REVIEW_OPERATION_CONFLICT'); return this.snapshot(prior.rows[0], key, tx.task); }
      const stored = await this.current(tx, key, reviewId); const current = this.snapshot(stored, key, tx.task);
      if (current.revision !== operation.expectedRevision || current.loop.loopDigest !== operation.expectedDigest) throw new AgentPersistenceError('REVIEW_CONFLICT');
      const loop = operation.change.kind === 'round' ? submitReviewRound(current.loop, operation.change.submission, operation.expectedDigest) : submitReviewRevision(current.loop, operation.change.submission, operation.expectedDigest);
      this.bound(loop, key, tx.task); const nextRevision = current.revision + 1;
      const updated = await tx.client.query('UPDATE camery_agents.agent_reviews SET record=$5::jsonb,revision=$6 WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND review_id=$4 AND revision=$7', [...keyParameters(key, reviewId), canonical(loop), nextRevision, current.revision]);
      if (updated.rowCount !== 1) throw new AgentPersistenceError('REVIEW_CONFLICT');
      if (operation.change.kind === 'round') for (const issue of loop.rounds.at(-1)!.issues) await tx.putIssue(issue, operation.actorId);
      if (loop.state === 'needs_human') {
        const question = loop.question!; const declaration: QuestionInput = { questionId: question.questionId, taskId: question.taskId, scope: question.scope, objectIds: question.objectIds, prompt: question.prompt, choices: question.choices };
        const opened = await tx.openQuestion(declaration, operation.actorId, stored.gate_key === null ? undefined : persistenceData(Name, stored.gate_key));
        if (canonical(opened.question) !== canonical(question)) throw new AgentPersistenceError('REVIEW_QUESTION_CONFLICT');
      }
      const inserted = await tx.client.query('INSERT INTO camery_agents.agent_review_ops(tenant_id,project_id,task_id,review_id,operation_id,request_digest,record,revision) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)', [...keyParameters(key, reviewId), operation.operationId, requestDigest, canonical(loop), nextRevision]);
      if (inserted.rowCount !== 1) throw new AgentPersistenceError('REVIEW_WRITE_FAILED');
      await tx.event(operation.change.kind === 'round' ? 'review_round_submitted' : 'review_revision_submitted', { reviewId, operationId: operation.operationId, actorId: operation.actorId, revision: nextRevision, loopDigest: loop.loopDigest, state: loop.state });
      return freeze({ loop, revision: nextRevision });
    });
  }
}

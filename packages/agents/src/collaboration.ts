import { z } from 'zod';
import { digest, freeze, jsonCopy, Pin } from '@camery/methods';
import type { Json } from '@camery/model-modes';

// oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
const identity = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(8000).refine(value => value.trim().length > 0);
const Scope = z.strictObject({ tenantId: identity, projectId: identity });
const identities = z.array(identity).max(1000).refine(values => new Set(values).size === values.length);
const status = z.enum(['queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled']);
const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const TaskSchema = z.strictObject({ taskId: identity, parentId: identity.nullable(), agent: Pin, input: z.json(), dependencies: identities,
  scope: Scope.extend({ objectIds: identities }), status, output: z.json().optional(), errorCode: errorCode.optional(),
}).refine(value => value.status === 'succeeded' ? value.output !== undefined && value.errorCode === undefined
  : value.status === 'failed' ? value.errorCode !== undefined && value.output === undefined : value.output === undefined && value.errorCode === undefined);
export type AgentTask = z.infer<typeof TaskSchema>;
export function validateAgentTask(input: unknown): AgentTask {
  const parsed = TaskSchema.safeParse(jsonCopy(input)); if (!parsed.success) throw new AgentCollaborationError('INVALID_TASK', 'agent task record');
  return freeze(parsed.data);
}
const Transition = z.strictObject({ status, output: z.json().optional(), errorCode: errorCode.optional() });
export type TaskTransition = z.infer<typeof Transition>;
export class AgentCollaborationError extends Error {
  override readonly name = 'AgentCollaborationError';
  constructor(readonly code: string, readonly operation: string) { super(`${code}: ${operation}`); }
}
function reject(code: string, operation: string): never { throw new AgentCollaborationError(code, operation); }
function acyclic(tasks: AgentTask[], references: (task: AgentTask) => readonly string[]): boolean {
  const incoming = new Map(tasks.map(task => [task.taskId, 0]));
  for (const task of tasks) for (const key of references(task)) incoming.set(key, incoming.get(key)! + 1);
  const pending = tasks.filter(task => incoming.get(task.taskId) === 0).map(task => task.taskId);
  const byId = new Map(tasks.map(task => [task.taskId, task])); let visited = 0;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const key = pending[cursor]!; visited++;
    for (const target of references(byId.get(key)!)) {
      const count = incoming.get(target)! - 1; incoming.set(target, count); if (count === 0) pending.push(target);
    }
  }
  return visited === tasks.length;
}
/** Validate a complete task tree, rather than guessing the existence or tenant of omitted parents. */
export function validateTaskTree(input: readonly AgentTask[]): readonly AgentTask[] {
  const parsed = z.array(TaskSchema).min(1).max(1000).safeParse(jsonCopy(input));
  if (!parsed.success) reject('INVALID_TASK_TREE', 'agent task records');
  const tasks = parsed.data; const first = tasks[0]!; const keys = new Set(tasks.map(task => task.taskId));
  if (keys.size !== tasks.length || tasks.filter(task => task.parentId === null).length !== 1
    || tasks.some(task => task.scope.tenantId !== first.scope.tenantId || task.scope.projectId !== first.scope.projectId || (task.parentId !== null && !keys.has(task.parentId)) || task.dependencies.some(key => !keys.has(key) || key === task.taskId))
    || !acyclic(tasks, task => task.parentId === null ? [] : [task.parentId]) || !acyclic(tasks, task => task.dependencies)) reject('INVALID_TASK_TREE', 'agent task topology');
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  if (tasks.some(task => {
    const parentId = task.parentId;
    return parentId !== null && task.scope.objectIds.some(key => !byId.get(parentId)!.scope.objectIds.includes(key));
  })) reject('INVALID_TASK_TREE', 'agent delegated object scope');
  return freeze(tasks);
}
const transitions: Record<AgentTask['status'], readonly AgentTask['status'][]> = {
  queued: ['running', 'cancelled'], running: ['waiting', 'succeeded', 'failed', 'cancelled'], waiting: ['running', 'failed', 'cancelled'],
  succeeded: [], failed: [], cancelled: [],
};
/** Transition returns a new candidate record; adopting or persisting it remains a host responsibility. */
export function transitionTask(input: AgentTask, change: TaskTransition): AgentTask {
  const current = TaskSchema.safeParse(jsonCopy(input)); const update = Transition.safeParse(jsonCopy(change));
  if (!current.success || !update.success || !transitions[current.data.status].includes(update.data.status)) reject('INVALID_TASK_TRANSITION', 'agent task state');
  const next = TaskSchema.safeParse({ ...current.data, ...update.data });
  if (!next.success) reject('INVALID_TASK_TRANSITION', 'agent task result');
  return freeze(next.data);
}

const IssueSchema = z.strictObject({ issueId: identity, taskId: identity, scope: Scope, objectId: identity,
  path: z.string().max(1000).refine(value => (value === '' || value.startsWith('/')) && !/~(?![01])/u.test(value)),
  severity: z.enum(['minor', 'major', 'critical']), problem: text, audienceImpact: text, suggestion: text,
  ripple: z.array(text).max(100), evidenceScope: z.enum(['text', 'media']),
});
export {IssueSchema as AgentIssueSchema};
export type AgentIssue = z.infer<typeof IssueSchema>;
/** Evidence scope is explicit: a text observation is not a rendered-media approval. */
export function createIssue(input: AgentIssue): AgentIssue {
  const parsed = IssueSchema.safeParse(jsonCopy(input));
  if (!parsed.success) reject('INVALID_ISSUE', 'agent issue');
  return freeze(parsed.data);
}

const QuestionBody = z.strictObject({ questionId: identity, taskId: identity, scope: Scope, objectIds: identities, prompt: text,
  choices: z.array(text).max(16).refine(values => new Set(values).size === values.length),
});
export type QuestionInput = z.infer<typeof QuestionBody>;
const Answer = z.strictObject({ actorId: identity, value: z.json() });
const QuestionSchema = QuestionBody.extend({ version: z.literal(1), status: z.enum(['open', 'answered']), questionDigest: hash, answer: Answer.optional() })
  .refine(value => (value.status === 'answered') === (value.answer !== undefined));
export type AgentQuestion = z.infer<typeof QuestionSchema>;
const AnswerActor = Scope.extend({ actorId: identity });
export type QuestionAnswerActor = z.infer<typeof AnswerActor>;
function questionBody(value: QuestionInput) {
  return { version: 1 as const, questionId: value.questionId, taskId: value.taskId, scope: value.scope, objectIds: value.objectIds, prompt: value.prompt, choices: value.choices };
}
/** Opening a question records an ambiguity, never an inferred answer or authorization. */
export function createQuestion(input: QuestionInput): AgentQuestion {
  const parsed = QuestionBody.safeParse(jsonCopy(input));
  if (!parsed.success) reject('INVALID_QUESTION', 'agent question');
  const body = questionBody(parsed.data);
  return freeze({ ...body, status: 'open' as const, questionDigest: digest(body) });
}
/** Actor scope and expected digest must be supplied by an authenticated host and its trusted stored record. */
export function submitQuestionAnswer(input: AgentQuestion, supplied: QuestionAnswerActor, answer: Json, expectedQuestionDigest: string): AgentQuestion {
  const question = QuestionSchema.safeParse(jsonCopy(input)); const actor = AnswerActor.safeParse(jsonCopy(supplied)); const expected = hash.safeParse(expectedQuestionDigest);
  if (!question.success || !actor.success || !expected.success) reject('INVALID_QUESTION_ANSWER', 'agent question answer');
  const record = question.data; const host = actor.data;
  if (record.scope.tenantId !== host.tenantId || record.scope.projectId !== host.projectId) reject('QUESTION_SCOPE', 'agent question answer');
  if (record.questionDigest !== expected.data || digest(questionBody(record)) !== expected.data) reject('STALE_QUESTION', 'agent question answer');
  if (record.status !== 'open') reject('QUESTION_ALREADY_ANSWERED', 'agent question answer');
  const value = jsonCopy(answer);
  if (record.choices.length && (typeof value !== 'string' || !record.choices.includes(value))) reject('INVALID_QUESTION_ANSWER', 'agent question choice');
  return freeze({ ...record, status: 'answered' as const, answer: { actorId: host.actorId, value } });
}

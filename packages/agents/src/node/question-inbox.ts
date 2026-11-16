import { z } from 'zod';
import { canonical, digest, freeze, jsonCopy, Pin } from '@camery/methods';
import { createQuestion, submitQuestionAnswer, validateAgentTask } from '../collaboration.js';
import type { AgentQuestion, QuestionInput } from '../collaboration.js';
import { AgentError, Name } from '../registry.js';
import { AgentPersistenceError } from '../task-service.js';
import type { QuestionInbox, QuestionInboxBinding } from '../question-inbox.js';
import type { PostgresCollaborationStore } from './collaboration-store.js';

const Binding = z.strictObject({ task: z.strictObject({ tenantId: Name, taskId: Name }), agent: Pin, gateKey: Name });
const Assignment = z.strictObject({ task: z.unknown(), treeId: Name, revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), durableTaskId: Name.nullable() });
const Saved = z.strictObject({ question: z.unknown(), gateKey: Name.nullable(), durableTaskId: Name.nullable(), gateInputDigest: Pin.shape.digest.nullable(), delivery: z.enum(['none', 'pending', 'delivered']) });
function parse<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  try { const result = schema.safeParse(jsonCopy(input)); if (result.success) return freeze(result.data) as T; } catch { /* Do not expose arbitrary stored data or native diagnostics. */ }
  throw new AgentError(code);
}
function declaration(question: AgentQuestion): QuestionInput {
  return { questionId: question.questionId, taskId: question.taskId, scope: question.scope, objectIds: question.objectIds, prompt: question.prompt, choices: question.choices };
}
function originalQuestion(input: Readonly<AgentQuestion>): AgentQuestion {
  try {
    const captured = jsonCopy(input); const opened = createQuestion(declaration(captured));
    if (captured.status === 'open' && canonical(opened) === canonical(captured)) return opened;
  } catch { /* Only a canonical original open Question can be journaled as a new inbox request. */ }
  throw new AgentError('QUESTION_INBOX_INVALID');
}
function active(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw new AgentError('QUESTION_INBOX_INVALID');
  if (signal.aborted) throw new AgentError('ABORTED');
}
/** Internal adapter: authenticated actor and physical journal assignment come from the host, never from a model claim. */
export function createCollaborationQuestionInbox(store: Pick<PostgresCollaborationStore, 'assignment' | 'openQuestion'>, suppliedActor: string): QuestionInbox {
  const actorId = parse(Name, suppliedActor, 'QUESTION_INBOX_INVALID');
  let assignment: PostgresCollaborationStore['assignment']; let openQuestion: PostgresCollaborationStore['openQuestion'];
  try {
    const { assignment: resolve, openQuestion: open } = store;
    if (typeof resolve !== 'function' || typeof open !== 'function') throw new Error();
    assignment = resolve.bind(store); openQuestion = open.bind(store);
  } catch { throw new AgentError('QUESTION_INBOX_INVALID'); }
  const identity = 'postgres-collaboration-inbox/v1';
  return Object.freeze({ identity, digest: digest({ adapterVersion: identity, actorId }), async open(input: Readonly<AgentQuestion>, supplied: Readonly<QuestionInboxBinding>, signal: AbortSignal): Promise<void> {
    try {
      active(signal); const question = originalQuestion(input); const binding = parse(Binding, supplied, 'QUESTION_INBOX_INVALID');
      if (binding.task.tenantId !== question.scope.tenantId) throw new AgentError('QUESTION_INBOX_SCOPE');
      const assigned = parse(Assignment, await assignment(binding.task), 'QUESTION_ASSIGNMENT_INVALID'); active(signal);
      const task = validateAgentTask(assigned.task);
      if (task.taskId !== question.taskId || task.scope.tenantId !== question.scope.tenantId || task.scope.projectId !== question.scope.projectId || question.objectIds.some(id => !task.scope.objectIds.includes(id))
        || canonical(task.agent) !== canonical(binding.agent) || assigned.durableTaskId !== binding.task.taskId) throw new AgentError('QUESTION_INBOX_SCOPE');
      const key = freeze({ tenantId: question.scope.tenantId, projectId: question.scope.projectId, taskId: question.taskId });
      const saved = parse(Saved, await openQuestion(key, freeze(declaration(question)), actorId, binding.gateKey), 'QUESTION_INBOX_RECEIPT'); active(signal);
      const stored = saved.question as AgentQuestion;
      const expected = stored.status === 'answered' && stored.answer ? submitQuestionAnswer(question, { ...question.scope, actorId: stored.answer.actorId }, stored.answer.value, question.questionDigest) : question;
      if (stored.questionDigest !== question.questionDigest || canonical(stored) !== canonical(expected) || saved.gateKey !== binding.gateKey || saved.durableTaskId !== binding.task.taskId || saved.gateInputDigest !== digest(question)) throw new AgentError('QUESTION_INBOX_RECEIPT');
    } catch (error) {
      if (signal instanceof AbortSignal && signal.aborted) throw new AgentError('ABORTED');
      if ((error instanceof AgentError || error instanceof AgentPersistenceError) && typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)) throw new AgentError(error.code);
      throw new AgentError('QUESTION_INBOX_FAILED');
    }
  } });
}

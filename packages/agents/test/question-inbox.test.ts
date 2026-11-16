import { expect, it, vi } from 'vitest';
import { digest } from '@camery/methods';
import { createQuestion, submitQuestionAnswer } from '../src/collaboration.js';
import type { AgentTask } from '../src/collaboration.js';
import { AgentPersistenceError } from '../src/task-service.js';
import type { StoredTask } from '../src/task-service.js';
import type { StoredQuestion } from '../src/node/collaboration-types.js';
import { createCollaborationQuestionInbox } from '../src/node/question-inbox.js';

const pin = () => ({ id: 'research', version: '1.0.0', digest: 'a'.repeat(64) });
function fixture() {
  const question = createQuestion({ questionId: 'question-a', taskId: 'logical-a', scope: { tenantId: 'tenant-a', projectId: 'project-a' }, objectIds: ['source-a'], prompt: 'Which source version?', choices: ['one', 'two'] });
  const binding = { task: { tenantId: 'tenant-a', taskId: 'physical-a' }, agent: pin(), gateKey: 'agent.question.0' };
  const task: AgentTask = { taskId: 'logical-a', parentId: null, agent: pin(), input: {}, dependencies: [], scope: { tenantId: 'tenant-a', projectId: 'project-a', objectIds: ['source-a', 'source-b'] }, status: 'running' };
  const assigned: StoredTask = { task, treeId: 'tree-a', revision: 1, durableTaskId: 'physical-a' };
  const saved: StoredQuestion = { question, gateKey: binding.gateKey, durableTaskId: binding.task.taskId, gateInputDigest: digest(question), delivery: 'none' };
  const store = { assignment: vi.fn(async () => assigned), openQuestion: vi.fn(async () => saved) };
  return { question, binding, assigned, saved, store, signal: new AbortController().signal };
}
it('uses a stable actor-bound descriptor and opens the exact scoped Question against its actual physical assignment', async () => {
  const f = fixture(); const inbox = createCollaborationQuestionInbox(f.store, 'host-agent');
  expect(inbox.identity).toBe('postgres-collaboration-inbox/v1'); expect(inbox.digest).toBe(digest({ adapterVersion: inbox.identity, actorId: 'host-agent' })); expect(Object.isFrozen(inbox)).toBe(true);
  expect(createCollaborationQuestionInbox(f.store, 'host-agent').digest).toBe(inbox.digest); expect(createCollaborationQuestionInbox(f.store, 'different-host').digest).not.toBe(inbox.digest);
  await inbox.open(f.question, f.binding, f.signal);
  expect(f.store.assignment).toHaveBeenCalledWith({ tenantId: 'tenant-a', taskId: 'physical-a' });
  const { version: _version, status: _status, questionDigest: _digest, ...declaration } = f.question;
  expect(f.store.openQuestion).toHaveBeenCalledWith({ tenantId: 'tenant-a', projectId: 'project-a', taskId: 'logical-a' }, declaration, 'host-agent', 'agent.question.0');
});
it('accepts an exactly matching already answered stored Question after an interrupted open receipt', async () => {
  const f = fixture(); const answered = submitQuestionAnswer(f.question, { ...f.question.scope, actorId: 'host-human' }, 'two', f.question.questionDigest);
  f.store.openQuestion.mockResolvedValue({ ...f.saved, question: answered, delivery: 'delivered' });
  await expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, f.signal)).resolves.toBeUndefined();
});
it.each(['answered', 'digest', 'extra', 'open-answer', 'duplicate-objects'] as const)('rejects a non-original open Question before any storage call: %s', kind => {
  const f = fixture(); const question = structuredClone(f.question);
  if (kind === 'answered') Object.assign(question, { status: 'answered', answer: { actorId: 'host-human', value: 'one' } });
  if (kind === 'digest') question.questionDigest = 'b'.repeat(64);
  if (kind === 'extra') Object.assign(question, { adopted: true });
  if (kind === 'open-answer') Object.assign(question, { answer: { actorId: 'host-human', value: 'one' } });
  if (kind === 'duplicate-objects') question.objectIds.push('source-a');
  return expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(question, f.binding, f.signal)).rejects.toThrow().then(() => { expect(f.store.assignment).not.toHaveBeenCalled(); expect(f.store.openQuestion).not.toHaveBeenCalled(); });
});
it.each(['task-tenant', 'project', 'logical-task', 'object', 'agent-id', 'agent-version', 'agent-digest', 'physical-task'] as const)('rejects a mismatched resolved assignment: %s', kind => {
  const f = fixture();
  if (kind === 'task-tenant') f.assigned.task.scope.tenantId = 'other';
  if (kind === 'project') f.assigned.task.scope.projectId = 'other';
  if (kind === 'logical-task') f.assigned.task.taskId = 'other';
  if (kind === 'object') f.assigned.task.scope.objectIds = ['source-b'];
  if (kind === 'agent-id') f.assigned.task.agent.id = 'other';
  if (kind === 'agent-version') f.assigned.task.agent.version = '1.0.1';
  if (kind === 'agent-digest') f.assigned.task.agent.digest = 'b'.repeat(64);
  if (kind === 'physical-task') f.assigned.durableTaskId = 'other';
  return expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, f.signal)).rejects.toThrow().then(() => { expect(f.store.openQuestion).not.toHaveBeenCalled(); });
});
it.each(['question', 'question-body', 'gate', 'physical', 'gate-input', 'malformed-answer', 'missing-answer'] as const)('checks the persisted Question and gate receipt: %s', kind => {
  const f = fixture();
  if (kind === 'question') f.saved.question = createQuestion({ questionId: 'question-b', taskId: f.question.taskId, scope: f.question.scope, objectIds: f.question.objectIds, prompt: 'Different question.', choices: [] });
  if (kind === 'question-body') f.saved.question = { ...f.question, prompt: 'Changed body with an unchanged digest claim.' };
  if (kind === 'gate') f.saved.gateKey = 'other';
  if (kind === 'physical') f.saved.durableTaskId = 'other';
  if (kind === 'gate-input') f.saved.gateInputDigest = 'b'.repeat(64);
  if (kind === 'malformed-answer') f.saved.question = { ...f.question, status: 'answered', answer: { actorId: 'host-human', value: 'not-a-choice' } };
  if (kind === 'missing-answer') f.saved.question = { ...f.question, status: 'answered' };
  return expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, f.signal)).rejects.toThrow();
});
it('captures both capabilities and all request values before waiting for assignment', async () => {
  const f = fixture(); const question = structuredClone(f.question); const binding = structuredClone(f.binding);
  let release: () => void = () => {}; const waiting = new Promise<void>(resolve => { release = resolve; });
  f.store.assignment.mockImplementation(async () => { await waiting; return f.assigned; }); const inbox = createCollaborationQuestionInbox(f.store, 'host-agent');
  const pending = inbox.open(question, binding, f.signal); question.prompt = 'mutated'; question.objectIds.push('other'); binding.task.tenantId = 'other'; binding.agent.digest = 'b'.repeat(64);
  f.store.openQuestion = vi.fn(async () => { throw new Error('replaced capability'); }); release(); await pending;
});
it('rejects pre-cancelled work and checks cancellation again before opening and after persistence', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(new Error('private cancellation diagnostic'));
  await expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' }); expect(f.store.assignment).not.toHaveBeenCalled();
  const beforeOpen = new AbortController(); f.store.assignment.mockImplementation(async () => { beforeOpen.abort(); return f.assigned; });
  await expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, beforeOpen.signal)).rejects.toMatchObject({ code: 'ABORTED' }); expect(f.store.openQuestion).not.toHaveBeenCalled();
  const afterOpen = new AbortController(); f.store.assignment.mockResolvedValue(f.assigned); f.store.openQuestion.mockImplementation(async () => { afterOpen.abort(); return f.saved; });
  await expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, afterOpen.signal)).rejects.toMatchObject({ code: 'ABORTED' });
});
it('validates factory and invocation contracts without invoking malformed host capabilities', async () => {
  const f = fixture(); expect(() => createCollaborationQuestionInbox(f.store, '')).toThrow(); expect(() => createCollaborationQuestionInbox({ ...f.store, assignment: false as never }, 'host-agent')).toThrow(); expect(() => createCollaborationQuestionInbox({ ...f.store, openQuestion: false as never }, 'host-agent')).toThrow();
  const inbox = createCollaborationQuestionInbox(f.store, 'host-agent');
  await expect(inbox.open(f.question, { ...f.binding, task: { ...f.binding.task, tenantId: 'other' } }, f.signal)).rejects.toThrow();
  await expect(inbox.open(f.question, { ...f.binding, gateKey: '' }, f.signal)).rejects.toThrow();
  await expect(inbox.open(f.question, f.binding, false as never)).rejects.toThrow(); expect(f.store.assignment).not.toHaveBeenCalled();
});
it('observes asynchronous storage rejection and preserves only safe error codes', async () => {
  const f = fixture(); f.store.assignment.mockImplementation(async () => { await Promise.resolve(); throw new Error('postgres://private:password@host'); });
  await expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, f.signal)).rejects.toMatchObject({ code: 'QUESTION_INBOX_FAILED', message: 'QUESTION_INBOX_FAILED: agent runtime (not_applicable)' });
  f.store.assignment.mockRejectedValue(new AgentPersistenceError('AGENT_TASK_NOT_FOUND'));
  await expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, f.signal)).rejects.toMatchObject({ code: 'AGENT_TASK_NOT_FOUND' });
  f.store.assignment.mockResolvedValue(f.assigned); f.store.openQuestion.mockRejectedValue(new AgentPersistenceError('secret:password'));
  await expect(createCollaborationQuestionInbox(f.store, 'host-agent').open(f.question, f.binding, f.signal)).rejects.toMatchObject({ code: 'QUESTION_INBOX_FAILED' });
});

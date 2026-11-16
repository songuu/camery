import { expect, it } from 'vitest';
import { digest } from '@camery/methods';
import { createIssue, createQuestion, submitQuestionAnswer, transitionTask, validateTaskTree } from '../src/collaboration.js';
import type { AgentTask, QuestionInput } from '../src/collaboration.js';

const task = (taskId = 'root', parentId: string | null = null): AgentTask => ({ taskId, parentId,
  agent: { id: 'producer', version: '1.0.0', digest: 'a'.repeat(64) }, input: { text: 'source' }, dependencies: [],
  scope: { tenantId: 'tenant-a', projectId: 'project-a', objectIds: ['source-a'] }, status: 'queued' });
const question = (): QuestionInput => ({ questionId: 'question-a', taskId: 'research', scope: { tenantId: 'tenant-a', projectId: 'project-a' }, objectIds: ['source-a'], prompt: 'Which source version?', choices: ['one', 'two'] });
const host = () => ({ tenantId: 'tenant-a', projectId: 'project-a', actorId: 'trusted-human' });

it('captures a scoped task tree with immutable agent pins and input', () => {
  const input = [task(), task('research', 'root'), { ...task('review', 'root'), dependencies: ['research'] }];
  const tree = validateTaskTree(input);
  input[1]!.agent.digest = 'b'.repeat(64); input[1]!.scope.objectIds.push('changed');
  expect(tree[1]!.agent.digest).toBe('a'.repeat(64)); expect(tree[1]!.scope.objectIds).toEqual(['source-a']);
  expect(Object.isFrozen(tree)).toBe(true); expect(Object.isFrozen(tree[1]!.input)).toBe(true);
});
it.each(['duplicate', 'different-tenant', 'different-project', 'missing-parent', 'parent-cycle', 'multiple-roots', 'missing-dependency', 'self-dependency', 'dependency-cycle', 'duplicate-dependency', 'duplicate-object'] as const)('rejects invalid full task trees: %s', kind => {
  const root = task(); const child = task('research', 'root'); const other = task('review', 'root'); const input = [root, child, other];
  if (kind === 'duplicate') other.taskId = child.taskId;
  if (kind === 'different-tenant') child.scope.tenantId = 'other';
  if (kind === 'different-project') child.scope.projectId = 'other';
  if (kind === 'missing-parent') child.parentId = 'absent';
  if (kind === 'parent-cycle') { child.parentId = other.taskId; other.parentId = child.taskId; }
  if (kind === 'multiple-roots') child.parentId = null;
  if (kind === 'missing-dependency') child.dependencies = ['absent'];
  if (kind === 'self-dependency') child.dependencies = [child.taskId];
  if (kind === 'dependency-cycle') { child.dependencies = [other.taskId]; other.dependencies = [child.taskId]; }
  if (kind === 'duplicate-dependency') other.dependencies = [child.taskId, child.taskId];
  if (kind === 'duplicate-object') child.scope.objectIds.push('source-a');
  expect(() => validateTaskTree(input)).toThrow();
});
it('rejects empty/unknown fields, missing roots and invalid agent pins', () => {
  for (const input of [[], [task('root', 'root')], [{ ...task(), token: 'secret' }], [{ ...task(), agent: { ...task().agent, digest: '' } }]]) expect(() => validateTaskTree(input)).toThrow();
});
it('prevents a delegated child from expanding its parent object scope', () => {
  const root = task(); const child = task('research', 'root'); child.scope.objectIds = ['other-source'];
  expect(() => validateTaskTree([root, child])).toThrow('INVALID_TASK_TREE');
});
it('handles a bounded deep tree iteratively and rejects a cycle at the tail', () => {
  const input = Array.from({ length: 1000 }, (_, index) => task(`task-${index}`, index ? `task-${index - 1}` : null));
  expect(validateTaskTree(input)).toHaveLength(1000);
  input[998]!.parentId = 'task-999'; expect(() => validateTaskTree(input)).toThrow('INVALID_TASK_TREE');
});
it('supports queued → running → waiting → running → succeeded without modifying prior states', () => {
  const queued = task(); const running = transitionTask(queued, { status: 'running' });
  const waiting = transitionTask(running, { status: 'waiting' }); const resumed = transitionTask(waiting, { status: 'running' });
  const done = transitionTask(resumed, { status: 'succeeded', output: { candidate: 'one' } });
  expect(queued.status).toBe('queued'); expect(done).toMatchObject({ status: 'succeeded', output: { candidate: 'one' } });
  expect(Object.isFrozen(done)).toBe(true); expect(Object.isFrozen(done.output)).toBe(true);
  expect(() => transitionTask(done, { status: 'running' })).toThrow('INVALID_TASK_TRANSITION');
});
it.each(['queued', 'running', 'waiting'] as const)('allows explicit cancellation from %s and never revives it', status => {
  const cancelled = transitionTask({ ...task(), status }, { status: 'cancelled' });
  expect(cancelled.status).toBe('cancelled'); expect(() => transitionTask(cancelled, { status: 'running' })).toThrow();
});
it('requires successful output, safe failure code and valid transitions', () => {
  const running = transitionTask(task(), { status: 'running' });
  expect(transitionTask(running, { status: 'succeeded', output: null })).toMatchObject({ status: 'succeeded', output: null });
  const failed = transitionTask(running, { status: 'failed', errorCode: 'MODEL_TIMEOUT' });
  expect(failed).toMatchObject({ status: 'failed', errorCode: 'MODEL_TIMEOUT' });
  for (const [input, change] of [[task(), { status: 'succeeded', output: {} }], [running, { status: 'succeeded' }], [running, { status: 'failed' }], [running, { status: 'failed', errorCode: 'secret provider URL' }], [running, { status: 'waiting', output: {} }], [failed, { status: 'running' }], [running, { status: 'running' }]]) expect(() => transitionTask(input as AgentTask, change as never)).toThrow();
});
it('records a located Issue with audience impact, proposed fix, ripple and evidence scope', () => {
  const input = { issueId: 'issue-a', taskId: 'review', scope: { tenantId: 'tenant-a', projectId: 'project-a' }, objectId: 'shot-a', path: '/dialogue/0', severity: 'major' as const, problem: 'The subject is unclear.', audienceImpact: 'The audience cannot follow the reveal.', suggestion: 'Name the speaker.', ripple: ['Recheck the next shot.'], evidenceScope: 'text' as const };
  const issue = createIssue(input); input.ripple.push('changed');
  expect(issue.ripple).toEqual(['Recheck the next shot.']); expect(Object.isFrozen(issue)).toBe(true);
  for (const wrong of [{ ...input, audienceImpact: '' }, { ...input, evidenceScope: 'rendered' }, { ...input, path: 'not/a/pointer' }, { ...input, path: '/bad~escape' }, { ...input, severity: 'unknown' }, { ...input, adopted: true }]) expect(() => createIssue(wrong as never)).toThrow('INVALID_ISSUE');
});
it('opens a question without an answer and binds explicit answers to host scope and stored digest', () => {
  const input = question(); const opened = createQuestion(input); input.choices.push('changed');
  expect(opened.status).toBe('open'); expect(opened).not.toHaveProperty('answer'); expect(opened.choices).toEqual(['one', 'two']);
  const answered = submitQuestionAnswer(opened, host(), 'two', opened.questionDigest);
  expect(opened.status).toBe('open'); expect(answered).toMatchObject({ status: 'answered', answer: { actorId: 'trusted-human', value: 'two' }, questionDigest: opened.questionDigest });
  expect(Object.isFrozen(answered.answer)).toBe(true); expect(() => submitQuestionAnswer(answered, host(), 'one', opened.questionDigest)).toThrow('QUESTION_ALREADY_ANSWERED');
});
it('supports captured free-form JSON answers when no choices are declared', () => {
  const opened = createQuestion({ ...question(), choices: [] }); const answer = { source: 'one' };
  const answered = submitQuestionAnswer(opened, host(), answer, opened.questionDigest); answer.source = 'changed';
  expect(answered.answer?.value).toEqual({ source: 'one' });
});
it.each(['tenant', 'project', 'actor', 'digest', 'prompt', 'choices', 'object', 'answer', 'extra'] as const)('rejects stale, cross-scope or malformed question submission: %s', kind => {
  const opened = createQuestion(question()); const changed = structuredClone(opened); const actor = host(); let stored = opened.questionDigest; let answer: unknown = 'one';
  if (kind === 'tenant') actor.tenantId = 'tenant-b';
  if (kind === 'project') actor.projectId = 'project-b';
  if (kind === 'actor') actor.actorId = '';
  if (kind === 'digest') stored = 'b'.repeat(64);
  if (kind === 'prompt') changed.prompt = 'changed';
  if (kind === 'choices') changed.choices = ['other'];
  if (kind === 'object') changed.objectIds = ['other'];
  if (kind === 'answer') answer = 'not-an-option';
  if (kind === 'extra') Object.assign(changed, { permission: 'admin' });
  expect(() => submitQuestionAnswer(changed, actor, answer as never, stored)).toThrow();
});
it('rejects duplicate choices and object ids and never includes source data in errors', () => {
  for (const input of [{ ...question(), choices: ['one', 'one'] }, { ...question(), objectIds: ['one', 'one'] }, { ...question(), prompt: '' }]) expect(() => createQuestion(input)).toThrow('INVALID_QUESTION');
  const opened = createQuestion(question()); const altered = { ...opened, prompt: 'https://secret:password@provider' };
  try { submitQuestionAnswer(altered, host(), 'one', opened.questionDigest); throw new Error('expected rejection'); }
  catch (error) { expect(String(error)).not.toContain('password'); }
  expect(opened.questionDigest).toMatch(/^[a-f0-9]{64}$/); expect(opened.questionDigest).not.toBe(digest('one'));
});

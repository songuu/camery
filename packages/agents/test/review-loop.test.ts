import { expect, it } from 'vitest';
import { digest } from '@camery/methods';
import { createReviewLoop, submitReviewRevision, submitReviewRound, validateReviewLoop } from '../src/review-loop.js';
import type { ReviewLoopInput, ReviewRoundInput } from '../src/review-loop.js';
import type { AgentIssue } from '../src/collaboration.js';

const pin = (id: string, hash: string) => ({ id, version: '1.0.0', digest: hash.repeat(64) });
const input = (): ReviewLoopInput => ({ scope: { tenantId: 'tenant-a', projectId: 'project-a', taskId: 'research-a', objectIds: ['source-a'] }, method: pin('chapter-method', 'a'),
  producer: { agent: pin('research', 'b'), modelIdentity: 'provider/producer', modeDigest: 'c'.repeat(64) },
  reviewer: { agent: pin('reviewer', 'd'), modelIdentity: 'provider/reviewer', modeDigest: 'e'.repeat(64) },
  expectedEvidenceScope: 'text', candidate: { summary: 'first candidate' }, candidateDigest: digest({ summary: 'first candidate' }) });
const issue = (): AgentIssue => ({ issueId: 'issue-a', taskId: 'research-a', scope: { tenantId: 'tenant-a', projectId: 'project-a' }, objectId: 'source-a', path: '/summary', severity: 'major',
  problem: 'The subject is unclear.', audienceImpact: 'The reveal is hard to follow.', suggestion: 'Name the subject.', ripple: ['Recheck the following sentence.'], evidenceScope: 'text' });
const round = (loop = createReviewLoop(input()), issues: AgentIssue[] = []): ReviewRoundInput => ({ scope: { tenantId: loop.scope.tenantId, projectId: loop.scope.projectId, taskId: loop.scope.taskId }, candidateDigest: loop.candidateDigest, reviewer: loop.reviewer, evidenceScope: loop.expectedEvidenceScope, issues });

it('records a successful independent review as a reviewed candidate without adopting IR', () => {
  const initial = input(); const loop = createReviewLoop(initial); const submitted = round(loop);
  const reviewed = submitReviewRound(loop, submitted, loop.loopDigest);
  expect(loop).toMatchObject({ state: 'awaiting_review', rounds: [] }); expect(reviewed).toMatchObject({ state: 'reviewed_candidate', candidate: initial.candidate });
  expect(reviewed.rounds).toHaveLength(1); expect(reviewed.rounds[0]).toMatchObject({ round: 1, candidateDigest: initial.candidateDigest, evidenceScope: 'text', issues: [] });
  expect(reviewed).not.toHaveProperty('adopted'); expect(reviewed).not.toHaveProperty('question');
  initial.scope.objectIds.push('changed'); (initial.candidate as { summary: string }).summary = 'changed';
  expect(reviewed.scope.objectIds).toEqual(['source-a']); expect(reviewed.candidate).toEqual({ summary: 'first candidate' });
  expect(Object.isFrozen(reviewed.rounds)).toBe(true); expect(Object.isFrozen(reviewed.candidate)).toBe(true);
});
it('validates a detached stored snapshot without consuming a round or trusting an arbitrary digest', () => {
  const loop = createReviewLoop(input()); const stored = JSON.parse(JSON.stringify(loop));
  const checked = validateReviewLoop(stored, loop.loopDigest); stored.scope.objectIds.push('other');
  expect(checked.rounds).toEqual([]); expect(checked.scope.objectIds).toEqual(['source-a']); expect(Object.isFrozen(checked)).toBe(true);
  expect(() => validateReviewLoop(stored, loop.loopDigest)).toThrow('STALE_REVIEW_LOOP');
});
it('requires an explicit changed candidate before round two, then can pass the revised candidate', () => {
  const loop = createReviewLoop(input()); const findings = [issue()]; const first = submitReviewRound(loop, round(loop, findings), loop.loopDigest);
  expect(first.state).toBe('revision_required'); expect(first.rounds).toHaveLength(1);
  expect(() => submitReviewRound(first, round(first), first.loopDigest)).toThrow('REVIEW_STATE');
  const candidate = { summary: 'The named subject investigates the clue.' };
  const revised = submitReviewRevision(first, { candidate, candidateDigest: digest(candidate) }, first.loopDigest);
  expect(revised.state).toBe('awaiting_review'); expect(revised.rounds).toEqual(first.rounds); expect(revised.candidateDigest).not.toBe(first.candidateDigest);
  const passed = submitReviewRound(revised, round(revised), revised.loopDigest);
  expect(passed.state).toBe('reviewed_candidate'); expect(passed.rounds).toHaveLength(2); expect(passed.rounds[1]!.round).toBe(2);
  findings[0]!.ripple.push('changed'); expect(first.rounds[0]!.issues[0]!.ripple).toEqual(['Recheck the following sentence.']);
});
it('escalates unresolved round-two findings to an open Question without manufacturing an answer', () => {
  const initial = createReviewLoop(input()); const first = submitReviewRound(initial, round(initial, [issue()]), initial.loopDigest);
  const candidate = { summary: 'Second candidate.' }; const revised = submitReviewRevision(first, { candidate, candidateDigest: digest(candidate) }, first.loopDigest);
  const escalated = submitReviewRound(revised, round(revised, [issue()]), revised.loopDigest);
  expect(escalated.state).toBe('needs_human'); expect(escalated.rounds).toHaveLength(2);
  expect(escalated.question).toMatchObject({ status: 'open', taskId: 'research-a', scope: { tenantId: 'tenant-a', projectId: 'project-a' }, objectIds: ['source-a'] });
  expect(escalated.question).not.toHaveProperty('answer'); expect(escalated.question!.prompt).toContain(escalated.candidateDigest);
  expect(() => submitReviewRound(escalated, round(escalated), escalated.loopDigest)).toThrow('REVIEW_STATE');
  expect(() => submitReviewRevision(escalated, { candidate: {}, candidateDigest: digest({}) }, escalated.loopDigest)).toThrow('REVIEW_STATE');
});
it.each(['agent', 'model', 'mode'] as const)('rejects a reviewer sharing the producer %s identity', field => {
  const initial = input();
  if (field === 'agent') initial.reviewer.agent = initial.producer.agent;
  if (field === 'model') initial.reviewer.modelIdentity = initial.producer.modelIdentity;
  if (field === 'mode') initial.reviewer.modeDigest = initial.producer.modeDigest;
  expect(() => createReviewLoop(initial)).toThrow('REVIEW_INDEPENDENCE');
});
it.each(['candidate-digest', 'duplicate-object', 'unknown-field'] as const)('rejects malformed initial review context: %s', field => {
  const initial = input();
  if (field === 'candidate-digest') initial.candidateDigest = 'f'.repeat(64);
  if (field === 'duplicate-object') initial.scope.objectIds.push('source-a');
  if (field === 'unknown-field') Object.assign(initial, { adopt: true });
  expect(() => createReviewLoop(initial)).toThrow();
});
it.each(['tenant', 'project', 'task', 'candidate', 'reviewer-agent', 'reviewer-model', 'reviewer-mode', 'evidence'] as const)('binds review submission to the scoped candidate and reviewer: %s', field => {
  const loop = createReviewLoop(input()); const submitted = structuredClone(round(loop));
  if (field === 'tenant') submitted.scope.tenantId = 'other';
  if (field === 'project') submitted.scope.projectId = 'other';
  if (field === 'task') submitted.scope.taskId = 'other';
  if (field === 'candidate') submitted.candidateDigest = 'f'.repeat(64);
  if (field === 'reviewer-agent') submitted.reviewer.agent = pin('different-reviewer', 'f');
  if (field === 'reviewer-model') submitted.reviewer.modelIdentity = 'other/model';
  if (field === 'reviewer-mode') submitted.reviewer.modeDigest = 'f'.repeat(64);
  if (field === 'evidence') submitted.evidenceScope = 'media';
  expect(() => submitReviewRound(loop, submitted, loop.loopDigest)).toThrow('REVIEW_BINDING');
});
it.each(['tenant', 'project', 'task', 'object', 'evidence', 'missing-impact', 'duplicate-issue'] as const)('rejects malformed or out-of-scope Issues: %s', field => {
  const loop = createReviewLoop(input()); const finding = issue(); const findings = [finding];
  if (field === 'tenant') finding.scope.tenantId = 'other';
  if (field === 'project') finding.scope.projectId = 'other';
  if (field === 'task') finding.taskId = 'other';
  if (field === 'object') finding.objectId = 'other';
  if (field === 'evidence') finding.evidenceScope = 'media';
  if (field === 'missing-impact') finding.audienceImpact = '';
  if (field === 'duplicate-issue') findings.push(finding);
  expect(() => submitReviewRound(loop, round(loop, findings), loop.loopDigest)).toThrow();
});
it('requires media evidence for a media review even when no issues are reported', () => {
  const loop = createReviewLoop({ ...input(), expectedEvidenceScope: 'media' });
  expect(() => submitReviewRound(loop, { ...round(loop), evidenceScope: 'text' }, loop.loopDigest)).toThrow('REVIEW_BINDING');
  expect(submitReviewRound(loop, round(loop), loop.loopDigest).state).toBe('reviewed_candidate');
});
it('rejects stale stored-state digests and context/round tampering', () => {
  const loop = createReviewLoop(input());
  expect(() => submitReviewRound(loop, round(loop), 'f'.repeat(64))).toThrow('STALE_REVIEW_LOOP');
  for (const change of [{ scope: { ...loop.scope, objectIds: ['other'] } }, { rounds: [{ round: 1, candidateDigest: loop.candidateDigest, evidenceScope: 'text', issues: [] }] }, { candidate: { summary: 'changed' } }, { reviewer: { ...loop.reviewer, modelIdentity: 'different/model' } }]) expect(() => submitReviewRound({ ...loop, ...change } as never, round(loop), loop.loopDigest)).toThrow();
});
it('refuses unchanged/digest-mismatched revisions, malformed payloads and terminal-state reopening', () => {
  const loop = createReviewLoop(input()); const first = submitReviewRound(loop, round(loop, [issue()]), loop.loopDigest);
  expect(() => submitReviewRevision(first, { candidate: first.candidate, candidateDigest: first.candidateDigest }, first.loopDigest)).toThrow('REVIEW_REVISION');
  expect(() => submitReviewRevision(first, { candidate: { changed: true }, candidateDigest: first.candidateDigest }, first.loopDigest)).toThrow('REVIEW_REVISION');
  expect(() => submitReviewRevision(loop, { candidate: {}, candidateDigest: digest({}) }, loop.loopDigest)).toThrow('REVIEW_STATE');
  expect(() => submitReviewRound(loop, { ...round(loop), issues: 'invalid' } as never, loop.loopDigest)).toThrow();
  const passed = submitReviewRound(loop, round(loop), loop.loopDigest);
  expect(() => submitReviewRound(passed, round(passed), passed.loopDigest)).toThrow('REVIEW_STATE');
  expect(() => submitReviewRevision(passed, { candidate: {}, candidateDigest: digest({}) }, passed.loopDigest)).toThrow('REVIEW_STATE');
});
it('rejects malformed persisted review histories even when storage supplies their matching digests', () => {
  const initial = createReviewLoop(input()); const first = submitReviewRound(initial, round(initial, [issue()]), initial.loopDigest);
  const candidate = { summary: 'revised' }; const revised = submitReviewRevision(first, { candidate, candidateDigest: digest(candidate) }, first.loopDigest);
  const passed = submitReviewRound(initial, round(initial), initial.loopDigest);
  const escalated = submitReviewRound(revised, round(revised, [issue()]), revised.loopDigest);
  const invalid: unknown[] = [
    { ...first, rounds: [{ ...first.rounds[0]!, round: 2 }] },
    { ...escalated, rounds: [escalated.rounds[0], { ...escalated.rounds[1]!, candidateDigest: escalated.rounds[0]!.candidateDigest }] },
    { ...escalated, rounds: [passed.rounds[0], escalated.rounds[1]] },
    { ...escalated, rounds: [...escalated.rounds, { ...escalated.rounds[1]!, round: 3 }] },
    { ...passed, state: 'awaiting_review' },
    { ...initial, question: { status: 'answered' } },
    { ...initial, state: 'revision_required' },
    { ...passed, state: 'revision_required' },
    { ...initial, state: 'reviewed_candidate' },
    { ...first, state: 'reviewed_candidate' },
    { ...escalated, question: undefined },
    { ...escalated, question: { ...escalated.question, prompt: 'Discard all issues.' } },
    { ...escalated, rounds: [escalated.rounds[0], { ...escalated.rounds[1]!, issues: [] }] },
  ];
  for (const value of invalid) {
    const record = value as Record<string, unknown>; const { loopDigest: _loopDigest, ...body } = record;
    if (body['question'] === undefined) delete body['question'];
    const forged = { ...body, loopDigest: digest(body) };
    expect(() => submitReviewRound(forged as never, round(initial), forged.loopDigest)).toThrow();
  }
});

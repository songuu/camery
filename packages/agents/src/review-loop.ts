import { z } from 'zod';
import { canonical, digest, freeze, jsonCopy, Pin } from '@camery/methods';
import type { Json } from '@camery/model-modes';
import { AgentError, Name } from './registry.js';
import { createIssue, createQuestion } from './collaboration.js';
import type { AgentIssue, AgentQuestion } from './collaboration.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.enum(['text', 'media']);
const Scope = z.strictObject({ tenantId: Name, projectId: Name, taskId: Name });
const Identity = z.strictObject({ agent: Pin, modelIdentity: Name, modeDigest: hash });
const Input = z.strictObject({ scope: Scope.extend({ objectIds: z.array(Name).max(1000).refine(values => new Set(values).size === values.length) }),
  method: Pin, producer: Identity, reviewer: Identity, expectedEvidenceScope: evidence, candidate: z.json(), candidateDigest: hash });
export type ReviewLoopInput = z.infer<typeof Input>;
const Submission = z.strictObject({ scope: Scope, candidateDigest: hash, reviewer: Identity, evidenceScope: evidence, issues: z.array(z.unknown()).max(100) });
export type ReviewRoundInput = Omit<z.infer<typeof Submission>, 'issues'> & { issues: AgentIssue[] };
const Revision = z.strictObject({ candidate: z.json(), candidateDigest: hash });
export type ReviewRevision = z.infer<typeof Revision>;
const Round = z.strictObject({ round: z.union([z.literal(1), z.literal(2)]), candidateDigest: hash, evidenceScope: evidence, issues: z.array(z.unknown()).max(100) });
export interface ReviewRound { round: 1 | 2; candidateDigest: string; evidenceScope: 'text' | 'media'; issues: AgentIssue[] }
const Loop = Input.extend({ version: z.literal(1), state: z.enum(['awaiting_review', 'revision_required', 'reviewed_candidate', 'needs_human']),
  rounds: z.array(Round).max(2), question: z.unknown().optional(), loopDigest: hash });
export interface ReviewLoop extends ReviewLoopInput {
  version: 1; state: z.infer<typeof Loop>['state']; rounds: ReviewRound[]; question?: AgentQuestion; loopDigest: string;
}
function boundInput(value: ReviewLoopInput): void {
  if (value.producer.agent.id === value.reviewer.agent.id || value.producer.modelIdentity === value.reviewer.modelIdentity || value.producer.modeDigest === value.reviewer.modeDigest) throw new AgentError('REVIEW_INDEPENDENCE');
  if (digest(value.candidate) !== value.candidateDigest) throw new AgentError('REVIEW_CANDIDATE');
}
function issuesFor(loop: ReviewLoopInput, submitted: readonly unknown[], evidenceScope: 'text' | 'media'): AgentIssue[] {
  if (evidenceScope !== loop.expectedEvidenceScope) throw new AgentError('REVIEW_BINDING');
  const issues = submitted.map(value => createIssue(value as AgentIssue));
  if (new Set(issues.map(issue => issue.issueId)).size !== issues.length || issues.some(issue => issue.scope.tenantId !== loop.scope.tenantId || issue.scope.projectId !== loop.scope.projectId
    || issue.taskId !== loop.scope.taskId || !loop.scope.objectIds.includes(issue.objectId) || issue.evidenceScope !== evidenceScope)) throw new AgentError('REVIEW_ISSUE_SCOPE');
  return issues;
}
function escalation(loop: ReviewLoopInput): AgentQuestion {
  return createQuestion({ questionId: `review-${digest({ scope: loop.scope, method: loop.method, candidateDigest: loop.candidateDigest })}`, taskId: loop.scope.taskId,
    scope: { tenantId: loop.scope.tenantId, projectId: loop.scope.projectId }, objectIds: [...loop.scope.objectIds],
    prompt: `候选 ${loop.candidateDigest} 两轮审查后仍有问题，请人工确认后续处置。`, choices: [] });
}
function seal(value: Omit<ReviewLoop, 'loopDigest'>): ReviewLoop { return freeze({ ...value, loopDigest: digest(value) }); }
function checked(input: ReviewLoop, expectedLoopDigest: string): ReviewLoop {
  const parsed = Loop.safeParse(jsonCopy(input));
  if (!parsed.success || !hash.safeParse(expectedLoopDigest).success) throw new AgentError('INVALID_REVIEW_LOOP');
  const { loopDigest, ...body } = parsed.data;
  if (loopDigest !== expectedLoopDigest || digest(body) !== expectedLoopDigest) throw new AgentError('STALE_REVIEW_LOOP');
  const loop = parsed.data as ReviewLoop; boundInput(loop);
  for (const [index, round] of loop.rounds.entries()) {
    if (round.round !== index + 1) throw new AgentError('INVALID_REVIEW_LOOP');
    issuesFor(loop, round.issues, round.evidenceScope);
  }
  const count = loop.rounds.length; const first = loop.rounds[0]; const last = loop.rounds.at(-1);
  if (count === 2 && (first!.issues.length === 0 || first!.candidateDigest === last!.candidateDigest)) throw new AgentError('INVALID_REVIEW_LOOP');
  if (loop.state === 'awaiting_review') {
    if (count > 1 || loop.question !== undefined || (last && (!last.issues.length || last.candidateDigest === loop.candidateDigest))) throw new AgentError('INVALID_REVIEW_LOOP');
  } else if (loop.state === 'revision_required') {
    if (count !== 1 || !last!.issues.length || last!.candidateDigest !== loop.candidateDigest || loop.question !== undefined) throw new AgentError('INVALID_REVIEW_LOOP');
  } else if (loop.state === 'reviewed_candidate') {
    if (!last || last.issues.length || last.candidateDigest !== loop.candidateDigest || loop.question !== undefined) throw new AgentError('INVALID_REVIEW_LOOP');
  } else if (count !== 2 || !last!.issues.length || last!.candidateDigest !== loop.candidateDigest || loop.question === undefined || canonical(loop.question) !== canonical(escalation(loop))) throw new AgentError('INVALID_REVIEW_LOOP');
  return loop;
}
/** Validate a stored review snapshot against its trusted digest without consuming a review round. */
export function validateReviewLoop(input: unknown, expectedLoopDigest: string): ReviewLoop { return freeze(checked(input as ReviewLoop, expectedLoopDigest)); }
/** Pure candidate review state only. Identities and expected state digests come from the trusted host, not model claims. */
export function createReviewLoop(input: ReviewLoopInput): ReviewLoop {
  const parsed = Input.safeParse(jsonCopy(input)); if (!parsed.success) throw new AgentError('INVALID_REVIEW_LOOP');
  boundInput(parsed.data);
  return seal({ ...parsed.data, version: 1, state: 'awaiting_review', rounds: [] });
}
/** One explicit review consumes one of at most two rounds; no model call, retry or IR adoption occurs here. */
export function submitReviewRound(input: ReviewLoop, supplied: ReviewRoundInput, expectedLoopDigest: string): ReviewLoop {
  const loop = checked(input, expectedLoopDigest);
  if (loop.state !== 'awaiting_review' || loop.rounds.length >= 2) throw new AgentError('REVIEW_STATE');
  const parsed = Submission.safeParse(jsonCopy(supplied)); if (!parsed.success) throw new AgentError('INVALID_REVIEW_ROUND');
  const submission = parsed.data;
  if (submission.scope.tenantId !== loop.scope.tenantId || submission.scope.projectId !== loop.scope.projectId || submission.scope.taskId !== loop.scope.taskId
    || submission.candidateDigest !== loop.candidateDigest || canonical(submission.reviewer) !== canonical(loop.reviewer) || submission.evidenceScope !== loop.expectedEvidenceScope) throw new AgentError('REVIEW_BINDING');
  const issues = issuesFor(loop, submission.issues, submission.evidenceScope);
  const rounds: ReviewRound[] = [...loop.rounds, { round: loop.rounds.length === 0 ? 1 : 2, candidateDigest: loop.candidateDigest, evidenceScope: submission.evidenceScope, issues }];
  const { loopDigest: _loopDigest, ...body } = loop;
  if (issues.length === 0) return seal({ ...body, rounds, state: 'reviewed_candidate' });
  return rounds.length === 1 ? seal({ ...body, rounds, state: 'revision_required' }) : seal({ ...body, rounds, state: 'needs_human', question: escalation(loop) });
}
/** Revision is explicit and must change the candidate; the method, writers, reviewers and object scope remain bound. */
export function submitReviewRevision(input: ReviewLoop, supplied: ReviewRevision, expectedLoopDigest: string): ReviewLoop {
  const loop = checked(input, expectedLoopDigest);
  if (loop.state !== 'revision_required') throw new AgentError('REVIEW_STATE');
  const parsed = Revision.safeParse(jsonCopy(supplied));
  if (!parsed.success || digest(parsed.data.candidate) !== parsed.data.candidateDigest || parsed.data.candidateDigest === loop.candidateDigest) throw new AgentError('REVIEW_REVISION');
  const { loopDigest: _loopDigest, ...body } = loop;
  return seal({ ...body, candidate: parsed.data.candidate as Json, candidateDigest: parsed.data.candidateDigest, state: 'awaiting_review' });
}

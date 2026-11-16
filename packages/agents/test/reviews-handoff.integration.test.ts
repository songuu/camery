import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { DurableWorker, migrateDurable, PostgresDurableStore } from '@camery/durable';
import type { Json } from '@camery/durable';
import { digest } from '@camery/methods';
import { AgentRegistry } from '../src/registry.js';
import { relayOutbox } from '../src/relay.js';
import { submitReviewRound } from '../src/review-loop.js';
import type { ReviewLoopInput, ReviewRoundInput } from '../src/review-loop.js';
import type { AgentIssue, AgentTask } from '../src/collaboration.js';
import { PostgresCollaborationStore } from '../src/node/collaboration-store.js';
import type { CollaborationTransactions } from '../src/node/collaboration-types.js';
import { PostgresReviewStore } from '../src/node/reviews.js';
import type { ReviewOperation, ReviewSnapshot } from '../src/node/reviews.js';
import { migrateAgents } from '../src/node/migrate.js';

const databaseUrl = process.env['CAMERY_TEST_DATABASE_URL'];
if (!databaseUrl) throw new Error('CAMERY_TEST_DATABASE_URL is required for persistent review handoff tests');
const pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000 }); const durable = new PostgresDurableStore(pool);
beforeAll(async () => { await migrateDurable(pool); await migrateAgents(pool); }); afterAll(async () => { await pool.end(); });
const agents = new AgentRegistry(); const method = { id: 'original-summary', version: '1.0.0', digest: 'a'.repeat(64) };
const definition = { version: '1.0.0', instructions: 'Propose a candidate; never adopt IR.', tools: [], methods: [method], modelTier: 'balanced' as const, writeKinds: [],
  budget: { maxSteps: 8, maxTokens: 1000, maxCostMicros: 1000, currency: 'CNY' }, outputSchema: { type: 'object' as const, properties: { summary: { type: 'string' as const } }, required: ['summary'], additionalProperties: false } };
const producer = agents.register({ ...definition, id: 'research' }); const reviewer = agents.register({ ...definition, id: 'reviewer', instructions: 'Independently review only; do not adopt IR.' });
const collaboration = new PostgresCollaborationStore(pool, agents); const reviews = new PostgresReviewStore(collaboration, agents);
async function fixture() {
  const scope = { tenantId: randomUUID(), projectId: randomUUID() }; const key = { ...scope, taskId: randomUUID() }; const treeKey = { ...scope, treeId: randomUUID() };
  const task: AgentTask = { taskId: key.taskId, parentId: null, agent: producer, input: { summary: 'source' }, dependencies: [], scope: { ...scope, objectIds: ['source-a'] }, status: 'queued' };
  await collaboration.createTree({ ...treeKey, tasks: [task], routes: [{ agent: producer, workflow: 'review-handoff', version: 1, maxAttempts: 1, outputKind: 'raw' }] }, 'host-producer');
  const input: ReviewLoopInput = { scope: { ...key, objectIds: ['source-a'] }, method, producer: { agent: producer, modelIdentity: 'synthetic/producer', modeDigest: 'b'.repeat(64) },
    reviewer: { agent: reviewer, modelIdentity: 'synthetic/reviewer', modeDigest: 'c'.repeat(64) }, expectedEvidenceScope: 'text', candidate: { summary: 'First candidate.' }, candidateDigest: digest({ summary: 'First candidate.' }) };
  return { scope, key, treeKey, input, reviewId: randomUUID() };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function finding(f: Fixture, issueId = 'round-one'): AgentIssue { return { issueId, taskId: f.key.taskId, scope: f.scope, objectId: 'source-a', path: '/summary', severity: 'major', problem: 'Subject unclear.', audienceImpact: 'The reveal is unclear.', suggestion: 'Name the subject.', ripple: ['Recheck the next sentence.'], evidenceScope: 'text' }; }
function round(snapshot: ReviewSnapshot, issues: AgentIssue[] = []): ReviewRoundInput { const loop = snapshot.loop; return { scope: { tenantId: loop.scope.tenantId, projectId: loop.scope.projectId, taskId: loop.scope.taskId }, candidateDigest: loop.candidateDigest, reviewer: loop.reviewer, evidenceScope: loop.expectedEvidenceScope, issues }; }
function operation(snapshot: ReviewSnapshot, change: ReviewOperation['change']): ReviewOperation { return { operationId: randomUUID(), actorId: 'host-reviewer', expectedRevision: snapshot.revision, expectedDigest: snapshot.loop.loopDigest, change }; }
async function revised(f: Fixture, gateKey?: string) {
  const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-producer', gateKey);
  const first = await reviews.apply(f.key, f.reviewId, operation(initial, { kind: 'round', submission: round(initial, [finding(f)]) }));
  const candidate = { summary: 'A revised candidate still requires independent review.' };
  return reviews.apply(f.key, f.reviewId, operation(first, { kind: 'revision', submission: { candidate, candidateDigest: digest(candidate) } }));
}
it('hands an unresolved second round to a durable Question gate and resumes only after an explicit host answer', async () => {
  const f = await fixture(); await collaboration.queueReady(f.treeKey); expect((await relayOutbox(collaboration, durable, f.scope)).pending).toEqual([]);
  const savedTask = await collaboration.loadTask(f.key); if (!savedTask.durableTaskId) throw new Error('Expected a real dispatched task'); const physical = { tenantId: f.scope.tenantId, taskId: savedTask.durableTaskId };
  const second = await revised(f, 'review.handoff'); const final = await reviews.apply(f.key, f.reviewId, operation(second, { kind: 'round', submission: round(second, [finding(f, 'round-two')]) }));
  const question = final.loop.question!; const opened = await collaboration.getQuestion(f.key, question.questionId);
  expect(final.loop.state).toBe('needs_human'); expect(opened).toMatchObject({ question, gateKey: 'review.handoff', durableTaskId: physical.taskId, delivery: 'none' });
  const gateInput = JSON.parse(JSON.stringify(question)) as Json; const worker = new DurableWorker(durable);
  worker.register({ name: 'review-handoff', version: 1, async run(_input, ctx) {
    const answer = await ctx.waitForSignal('review.handoff', gateInput);
    expect(answer).toEqual({ questionDigest: question.questionDigest, answer: { direction: 'revise-manually' } });
    return { summary: 'The host received a manual follow-up instruction.' };
  } });
  expect((await worker.runOne(f.scope.tenantId, 'waiting-review-worker'))?.status).toBe('waiting');
  await collaboration.answerQuestion(f.key, question.questionId, 'host-human', { direction: 'revise-manually' }, question.questionDigest);
  const delivered = await relayOutbox(collaboration, durable, f.scope); expect(delivered.pending).toEqual([]); expect(delivered.delivered).toHaveLength(1);
  expect((await worker.runOne(f.scope.tenantId, 'resumed-review-worker'))?.status).toBe('succeeded'); expect(await worker.runOne(f.scope.tenantId, 'idle-review-worker')).toBeNull();
  expect((await collaboration.getQuestion(f.key, question.questionId)).delivery).toBe('delivered');
  expect(await reviews.get(f.key, f.reviewId)).toEqual(final); expect(final.loop).not.toHaveProperty('adopted'); expect(final.loop.state).toBe('needs_human');
  expect((await collaboration.loadTask(f.key)).task).not.toHaveProperty('output');
  expect((await durable.events(physical)).filter(event => event.action === 'gate_signalled')).toHaveLength(1);
  expect(await relayOutbox(collaboration, durable, f.scope)).toEqual({ delivered: [], pending: [] });
});
it.each(['not-a-revision', String(Number.MAX_SAFE_INTEGER + 1)])('rejects an invalid revision returned by a faulty storage adapter: %s', async revision => {
  const f = await fixture(); const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-producer');
  const transactions: CollaborationTransactions = { withTask: (key, run) => collaboration.withTask(key, async tx => {
    const original = tx.client.query.bind(tx.client);
    const query = vi.spyOn(tx.client, 'query').mockImplementation((async (sql: string, values?: unknown[]) => {
      const result = await original(sql, values);
      if (sql.startsWith('SELECT initial_digest,record,revision::text,gate_key FROM camery_agents.agent_reviews')) return { ...result, rows: result.rows.map((row: Record<string, unknown>) => ({ ...row, revision })) };
      return result;
    }) as never);
    try { return await run(tx); } finally { query.mockRestore(); }
  }) };
  await expect(new PostgresReviewStore(transactions, agents).get(f.key, f.reviewId)).rejects.toMatchObject({ code: 'REVIEW_CORRUPT' });
  expect(await reviews.get(f.key, f.reviewId)).toEqual(initial);
});
async function zeroInsert(f: Fixture, table: 'agent_reviews' | 'agent_review_ops', run: () => Promise<void>) {
  const name = `review_zero_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE FUNCTION camery_agents.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.scope.tenantId}' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON camery_agents.${table} FOR EACH ROW EXECUTE FUNCTION camery_agents.${name}()`);
  try { await run(); } finally { await pool.query(`DROP TRIGGER ${name} ON camery_agents.${table}`); await pool.query(`DROP FUNCTION camery_agents.${name}()`); }
}
it('does not create or audit a review when its INSERT affects zero rows', async () => {
  const f = await fixture();
  await zeroInsert(f, 'agent_reviews', async () => {
    await expect(reviews.create(f.key, f.reviewId, f.input, 'host-producer')).rejects.toMatchObject({ code: 'REVIEW_WRITE_FAILED' });
    const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM camery_agents.agent_events WHERE tenant_id=$1 AND project_id=$2 AND action='review_created'", [f.scope.tenantId, f.scope.projectId]); expect(result.rows[0]!.count).toBe('0');
    await expect(reviews.get(f.key, f.reviewId)).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
  });
  expect((await reviews.create(f.key, f.reviewId, f.input, 'host-producer')).revision).toBe(0);
});
it('rolls a second-round review, new Issue and escalation Question back when operation INSERT affects zero rows', async () => {
  const f = await fixture(); const second = await revised(f); const op = operation(second, { kind: 'round', submission: round(second, [finding(f, 'round-two')]) });
  await zeroInsert(f, 'agent_review_ops', async () => {
    await expect(reviews.apply(f.key, f.reviewId, op)).rejects.toMatchObject({ code: 'REVIEW_WRITE_FAILED' }); expect(await reviews.get(f.key, f.reviewId)).toEqual(second);
    expect((await collaboration.listIssues(f.key)).items.map(issue => issue.issueId)).toEqual(['round-one']);
    const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM camery_agents.agent_questions WHERE tenant_id=$1 AND project_id=$2', [f.scope.tenantId, f.scope.projectId]); expect(result.rows[0]!.count).toBe('0');
  });
  const completed = await reviews.apply(f.key, f.reviewId, op); expect(completed.loop.state).toBe('needs_human'); expect(await reviews.apply(f.key, f.reviewId, op)).toEqual(completed);
});
it('refuses to relabel an already answered Question as a fresh open review escalation', async () => {
  const f = await fixture(); const second = await revised(f); const submission = round(second, [finding(f, 'round-two')]); const expected = submitReviewRound(second.loop, submission, second.loop.loopDigest).question!;
  const opened = await collaboration.openQuestion(f.key, { questionId: expected.questionId, taskId: expected.taskId, scope: expected.scope, objectIds: expected.objectIds, prompt: expected.prompt, choices: expected.choices }, 'host-agent');
  await collaboration.answerQuestion(f.key, expected.questionId, 'host-human', 'Already escalated separately.', opened.question.questionDigest);
  await expect(reviews.apply(f.key, f.reviewId, operation(second, { kind: 'round', submission }))).rejects.toMatchObject({ code: 'REVIEW_QUESTION_CONFLICT' });
  expect(await reviews.get(f.key, f.reviewId)).toEqual(second); expect((await collaboration.listIssues(f.key)).items.map(issue => issue.issueId)).toEqual(['round-one']);
  expect((await collaboration.getQuestion(f.key, expected.questionId)).question.status).toBe('answered');
});
it('normalizes a transaction capability failure without exposing its diagnostic and rejects malformed Issue results', async () => {
  const f = await fixture(); const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-producer');
  const unavailable: CollaborationTransactions = { withTask: async () => { throw new Error('postgres://private:password@host'); } };
  await expect(new PostgresReviewStore(unavailable, agents).get(f.key, f.reviewId)).rejects.toMatchObject({ code: 'REVIEW_STORAGE_FAILED', message: 'REVIEW_STORAGE_FAILED: agent persistence' });
  expect(() => new PostgresReviewStore({ withTask: false as never }, agents)).toThrow('INVALID_COLLABORATION_INPUT');
  await expect(reviews.apply(f.key, f.reviewId, operation(initial, { kind: 'round', submission: round(initial, [{ ...finding(f), audienceImpact: '' }]) }))).rejects.toMatchObject({ code: 'INVALID_ISSUE' });
  expect(await reviews.get(f.key, f.reviewId)).toEqual(initial);
});

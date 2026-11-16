import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrateDurable } from '@camery/durable';
import { digest } from '@camery/methods';
import { AgentRegistry } from '../src/registry.js';
import { PostgresCollaborationStore } from '../src/node/collaboration-store.js';
import { migrateAgents } from '../src/node/migrate.js';
import { PostgresReviewStore } from '../src/node/reviews.js';
import type { ReviewOperation, ReviewSnapshot } from '../src/node/reviews.js';
import type { ReviewLoopInput, ReviewRoundInput } from '../src/review-loop.js';
import type { AgentIssue, AgentTask } from '../src/collaboration.js';

const url = process.env['CAMERY_TEST_DATABASE_URL'];
if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required for persistent review tests');
const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 });
const agents = new AgentRegistry();
const contract = { type: 'object' as const, properties: { summary: { type: 'string' as const } }, required: ['summary'], additionalProperties: false };
const method = { id: 'original-summary', version: '1.0.0', digest: 'a'.repeat(64) };
const definition = { version: '1.0.0', instructions: 'Propose one scoped candidate only.', tools: [], methods: [method], modelTier: 'balanced' as const, writeKinds: [],
  budget: { maxSteps: 3, maxTokens: 1000, maxCostMicros: 1000, currency: 'CNY' }, outputSchema: contract };
const producer = agents.register({ ...definition, id: 'research' }); const reviewer = agents.register({ ...definition, id: 'reviewer', instructions: 'Independently review the scoped candidate.' });
const collaboration = new PostgresCollaborationStore(pool, agents); const reviews = new PostgresReviewStore(collaboration, agents);
beforeAll(async () => { await migrateDurable(pool); await migrateAgents(pool); }); afterAll(async () => { await pool.end(); });
async function fixture() {
  const key = { tenantId: randomUUID(), projectId: randomUUID(), taskId: randomUUID() }; const treeKey = { tenantId: key.tenantId, projectId: key.projectId, treeId: randomUUID() };
  const task: AgentTask = { taskId: key.taskId, parentId: null, agent: producer, input: { source: 'original' }, dependencies: [], scope: { tenantId: key.tenantId, projectId: key.projectId, objectIds: ['source-a'] }, status: 'queued' };
  await collaboration.createTree({ ...treeKey, tasks: [task], routes: [{ agent: producer, workflow: 'review-test', version: 1, maxAttempts: 1, outputKind: 'raw' }] }, 'host-operator');
  const input: ReviewLoopInput = { scope: { ...key, objectIds: ['source-a'] }, method, producer: { agent: producer, modelIdentity: 'synthetic-provider/producer', modeDigest: 'b'.repeat(64) },
    reviewer: { agent: reviewer, modelIdentity: 'synthetic-provider/reviewer', modeDigest: 'c'.repeat(64) }, expectedEvidenceScope: 'text', candidate: { summary: 'Original candidate.' }, candidateDigest: digest({ summary: 'Original candidate.' }) };
  return { key, treeKey, input, reviewId: randomUUID() };
}
function issue(input: ReviewLoopInput, issueId = 'issue-a'): AgentIssue {
  return { issueId, taskId: input.scope.taskId, scope: { tenantId: input.scope.tenantId, projectId: input.scope.projectId }, objectId: 'source-a', path: '/summary', severity: 'major', problem: 'Subject unclear.', audienceImpact: 'The reveal is unclear.', suggestion: 'Name the subject.', ripple: ['Recheck the next sentence.'], evidenceScope: 'text' };
}
function round(snapshot: ReviewSnapshot, issues: AgentIssue[] = []): ReviewRoundInput {
  const loop = snapshot.loop; return { scope: { tenantId: loop.scope.tenantId, projectId: loop.scope.projectId, taskId: loop.scope.taskId }, candidateDigest: loop.candidateDigest, reviewer: loop.reviewer, evidenceScope: loop.expectedEvidenceScope, issues };
}
function operation(snapshot: ReviewSnapshot, change: ReviewOperation['change'], operationId = randomUUID()): ReviewOperation {
  return { operationId, actorId: 'host-operator', expectedRevision: snapshot.revision, expectedDigest: snapshot.loop.loopDigest, change };
}
it('persists an exactly idempotent scoped review and returns immutable validated snapshots', async () => {
  const f = await fixture(); const first = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  expect(first.revision).toBe(0); expect(first.loop.state).toBe('awaiting_review'); expect(Object.isFrozen(first.loop)).toBe(true);
  expect(await reviews.create(f.key, f.reviewId, f.input, 'second-host')).toEqual(first); expect(await reviews.get(f.key, f.reviewId)).toEqual(first);
  await expect(reviews.create(f.key, f.reviewId, { ...f.input, candidate: { summary: 'Changed' }, candidateDigest: digest({ summary: 'Changed' }) }, 'host-operator')).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
  expect((await collaboration.loadTask(f.key)).task.status).toBe('queued');
});
it('returns the operation historical snapshot after later revisions instead of the new head', async () => {
  const f = await fixture(); const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  const firstOp = operation(initial, { kind: 'round', submission: round(initial, [issue(f.input)]) }); const first = await reviews.apply(f.key, f.reviewId, firstOp);
  const candidate = { summary: 'A named subject investigates the clue.' }; const revisionOp = operation(first, { kind: 'revision', submission: { candidate, candidateDigest: digest(candidate) } });
  const revised = await reviews.apply(f.key, f.reviewId, revisionOp); expect(revised.revision).toBe(2);
  expect(await reviews.apply(f.key, f.reviewId, firstOp)).toEqual(first); expect((await reviews.get(f.key, f.reviewId)).revision).toBe(2);
  for (const changes of [{ actorId: 'different-host' }, { expectedRevision: firstOp.expectedRevision + 1 }, { expectedDigest: 'f'.repeat(64) }, { change: { kind: 'round' as const, submission: round(initial) } }]) await expect(reviews.apply(f.key, f.reviewId, { ...firstOp, ...changes })).rejects.toMatchObject({ code: 'REVIEW_OPERATION_CONFLICT' });
  expect((await collaboration.listIssues(f.key)).items).toEqual([issue(f.input)]);
});
it('serializes competing reviewers using both revision and digest CAS', async () => {
  const f = await fixture(); const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  const changes = [operation(initial, { kind: 'round', submission: round(initial) }), operation(initial, { kind: 'round', submission: round(initial) })];
  const results = await Promise.allSettled(changes.map(change => reviews.apply(f.key, f.reviewId, change)));
  expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'REVIEW_CONFLICT' } });
  expect((await reviews.get(f.key, f.reviewId)).revision).toBe(1);
});
it('persists two review rounds, their Issues and the exact open escalation Question atomically', async () => {
  const f = await fixture(); const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  const first = await reviews.apply(f.key, f.reviewId, operation(initial, { kind: 'round', submission: round(initial, [issue(f.input)]) }));
  const candidate = { summary: 'Revised but unresolved candidate.' };
  const revised = await reviews.apply(f.key, f.reviewId, operation(first, { kind: 'revision', submission: { candidate, candidateDigest: digest(candidate) } }));
  const final = await reviews.apply(f.key, f.reviewId, operation(revised, { kind: 'round', submission: round(revised, [issue(f.input, 'issue-b')]) }));
  expect(final).toMatchObject({ revision: 3, loop: { state: 'needs_human' } });
  const stored = await collaboration.getQuestion(f.key, final.loop.question!.questionId); expect(stored.question).toEqual(final.loop.question); expect(stored.question.status).toBe('open');
  expect((await collaboration.listIssues(f.key)).items.map((value: AgentIssue) => value.issueId).sort()).toEqual(['issue-a', 'issue-b']);
  await expect(reviews.apply(f.key, f.reviewId, operation(final, { kind: 'round', submission: round(final) }))).rejects.toThrow();
  expect((await collaboration.loadTask(f.key)).task).not.toHaveProperty('output');
});
it('rejects cross-scope, expanded-object, unregistered-role, self-review and schema-invalid candidates', async () => {
  const f = await fixture();
  const wrong: ReviewLoopInput[] = [
    { ...f.input, scope: { ...f.input.scope, tenantId: randomUUID() } }, { ...f.input, scope: { ...f.input.scope, taskId: randomUUID() } }, { ...f.input, scope: { ...f.input.scope, objectIds: ['other'] } },
    { ...f.input, producer: { ...f.input.producer, agent: reviewer } }, { ...f.input, reviewer: { ...f.input.reviewer, agent: { ...reviewer, digest: 'f'.repeat(64) } } },
    { ...f.input, reviewer: f.input.producer }, { ...f.input, candidate: { other: 'Wrong shape' }, candidateDigest: digest({ other: 'Wrong shape' }) },
  ];
  for (const value of wrong) await expect(reviews.create(f.key, randomUUID(), value, 'host-operator')).rejects.toThrow();
  const snapshot = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  await expect(reviews.get({ ...f.key, tenantId: randomUUID() }, f.reviewId)).rejects.toThrow();
  await expect(reviews.apply(f.key, f.reviewId, operation(snapshot, { kind: 'round', submission: { ...round(snapshot), evidenceScope: 'media' } }))).rejects.toThrow();
  const first = await reviews.apply(f.key, f.reviewId, operation(snapshot, { kind: 'round', submission: round(snapshot, [issue(f.input)]) }));
  await expect(reviews.apply(f.key, f.reviewId, operation(first, { kind: 'revision', submission: { candidate: { other: true }, candidateDigest: digest({ other: true }) } }))).rejects.toThrow();
  expect(await reviews.get(f.key, f.reviewId)).toEqual(first);
});
it.each([{ id: 'unallowed-method' }, { version: '1.0.1' }, { digest: 'f'.repeat(64) }])('requires the producer declared method full pin (%j)', async change => {
  const f = await fixture();
  await expect(reviews.create(f.key, f.reviewId, { ...f.input, method: { ...f.input.method, ...change } }, 'host-operator')).rejects.toMatchObject({ code: 'REVIEW_METHOD_BINDING' });
  const rows = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM camery_agents.agent_reviews WHERE tenant_id=$1 AND project_id=$2', [f.key.tenantId, f.key.projectId]);
  expect(rows.rows[0]!.count).toBe('0');
});
it('checks stored loop digests on reads and refuses a wrong expected digest without modifying the head', async () => {
  const f = await fixture(); const snapshot = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  await expect(reviews.apply(f.key, f.reviewId, { ...operation(snapshot, { kind: 'round', submission: round(snapshot) }), expectedDigest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
  await expect(reviews.get(f.key, randomUUID())).rejects.toMatchObject({ code: 'REVIEW_NOT_FOUND' });
  await pool.query("UPDATE camery_agents.agent_reviews SET record=jsonb_set(record,'{candidateDigest}',to_jsonb($5::text)) WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3 AND review_id=$4", [f.key.tenantId, f.key.projectId, f.key.taskId, f.reviewId, 'f'.repeat(64)]);
  await expect(reviews.get(f.key, f.reviewId)).rejects.toMatchObject({ code: 'STALE_REVIEW_LOOP' });
});
it('requires an affected CAS row before saving Issues or an operation receipt', async () => {
  const f = await fixture(); const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  const faultName = `review_cas_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE FUNCTION camery_agents.${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.key.tenantId}' THEN RETURN NULL; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${faultName} BEFORE UPDATE ON camery_agents.agent_reviews FOR EACH ROW EXECUTE FUNCTION camery_agents.${faultName}()`);
  try {
    await expect(reviews.apply(f.key, f.reviewId, operation(initial, { kind: 'round', submission: round(initial, [issue(f.input)]) }))).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });
    expect(await reviews.get(f.key, f.reviewId)).toEqual(initial); expect((await collaboration.listIssues(f.key)).items).toEqual([]);
    expect((await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM camery_agents.agent_review_ops WHERE tenant_id=$1 AND project_id=$2', [f.key.tenantId, f.key.projectId])).rows[0]!.count).toBe('0');
  } finally { await pool.query(`DROP TRIGGER ${faultName} ON camery_agents.agent_reviews`); await pool.query(`DROP FUNCTION camery_agents.${faultName}()`); }
});
it('rolls review CAS, new Issues, escalation Question and operation audit back together on a final write failure', async () => {
  const f = await fixture(); const initial = await reviews.create(f.key, f.reviewId, f.input, 'host-operator');
  const first = await reviews.apply(f.key, f.reviewId, operation(initial, { kind: 'round', submission: round(initial, [issue(f.input)]) }));
  const candidate = { summary: 'Still unresolved.' }; const revised = await reviews.apply(f.key, f.reviewId, operation(first, { kind: 'revision', submission: { candidate, candidateDigest: digest(candidate) } }));
  const faultName = `review_fault_${randomUUID().replaceAll('-', '')}`; const op = operation(revised, { kind: 'round', submission: round(revised, [issue(f.input, 'issue-fault')]) });
  const count = async (table: 'agent_reviews' | 'agent_review_ops' | 'agent_issues' | 'agent_questions' | 'agent_events') => (await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM camery_agents.${table} WHERE tenant_id=$1 AND project_id=$2`, [f.key.tenantId, f.key.projectId])).rows[0]!.count;
  const before = await Promise.all([count('agent_reviews'), count('agent_review_ops'), count('agent_issues'), count('agent_questions'), count('agent_events')]);
  await pool.query(`CREATE FUNCTION camery_agents.${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${f.key.tenantId}' THEN RAISE EXCEPTION 'untrusted SQL diagnostic'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${faultName} BEFORE INSERT ON camery_agents.agent_review_ops FOR EACH ROW EXECUTE FUNCTION camery_agents.${faultName}()`);
  try {
    await expect(reviews.apply(f.key, f.reviewId, op)).rejects.toMatchObject({ code: 'REVIEW_STORAGE_FAILED' });
    expect(await reviews.get(f.key, f.reviewId)).toEqual(revised);
    expect(await Promise.all([count('agent_reviews'), count('agent_review_ops'), count('agent_issues'), count('agent_questions'), count('agent_events')])).toEqual(before);
  } finally { await pool.query(`DROP TRIGGER ${faultName} ON camery_agents.agent_review_ops`); await pool.query(`DROP FUNCTION camery_agents.${faultName}()`); }
});

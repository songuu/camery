import { expect, it, vi } from 'vitest';
import type { Json, WorkflowContext } from '@camery/durable';
import { digest } from '@camery/methods';
import { AgentRegistry, ToolRegistry } from '../src/registry.js';
import { AgentRuntime } from '../src/runtime.js';
import type { DecisionDriver } from '../src/runtime.js';
import type { QuestionInbox } from '../src/question-inbox.js';

function fixture() {
  const agents = new AgentRegistry(); const tools = new ToolRegistry(); const budget = { maxSteps: 8, maxTokens: 8, maxCostMicros: 0, currency: 'CNY' };
  const agent = agents.register({ id: 'research', version: '1.0.0', instructions: 'Ask for an explicit choice.', tools: [], methods: [], modelTier: 'deterministic', writeKinds: [], budget, outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } });
  const decide = vi.fn<DecisionDriver['decide']>(async request => ({ action: request.observations.length ? { kind: 'finish', output: { text: 'candidate' } } : { kind: 'question', prompt: 'Which source?', choices: ['one', 'two'] }, usage: { tokens: 1, costMicros: 0 } }));
  const driver: DecisionDriver = { identity: 'inbox-driver', digest: digest({ version: 1 }), evidence: 'deterministic', currency: 'CNY', reservation: { tokens: 1, costMicros: 0 }, decide };
  const binding = { tenantId: 'tenant', projectId: 'project', taskId: 'physical', logicalTaskId: 'logical', objectIds: ['source'], stage: 'understanding', writers: [], taskBudget: budget, projectAllocation: budget, allocationId: 'allocation' };
  const cache = new Map<string, { options: string; value: Json }>(); const order: string[] = [];
  const context: WorkflowContext = { task: { tenantId: 'tenant', taskId: 'physical' }, signal: new AbortController().signal,
    step: vi.fn(async (key, options, effect) => { const prior = cache.get(key); if (prior) { if (prior.options !== JSON.stringify(options)) throw new Error('STEP_CHANGED'); return structuredClone(prior.value); } const value = await effect({ input: options.input, idempotencyKey: key, signal: context.signal }); cache.set(key, { options: JSON.stringify(options), value: structuredClone(value) }); return value; }),
    waitForSignal: vi.fn(async (_key, input) => { order.push('gate'); return { questionDigest: (input as Record<string, Json>)['questionDigest']!, answer: 'two' }; }), sleepUntil: vi.fn() };
  const open = vi.fn<QuestionInbox['open']>(async () => { order.push('inbox'); });
  const inbox: QuestionInbox = { identity: 'test-inbox', digest: digest({ actorId: 'host-agent', version: 1 }), open };
  return { agents, tools, agent, driver, binding, cache, context, order, inbox, open, decide, runtime: new AgentRuntime(agents, tools, driver, undefined, inbox) };
}
it('persists the exact logical Question before its durable gate and replays without saving or deciding again', async () => {
  const f = fixture(); const result = await f.runtime.run(f.agent, { text: 'untrusted source' }, f.binding, f.context);
  expect(result).toMatchObject({ state: 'candidate', steps: 3, charged: { tokens: 2, costMicros: 0 } }); expect(f.order).toEqual(['inbox', 'gate']);
  const [question, bound] = f.open.mock.calls[0]!; expect(question).toMatchObject({ taskId: 'logical', scope: { tenantId: 'tenant', projectId: 'project' }, status: 'open' }); expect(bound).toEqual({ task: f.context.task, agent: f.agent, gateKey: 'agent.1.question' });
  expect(Object.isFrozen(question)).toBe(true); expect(Object.isFrozen(bound.task)).toBe(true);
  expect(f.context.step).toHaveBeenCalledWith('agent.1.question.open', expect.objectContaining({ kind: 'replayable' }), expect.any(Function));
  expect(await f.runtime.run(f.agent, { text: 'untrusted source' }, f.binding, f.context)).toEqual(result); expect(f.open).toHaveBeenCalledOnce(); expect(f.decide).toHaveBeenCalledTimes(2);
  expect(f.decide.mock.calls[1]![0].observations).toEqual([{ questionDigest: question.questionDigest, untrustedAnswer: 'two' }]);
});
it('rejects a missing logical binding before any decision or inbox call', async () => {
  const f = fixture(); const { logicalTaskId: _logical, ...binding } = f.binding;
  await expect(f.runtime.run(f.agent, {}, binding, f.context)).rejects.toMatchObject({ code: 'QUESTION_BINDING' }); expect(f.decide).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
});
it('stops before opening a gate after an inbox failure and retries the journaled decision without redeciding', async () => {
  const f = fixture(); f.open.mockRejectedValueOnce(new Error('private-inbox-diagnostic'));
  await expect(f.runtime.run(f.agent, {}, f.binding, f.context)).rejects.toMatchObject({ code: 'QUESTION_INBOX_FAILED', message: 'QUESTION_INBOX_FAILED: agent runtime (not_applicable)' }); expect(f.context.waitForSignal).not.toHaveBeenCalled();
  expect((await f.runtime.run(f.agent, {}, f.binding, f.context)).state).toBe('candidate'); expect(f.decide).toHaveBeenCalledTimes(2); expect(f.open).toHaveBeenCalledTimes(2);
});
it('binds the inbox descriptor into the journal and snapshots its callback', async () => {
  const f = fixture(); const original = f.open; f.inbox.open = async () => { throw new Error('replaced callback'); }; await f.runtime.run(f.agent, {}, f.binding, f.context); expect(original).toHaveBeenCalledOnce();
  const changed = new AgentRuntime(f.agents, f.tools, f.driver, undefined, { ...f.inbox, digest: 'f'.repeat(64), open: original });
  await expect(changed.run(f.agent, {}, f.binding, f.context)).rejects.toThrow('STEP_CHANGED'); expect(f.decide).toHaveBeenCalledTimes(2);
});
it('rejects malformed inbox capabilities and corrupt persisted inbox receipts', async () => {
  const f = fixture(); for (const inbox of [{ ...f.inbox, identity: '' }, { ...f.inbox, digest: 'invalid' }, { ...f.inbox, open: false }]) expect(() => new AgentRuntime(f.agents, f.tools, f.driver, undefined, inbox as never)).toThrow('INVALID_QUESTION_INBOX');
  await f.runtime.run(f.agent, {}, f.binding, f.context); f.cache.get('agent.1.question.open')!.value = { questionDigest: 'f'.repeat(64), gateKey: 'wrong' };
  await expect(f.runtime.run(f.agent, {}, f.binding, f.context)).rejects.toMatchObject({ code: 'INVALID_JOURNAL_RESULT' });
});
it('does not open a gate when cancellation arrives during inbox persistence', async () => {
  const f = fixture(); const controller = new AbortController(); const context = { ...f.context, signal: controller.signal }; f.open.mockImplementationOnce(async () => { controller.abort(new Error('host-cancelled')); });
  await expect(f.runtime.run(f.agent, {}, f.binding, context)).rejects.toThrow(); expect(f.context.waitForSignal).not.toHaveBeenCalled(); expect(f.decide).toHaveBeenCalledOnce();
});

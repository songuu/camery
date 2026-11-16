import { z } from 'zod';
import type { Json, WorkflowContext } from '@camery/durable';
import { DurableError, stepIdempotencyKey } from '@camery/durable';
import { canonical, digest, freeze, jsonCopy, MethodError, ModelReceiptSchema, Pin } from '@camery/methods';
import type { MethodPin, ModelReceipt } from '@camery/methods';
import { ModelError } from '@camery/model-modes';
import type { Outcome } from '@camery/model-modes';
import { AgentError, AgentRegistry, BudgetSchema, Id, Name, ReservationSchema, ToolRegistry, UsageSchema } from './registry.js';
import type { Reservation, Usage } from './registry.js';
import { createQuestion } from './collaboration.js';
import { PricingSchema, meterModelUsage } from './metering.js';
import type { QuestionInbox } from './question-inbox.js';
import { synchronous } from './trusted-callbacks.js';

const Action = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tool'), tool: Id, input: z.json() }),
  z.strictObject({ kind: z.literal('finish'), output: z.json() }),
  z.strictObject({ kind: z.literal('question'), prompt: z.string().min(1).max(4000).refine(value => value.trim().length > 0), choices: z.array(z.string().min(1).max(1000).refine(value => value.trim().length > 0)).min(2).max(10).refine(value => new Set(value).size === value.length) }),
]);
export { Action as AgentActionSchema };
export type AgentAction = z.infer<typeof Action>;
const ModelBinding = z.strictObject({ tenantId: Name, connectionId: Name, modeDigest: Pin.shape.digest, modelIdentity: Name, modelTier: z.enum(['economy', 'balanced', 'quality']), pricing: PricingSchema.optional() });
const Driver = z.strictObject({ identity: Name, digest: Pin.shape.digest, evidence: z.enum(['deterministic', 'synthetic_replay', 'live_model']), reservation: ReservationSchema, currency: BudgetSchema.shape.currency, model: ModelBinding.optional() });
export interface DecisionRequest { trusted: { agent: MethodPin; instructions: string; tools: unknown[]; objectIds: readonly string[] }; untrustedSource: Json; observations: Json[] }
export interface DecisionContext { tenantId: string; taskId: string; idempotencyKey: string; signal: AbortSignal }
export interface DecisionDriver extends z.infer<typeof Driver> {
  requestDigest?: (input: Readonly<DecisionRequest>, context: Readonly<DecisionContext>) => string;
  decide(input: Readonly<DecisionRequest>, context: Readonly<DecisionContext>): Promise<{ action: AgentAction; usage: Usage; modelCall?: ModelReceipt }>;
}
const Binding = z.strictObject({ tenantId: Name, projectId: Name, taskId: Name, logicalTaskId: Name.optional(), objectIds: z.array(Name).max(1000), stage: Id,
  writers: z.array(z.strictObject({ objectType: Id, agentId: Id })).max(100), taskBudget: BudgetSchema, projectAllocation: BudgetSchema, allocationId: Name });
export type RunBinding = z.infer<typeof Binding>;
export interface ApprovalRequest { tenantId: string; projectId: string; taskId: string; stage: string; agent: MethodPin; tool: MethodPin; inputDigest: string; objectIds: readonly string[]; callId: string }
export interface ApprovalAuthority {
  tokenFor(request: Readonly<ApprovalRequest>, signal: AbortSignal): Promise<string | null>;
  verify(token: string, request: Readonly<ApprovalRequest>, signal: AbortSignal): Promise<boolean>;
}
const Span = z.strictObject({ id: Pin.shape.digest, kind: z.enum(['decision', 'tool', 'question']), name: Name, pin: Pin.shape.digest, inputDigest: Pin.shape.digest,
  outputDigest: Pin.shape.digest, usage: UsageSchema, charged: ReservationSchema, outcome: z.enum(['not_applicable', 'not_sent', 'rejected', 'completed', 'unknown']), modelCall: ModelReceiptSchema.optional() });
export interface AgentRunReport { state: 'candidate' | 'blocked'; agent: MethodPin; output: Json; reason: string | null; steps: number; charged: Reservation; usageUnknown: boolean; spans: z.infer<typeof Span>[] }
export const AgentRunReportSchema = z.strictObject({ state: z.enum(['candidate', 'blocked']), agent: Pin, output: z.json(), reason: z.string().regex(/^[A-Z_]{1,64}$/).nullable(), steps: z.int().min(0).max(1000), charged: ReservationSchema, usageUnknown: z.boolean(), spans: z.array(Span).max(1000) });
const Envelope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('result'), output: z.json(), usage: UsageSchema, outcome: z.enum(['not_applicable', 'completed']), modelCall: ModelReceiptSchema.optional() }),
  z.strictObject({ kind: z.literal('error'), code: z.string().regex(/^[A-Z_]{1,64}$/), usage: UsageSchema, outcome: z.enum(['not_applicable', 'not_sent', 'rejected', 'completed']) }),
]);
const encode = (value: unknown): Json => JSON.parse(canonical(value)) as Json;
const safeCode = (error: unknown): string => error instanceof AgentError || error instanceof MethodError || error instanceof ModelError ? /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'CALL_FAILED' : 'CALL_FAILED';
/** Internal trusted-host loop. The journal owns results; no external work occurs outside ctx.step. */
export class AgentRuntime {
  private readonly profile: z.infer<typeof Driver>;
  private readonly decide: DecisionDriver['decide'];
  private readonly approvals: ApprovalAuthority | undefined;
  private readonly requestDigest: DecisionDriver['requestDigest'];
  private readonly questions: Readonly<QuestionInbox> | undefined;
  constructor(private readonly agents: AgentRegistry, private readonly tools: ToolRegistry, driver: DecisionDriver, approvals?: ApprovalAuthority, questions?: QuestionInbox) {
    const { identity, digest: driverDigest, evidence, reservation, currency, model } = driver;
    const parsed = Driver.safeParse(jsonCopy({ identity, digest: driverDigest, evidence, reservation, currency, ...(model ? { model } : {}) }));
    if (!parsed.success || typeof driver.decide !== 'function' || (driver.requestDigest !== undefined && typeof driver.requestDigest !== 'function') || (model && typeof driver.requestDigest !== 'function') || (approvals && (typeof approvals.tokenFor !== 'function' || typeof approvals.verify !== 'function'))) throw new AgentError('INVALID_DRIVER');
    this.profile = freeze(parsed.data); this.decide = driver.decide.bind(driver);
    this.requestDigest = driver.requestDigest?.bind(driver);
    this.approvals = approvals ? Object.freeze({ tokenFor: approvals.tokenFor.bind(approvals), verify: approvals.verify.bind(approvals) }) : undefined;
    if (questions) {
      const descriptor = z.strictObject({ identity: Name, digest: Pin.shape.digest }).safeParse(jsonCopy({ identity: questions.identity, digest: questions.digest }));
      if (!descriptor.success || typeof questions.open !== 'function') throw new AgentError('INVALID_QUESTION_INBOX');
      this.questions = Object.freeze({ ...descriptor.data, open: questions.open.bind(questions) });
    }
  }
  async run(suppliedPin: MethodPin, original: Json, supplied: RunBinding, ctx: WorkflowContext): Promise<AgentRunReport> {
    const pin = freeze(jsonCopy(suppliedPin)); const agent = this.agents.resolve(pin); const input = jsonCopy(original); freeze(input);
    const parsed = Binding.safeParse(jsonCopy(supplied));
    if (!parsed.success) throw new AgentError('INVALID_BINDING');
    const binding = freeze(parsed.data);
    if (binding.tenantId !== ctx.task.tenantId || binding.taskId !== ctx.task.taskId) throw new AgentError('SCOPE_DENIED');
    if (this.questions && binding.logicalTaskId === undefined) throw new AgentError('QUESTION_BINDING');
    if (this.profile.model && (this.profile.model.tenantId !== binding.tenantId || this.profile.model.modelIdentity !== this.profile.identity || this.profile.model.modelTier !== agent.modelTier || this.profile.evidence === 'deterministic')) throw new AgentError('MODEL_BINDING');
    if (new Set(binding.objectIds).size !== binding.objectIds.length || new Set(binding.writers.map(value => value.objectType)).size !== binding.writers.length) throw new AgentError('INVALID_BINDING');
    const budgets = [agent.budget, binding.taskBudget, binding.projectAllocation];
    if (budgets.some(value => value.currency !== this.profile.currency)) throw new AgentError('CURRENCY_MISMATCH');
    const allowed = agent.tools.map(value => this.tools.resolve(value));
    if (allowed.some(tool => tool.definition.currency !== this.profile.currency || (tool.definition.method && !agent.methods.some(value => canonical(value) === canonical(tool.definition.method))))) throw new AgentError('TOOL_BINDING');
    const policy = encode({ agent: pin, binding, driver: this.profile, inputDigest: digest(input), ...(this.questions ? { questionInbox: { identity: this.questions.identity, digest: this.questions.digest } } : {}) });
    // This first checkpoint prevents changed host grants/budgets from silently reusing cached calls.
    await ctx.step('agent.bind', { kind: 'replayable', input: policy }, async () => null);
    const spans: z.infer<typeof Span>[] = []; const observations: Json[] = []; const charged = { tokens: 0, costMicros: 0 }; let usageUnknown = false;
    const report = (reason: string | null, output: Json = null): AgentRunReport => ({ state: reason === null ? 'candidate' : 'blocked', agent: pin, output, reason, steps: spans.length, charged: { ...charged }, usageUnknown, spans: jsonCopy(spans) });
    const affordable = (amount: Reservation): boolean => budgets.every(value => spans.length < value.maxSteps && amount.tokens <= value.maxTokens - charged.tokens && amount.costMicros <= value.maxCostMicros - charged.costMicros);
    const invoke = async (kind: 'decision' | 'tool', name: string, identity: string, callInput: Json, amount: Reservation, external: boolean, execute: (callId: string, signal: AbortSignal) => Promise<{ output: Json; usage: Usage; modelCall?: ModelReceipt }>, expected?: { callId: string; inputDigest: string }) => {
      const position = spans.length; const key = `agent.${position}.${kind}`;
      const raw = await ctx.step(key, { kind: external ? 'external' : 'replayable', input: encode({ policy, name, pin: identity, input: callInput, reservation: amount, ...(expected ? { modelRequest: expected } : {}) }) }, async effect => {
        try {
          const result = await execute(effect.idempotencyKey, effect.signal);
          return encode({ kind: 'result', ...result, outcome: external ? 'completed' : 'not_applicable' });
        } catch (error) {
          const known = error instanceof AgentError || error instanceof MethodError || error instanceof ModelError;
          const outcome: Outcome = known ? error.outcome : external ? 'unknown' : 'not_applicable';
          if (effect.signal.aborted || outcome === 'unknown' || (external && outcome === 'not_applicable')) throw new DurableError('AGENT_EXTERNAL_UNKNOWN', 'Agent call needs reconciliation');
          return encode({ kind: 'error', code: safeCode(error), outcome, usage: outcome === 'not_sent' ? { tokens: 0, costMicros: 0 } : { tokens: null, costMicros: null } });
        }
      });
      const result = Envelope.safeParse(jsonCopy(raw)); if (!result.success) throw new AgentError('INVALID_JOURNAL_RESULT');
      const value = result.data;
      if ((value.kind === 'result' && value.outcome !== (external ? 'completed' : 'not_applicable')) || (external && value.outcome === 'not_applicable')) throw new AgentError('INVALID_JOURNAL_RESULT', external ? 'unknown' : 'not_applicable');
      let minimum = { tokens: 0, costMicros: 0 };
      if (value.kind === 'result') {
        const receipt = value.modelCall; const model = kind === 'decision' ? this.profile.model : undefined;
        if ((model !== undefined) !== (receipt !== undefined) || (receipt && model && (receipt.tenantId !== model.tenantId || receipt.connectionId !== model.connectionId || receipt.modeDigest !== model.modeDigest || receipt.modelIdentity !== model.modelIdentity || receipt.evidence !== this.profile.evidence || receipt.callId !== expected?.callId || receipt.inputDigest !== expected?.inputDigest || receipt.outputDigest !== digest({ action: value.output })))) throw new AgentError('MODEL_RECEIPT_INVALID', external ? 'unknown' : 'not_applicable');
        if (receipt && model) {
          const metered = meterModelUsage(receipt.usage, model.pricing, external); minimum = metered.minimum;
          if (canonical(value.usage) !== canonical(metered.usage)) throw new AgentError('MODEL_RECEIPT_INVALID', external ? 'unknown' : 'not_applicable');
        }
      }
      const usage = value.usage;
      const actual = { tokens: usage.tokens ?? Math.max(amount.tokens, minimum.tokens), costMicros: usage.costMicros ?? Math.max(amount.costMicros, minimum.costMicros) };
      usageUnknown ||= usage.tokens === null || usage.costMicros === null;
      charged.tokens += actual.tokens; charged.costMicros += actual.costMicros;
      if (!Number.isSafeInteger(charged.tokens) || !Number.isSafeInteger(charged.costMicros)) throw new AgentError('BUDGET_OVERFLOW', external ? 'completed' : 'not_applicable');
      spans.push(Span.parse({ id: digest({ policy, position }), kind, name, pin: identity, inputDigest: digest(callInput), outputDigest: digest(value), usage, charged: actual, outcome: value.outcome, ...(value.kind === 'result' && value.modelCall ? { modelCall: value.modelCall } : {}) }));
      return { value, exceeded: actual.tokens > amount.tokens || actual.costMicros > amount.costMicros };
    };
    for (;;) {
      ctx.signal.throwIfAborted();
      if (!affordable(this.profile.reservation)) return report('BUDGET_LIMIT');
      const request: DecisionRequest = { trusted: { agent: pin, instructions: agent.instructions, tools: allowed.map(value => ({ pin: value.pin, ...this.tools.toMcp(value.pin) })), objectIds: binding.objectIds }, untrustedSource: input, observations: jsonCopy(observations) };
      if (Buffer.byteLength(canonical(request)) > 131072) return report('CONTEXT_LIMIT');
      const expectedCall = stepIdempotencyKey(ctx.task, `agent.${spans.length}.decision`);
      const requestHash = this.requestDigest ? Pin.shape.digest.parse(synchronous(this.requestDigest(freeze(jsonCopy(request)), Object.freeze({ tenantId: binding.tenantId, taskId: binding.taskId, idempotencyKey: expectedCall, signal: ctx.signal })))) : undefined;
      const decision = await invoke('decision', this.profile.identity, this.profile.digest, encode(request), this.profile.reservation, this.profile.evidence === 'live_model', async (idempotencyKey, signal) => {
        const value = await this.decide(freeze(jsonCopy(request)), Object.freeze({ tenantId: binding.tenantId, taskId: binding.taskId, idempotencyKey, signal }));
        const checked = z.strictObject({ action: Action, usage: UsageSchema, modelCall: ModelReceiptSchema.optional() }).safeParse(jsonCopy(value));
        if (!checked.success) throw new AgentError('INVALID_DECISION', this.profile.evidence === 'live_model' ? 'completed' : 'not_applicable');
        if (checked.data.modelCall && checked.data.modelCall.callId !== idempotencyKey) throw new AgentError('MODEL_RECEIPT_INVALID', this.profile.evidence === 'live_model' ? 'completed' : 'not_applicable');
        return { output: encode(checked.data.action), usage: checked.data.usage, ...(checked.data.modelCall ? { modelCall: checked.data.modelCall } : {}) };
      }, requestHash ? { callId: expectedCall, inputDigest: requestHash } : undefined);
      if (decision.exceeded) return report('QUOTE_EXCEEDED');
      if (decision.value.kind === 'error') return report(decision.value.code);
      const savedAction = Action.safeParse(decision.value.output); if (!savedAction.success) throw new AgentError('INVALID_JOURNAL_RESULT');
      const action = savedAction.data;
      if (action.kind === 'finish') return this.agents.validateOutput(pin, action.output) ? report(null, action.output) : report('OUTPUT_INVALID');
      if (action.kind === 'question') {
        if (!affordable({ tokens: 0, costMicros: 0 })) return report('BUDGET_LIMIT');
        const question = createQuestion({ questionId: `question-${spans.length}`, taskId: binding.logicalTaskId ?? binding.taskId, scope: { tenantId: binding.tenantId, projectId: binding.projectId }, prompt: action.prompt, objectIds: binding.objectIds, choices: action.choices });
        const gateKey = `agent.${spans.length}.question`;
        if (this.questions) {
          const inbox = this.questions; const expected = { questionDigest: question.questionDigest, gateKey };
          // The inbox may commit before step confirmation is lost. Its exact open operation must be idempotent.
          const saved = await ctx.step(`${gateKey}.open`, { kind: 'replayable', input: encode({ policy, question, gateKey }) }, async effect => {
            effect.signal.throwIfAborted();
            try { await inbox.open(question, freeze({ task: { tenantId: binding.tenantId, taskId: binding.taskId }, agent: pin, gateKey }), effect.signal); }
            catch { effect.signal.throwIfAborted(); throw new AgentError('QUESTION_INBOX_FAILED'); }
            effect.signal.throwIfAborted(); return expected;
          });
          if (canonical(saved) !== canonical(expected)) throw new AgentError('INVALID_JOURNAL_RESULT');
        }
        ctx.signal.throwIfAborted();
        const answer = await ctx.waitForSignal(gateKey, encode(question));
        const checked = z.strictObject({ questionDigest: Pin.shape.digest, answer: z.json() }).safeParse(jsonCopy(answer));
        if (!checked.success || checked.data.questionDigest !== question.questionDigest || typeof checked.data.answer !== 'string' || !question.choices.includes(checked.data.answer)) throw new AgentError('INVALID_QUESTION_ANSWER');
        spans.push(Span.parse({ id: digest({ policy, position: spans.length }), kind: 'question', name: question.questionId, pin: question.questionDigest, inputDigest: digest(question), outputDigest: digest(answer), usage: { tokens: 0, costMicros: 0 }, charged: { tokens: 0, costMicros: 0 }, outcome: 'not_applicable' }));
        observations.push(encode({ questionDigest: question.questionDigest, untrustedAnswer: checked.data.answer })); continue;
      }
      const tool = allowed.find(value => value.pin.id === action.tool);
      if (!tool) return report('TOOL_DENIED');
      if (!tool.validateInput(action.input)) return report('INPUT_INVALID');
      const args = jsonCopy(action.input); freeze(args);
      let resources: string[];
      try { resources = z.array(Name).max(1000).parse(jsonCopy(synchronous(tool.resources(args)))); } catch { return report('RESOURCE_INVALID'); }
      if (new Set(resources).size !== resources.length || resources.some(value => !binding.objectIds.includes(value))) return report('OBJECT_SCOPE_DENIED');
      if (tool.definition.effect !== 'read' && (!agent.writeKinds.includes(tool.definition.objectType) || binding.writers.find(value => value.objectType === tool.definition.objectType)?.agentId !== pin.id)) return report('WRITER_DENIED');
      if (!affordable(tool.definition.reservation)) return report('BUDGET_LIMIT');
      const external = tool.definition.effect === 'paid' || tool.definition.effect === 'publish';
      const outputFailure = (value: Json): string | null => {
        try { if (!tool.validateOutput(value)) return 'TOOL_OUTPUT_INVALID'; } catch { return 'TOOL_OUTPUT_INVALID'; }
        if (!tool.outputResources) return null;
        try {
          const output = jsonCopy(value); freeze(output);
          const targets = z.array(Name).max(1000).safeParse(jsonCopy(synchronous(tool.outputResources(output))));
          return !targets.success || targets.data.some(target => !resources.includes(target)) ? 'OUTPUT_SCOPE_DENIED' : null;
        } catch (error) { return error instanceof AgentError ? error.code : 'OUTPUT_SCOPE_DENIED'; }
      };
      const executed = await invoke('tool', tool.pin.id, tool.pin.digest, encode({ input: args, objectIds: resources }), tool.definition.reservation, external, async (callId, signal) => {
        if (external) {
          const approval = freeze({ tenantId: binding.tenantId, projectId: binding.projectId, taskId: binding.taskId, stage: binding.stage, agent: pin, tool: tool.pin, inputDigest: digest(action.input), objectIds: resources, callId });
          try {
            const token = await this.approvals?.tokenFor(approval, signal);
            if (typeof token !== 'string' || !token || await this.approvals?.verify(token, approval, signal) !== true) throw new Error();
          } catch { throw new AgentError('APPROVAL_DENIED', 'not_sent'); }
        }
        signal.throwIfAborted();
        const result = await tool.execute(args, Object.freeze({ tenantId: binding.tenantId, projectId: binding.projectId, taskId: binding.taskId, objectIds: freeze(resources), idempotencyKey: callId, signal }));
        const usage = UsageSchema.safeParse(jsonCopy(result.usage));
        if (!usage.success) throw new AgentError('TOOL_OUTPUT_INVALID', external ? 'completed' : 'not_applicable');
        const failure = outputFailure(result.output); if (failure) throw new AgentError(failure, external ? 'completed' : 'not_applicable');
        return { output: jsonCopy(result.output), usage: usage.data };
      });
      if (executed.exceeded) return report('QUOTE_EXCEEDED');
      if (executed.value.kind === 'error') return report(executed.value.code);
      // A reconciled result is host-supplied data too; validate it before the next decision.
      const failure = outputFailure(executed.value.output); if (failure) return report(failure);
      observations.push(encode({ tool: tool.pin, output: executed.value.output }));
    }
  }
}

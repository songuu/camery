import { z } from 'zod';
import { digest, freeze, jsonCopy, outputValidator, Pin } from '@camery/methods';
import type { MethodPin, OutputContract } from '@camery/methods';
import type { Json, Outcome } from '@camery/model-modes';

export class AgentError extends Error {
  override readonly name = 'AgentError';
  constructor(readonly code: string, readonly outcome: Outcome = 'not_applicable') { super(`${code}: agent runtime (${outcome})`); }
}
// oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
export const Name = z.string().min(1).max(200).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
export const Id = z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const UsageSchema = z.strictObject({ tokens: count.nullable(), costMicros: count.nullable() });
export type Usage = z.infer<typeof UsageSchema>;
export const ReservationSchema = z.strictObject({ tokens: count, costMicros: count });
export type Reservation = z.infer<typeof ReservationSchema>;
export const BudgetSchema = z.strictObject({ maxSteps: z.int().min(1).max(1000), maxTokens: count, maxCostMicros: count, currency: z.string().regex(/^[A-Z]{3}$/) });
export type Budget = z.infer<typeof BudgetSchema>;
const Definition = z.strictObject({ id: Id, version: Pin.shape.version, instructions: z.string().min(1).max(100000), tools: z.array(Pin).max(100), methods: z.array(Pin).max(100),
  modelTier: z.enum(['deterministic', 'economy', 'balanced', 'quality']), writeKinds: z.array(Id).max(100), budget: BudgetSchema, outputSchema: z.unknown() });
export type AgentDefinition = Omit<z.infer<typeof Definition>, 'outputSchema'> & { outputSchema: OutputContract };
interface AgentEntry { pin: MethodPin; definition: AgentDefinition; output: z.ZodType }
export class AgentRegistry {
  private readonly entries = new Map<string, AgentEntry>();
  register(input: unknown): MethodPin {
    const parsed = Definition.safeParse(jsonCopy(input));
    if (!parsed.success) throw new AgentError('INVALID_AGENT');
    const value = parsed.data;
    if ([value.tools, value.methods].some(pins => new Set(pins.map(pin => pin.id)).size !== pins.length) || new Set(value.writeKinds).size !== value.writeKinds.length) throw new AgentError('INVALID_AGENT');
    const output = outputValidator(value.outputSchema); const definition = value as AgentDefinition;
    const pin = { id: value.id, version: value.version, digest: digest(value) }; const key = `${pin.id}@${pin.version}`; const prior = this.entries.get(key);
    if (prior && prior.pin.digest !== pin.digest) throw new AgentError('VERSION_CONFLICT');
    if (!prior) this.entries.set(key, { pin: freeze(pin), definition: freeze(definition), output });
    return freeze(jsonCopy(pin));
  }
  private entry(input: MethodPin): AgentEntry {
    const parsed = Pin.safeParse(jsonCopy(input)); if (!parsed.success) throw new AgentError('INVALID_PIN');
    const entry = this.entries.get(`${parsed.data.id}@${parsed.data.version}`);
    if (!entry || entry.pin.digest !== parsed.data.digest) throw new AgentError('PIN_MISMATCH'); return entry;
  }
  resolve(pin: MethodPin): AgentDefinition { return freeze(jsonCopy(this.entry(pin).definition)); }
  validateOutput(pin: MethodPin, value: Json): boolean { return this.entry(pin).output.safeParse(jsonCopy(value)).success; }
}
const Tool = z.strictObject({ name: Id, version: Pin.shape.version, description: z.string().min(1).max(4000), inputSchema: z.unknown(), outputSchema: z.unknown(),
  effect: z.enum(['read', 'candidate', 'paid', 'publish']), objectType: Id, reservation: ReservationSchema, currency: BudgetSchema.shape.currency, method: Pin.optional() });
export type ToolDefinition = Omit<z.infer<typeof Tool>, 'inputSchema' | 'outputSchema'> & { inputSchema: OutputContract; outputSchema: OutputContract };
export interface ToolContext { tenantId: string; projectId: string; taskId: string; objectIds: readonly string[]; idempotencyKey: string; signal: AbortSignal }
export interface ToolResult { output: Json; usage: Usage }
export interface HostTool {
  definition: ToolDefinition;
  resources(input: Json): readonly string[];
  outputResources?: (output: Json) => readonly string[];
  execute(input: Json, context: Readonly<ToolContext>): Promise<ToolResult>;
}
export interface RegisteredTool extends HostTool { pin: MethodPin; validateInput(input: Json): boolean; validateOutput(output: Json): boolean }
export class ToolRegistry {
  private readonly entries = new Map<string, RegisteredTool>();
  register(host: HostTool): MethodPin {
    const parsed = Tool.safeParse(jsonCopy(host.definition));
    if (!parsed.success || typeof host.resources !== 'function' || typeof host.execute !== 'function' || (host.outputResources !== undefined && typeof host.outputResources !== 'function')) throw new AgentError('INVALID_TOOL');
    const definition = parsed.data as ToolDefinition;
    if (definition.inputSchema.type !== 'object' || definition.outputSchema.type !== 'object' || (definition.effect === 'candidate' && !host.outputResources)) throw new AgentError('INVALID_TOOL');
    const input = outputValidator(definition.inputSchema); const output = outputValidator(definition.outputSchema);
    const pin = { id: definition.name, version: definition.version, digest: digest(definition) }; const key = `${pin.id}@${pin.version}`;
    if (this.entries.has(key)) throw new AgentError('TOOL_EXISTS');
    this.entries.set(key, Object.freeze({ definition: freeze(definition), pin: freeze(pin), resources: host.resources.bind(host), execute: host.execute.bind(host),
      ...(host.outputResources ? { outputResources: host.outputResources.bind(host) } : {}),
      validateInput: (value: Json) => input.safeParse(jsonCopy(value)).success, validateOutput: (value: Json) => output.safeParse(jsonCopy(value)).success }));
    return freeze(jsonCopy(pin));
  }
  resolve(input: MethodPin): RegisteredTool {
    const parsed = Pin.safeParse(jsonCopy(input)); if (!parsed.success) throw new AgentError('INVALID_PIN');
    const entry = this.entries.get(`${parsed.data.id}@${parsed.data.version}`);
    if (!entry || entry.pin.digest !== parsed.data.digest) throw new AgentError('PIN_MISMATCH'); return entry;
  }
  toMcp(pin: MethodPin): { name: string; description: string; inputSchema: OutputContract; outputSchema: OutputContract } {
    const { name, description, inputSchema, outputSchema } = this.resolve(pin).definition; return freeze(jsonCopy({ name, description, inputSchema, outputSchema }));
  }
}

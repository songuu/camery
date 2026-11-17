import { z } from 'zod';
import type { Json } from '@camery/model-modes';
import { canonical, jsonCopy, MethodError } from './data.js';

export interface OutputContract {
  type: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null' | ['string','null'];
  properties?: Record<string, OutputContract> | undefined; required?: string[] | undefined; additionalProperties?: boolean | undefined;
  items?: OutputContract | undefined; minItems?: number | undefined; maxItems?: number | undefined; minLength?: number | undefined; maxLength?: number | undefined;
  minimum?: number | undefined; maximum?: number | undefined; enum?: Json[] | undefined; description?: string | undefined;
}
const count = z.int().min(0).max(2_097_152);
const Contract: z.ZodType<OutputContract> = z.lazy(() => z.strictObject({
  type: z.union([z.enum(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']),z.tuple([z.literal('string'),z.literal('null')])]),
  properties: z.record(z.string(), Contract).optional(), required: z.array(z.string()).max(256).optional(), additionalProperties: z.boolean().optional(),
  items: Contract.optional(), minItems: count.optional(), maxItems: count.optional(), minLength: count.optional(), maxLength: count.optional(),
  minimum: z.number().optional(), maximum: z.number().optional(), enum: z.array(z.json()).min(1).max(256).optional(), description: z.string().max(4000).optional(),
}));
/** Explicit JSON Schema subset: unsupported assertions fail registration instead of silently weakening validation. */
export function outputValidator(input: unknown): z.ZodType {
  const parsed = Contract.safeParse(jsonCopy(input));
  if (!parsed.success) throw new MethodError('INVALID_SCHEMA', 'method output schema');
  const visit = (schema: OutputContract, depth: number): void => {
    if (depth > 16) throw new MethodError('INVALID_SCHEMA', 'method output schema depth');
    // Nullable strings use standard JSON Schema types; keywords still constrain their non-null branch.
    const type=Array.isArray(schema.type)?schema.type[0]:schema.type;
    if (type === 'object') {
      if (!schema.properties || schema.additionalProperties !== false || Object.keys(schema.properties).length > 256 || !schema.required || new Set(schema.required).size !== schema.required.length || schema.required.some(key => !Object.hasOwn(schema.properties!, key))) throw new MethodError('INVALID_SCHEMA', 'method object schema');
    } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) throw new MethodError('INVALID_SCHEMA', 'method schema keyword');
    if (type === 'array' ? !schema.items : schema.items !== undefined || schema.minItems !== undefined || schema.maxItems !== undefined) throw new MethodError('INVALID_SCHEMA', 'method array schema');
    if ((schema.minLength !== undefined || schema.maxLength !== undefined) && type !== 'string') throw new MethodError('INVALID_SCHEMA', 'method string schema');
    if ((schema.minimum !== undefined || schema.maximum !== undefined) && type !== 'number' && type !== 'integer') throw new MethodError('INVALID_SCHEMA', 'method number schema');
    if ((schema.minItems ?? 0) > (schema.maxItems ?? Infinity) || (schema.minLength ?? 0) > (schema.maxLength ?? Infinity) || (schema.minimum ?? -Infinity) > (schema.maximum ?? Infinity)) throw new MethodError('INVALID_SCHEMA', 'method schema range');
    for (const child of Object.values(schema.properties ?? {})) visit(child, depth + 1);
    if (schema.items) visit(schema.items, depth + 1);
  };
  visit(parsed.data, 0);
  // The converter handles enum before type/range and compares structural enum values by identity.
  // Compile structure without enums, then intersect deep JSON enum equality at every schema node.
  const enums = new Map<OutputContract, Set<string>>();
  const base = (schema: OutputContract): OutputContract => {
    const result = { ...schema }; delete result.enum;
    if (schema.enum) enums.set(schema, new Set(schema.enum.map(canonical)));
    if (schema.properties) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, base(value)]));
    if (schema.items) result.items = base(schema.items);
    return result;
  };
  const matches = (schema: OutputContract, value: unknown): boolean => {
    const values = enums.get(schema); if (values && !values.has(canonical(value))) return false;
    if (schema.properties && value && typeof value === 'object') for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !matches(child, (value as Record<string, unknown>)[key])) return false;
    }
    return !schema.items || !Array.isArray(value) || value.every(item => matches(schema.items!, item));
  };
  try { return z.fromJSONSchema(base(parsed.data) as z.core.JSONSchema.JSONSchema).refine(value => { try { return matches(parsed.data, value); } catch { return false; } }); }
  catch { throw new MethodError('INVALID_SCHEMA', 'method output conversion'); }
}
const id = z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/);
export const Pin = z.strictObject({ id, version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export type MethodPin = z.infer<typeof Pin>;
export const Pack = z.strictObject({
  manifest: z.strictObject({
    id, version: Pin.shape.version, stage: z.enum(['input', 'understanding', 'development', 'script', 'review', 'storyboard']),
    inputKinds: z.array(id).min(1).max(32), languages: z.array(z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/)).min(1).max(32),
    modelTier: z.enum(['deterministic', 'economy', 'balanced', 'quality']), tool: id, outputSchema: Contract,
    provenance: z.strictObject({ kind: z.enum(['original', 'derived']), sources: z.array(z.strictObject({ url: z.url(), commit: z.string().min(1).max(200), license: z.string().min(1).max(200) })).max(100) }),
  }),
  instructions: z.string().min(1).max(100_000),
  rules: z.array(z.strictObject({ id, kind: z.literal('chapter-coverage') })).max(100),
  examples: z.array(z.strictObject({ id, input: z.json(), output: z.json() })).max(100),
  cards: z.array(z.strictObject({ id, title: z.string().min(1).max(200), text: z.string().min(1).max(10000) })).max(100),
  evals: z.array(z.json()).max(100),
});
export type MethodPack = z.infer<typeof Pack>;

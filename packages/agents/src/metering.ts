import { z } from 'zod';
import type { ModelReceipt } from '@camery/methods';
import { AgentError } from './registry.js';
import type { Reservation, Usage } from './registry.js';
const rate = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PricingSchema = z.strictObject({ inputMicrosPerMillionTokens: rate, outputMicrosPerMillionTokens: rate });
export type ModelPricing = z.infer<typeof PricingSchema>;
/** Missing totals stay unknown, but a known partial count is still a binding lower bound. */
export function meterModelUsage(usage: ModelReceipt['usage'], pricing: ModelPricing | undefined, live: boolean): { usage: Usage; minimum: Reservation } {
  const knownTokens = BigInt(usage.inputTokens ?? 0) + BigInt(usage.outputTokens ?? 0);
  const knownCost = !live || !pricing ? 0n : (BigInt(usage.inputTokens ?? 0) * BigInt(pricing.inputMicrosPerMillionTokens) + BigInt(usage.outputTokens ?? 0) * BigInt(pricing.outputMicrosPerMillionTokens) + 999999n) / 1000000n;
  const minimum = { tokens: Number(knownTokens), costMicros: Number(knownCost) };
  if (!Number.isSafeInteger(minimum.tokens) || !Number.isSafeInteger(minimum.costMicros)) throw new AgentError('USAGE_OVERFLOW', live ? 'completed' : 'not_applicable');
  const complete = usage.inputTokens !== null && usage.outputTokens !== null;
  return { usage: { tokens: complete ? minimum.tokens : null, costMicros: !live ? 0 : complete && pricing ? minimum.costMicros : null }, minimum };
}

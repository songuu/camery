import { z } from 'zod';
import { digest, freeze, jsonCopy } from '@camery/methods';
import { AgentError, Name } from './registry.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/); const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const TraceSpanNames = ['camery.workflow', 'camery.step', 'camery.decision', 'camery.tool', 'camery.gate', 'camery.timer', 'camery.question'] as const;
export type TraceSpanName = typeof TraceSpanNames[number];
const fields = {
  'camery.tenant_hash': hash, 'camery.project_hash': hash, 'camery.task_hash': hash, 'camery.workflow_hash': hash, 'camery.workflow_version': z.int().min(1).max(2147483647),
  'camery.step_hash': hash, 'camery.input_hash': hash, 'camery.output_hash': hash, 'camery.agent_pin_hash': hash, 'camery.tool_pin_hash': hash, 'camery.method_pin_hash': hash, 'camery.error_hash': hash,
  'camery.execution': z.enum(['executed', 'replayed', 'journal', 'interrupted']), 'camery.state': z.enum(['succeeded', 'candidate', 'blocked', 'interrupted', 'failed']), 'camery.outcome': z.enum(['not_applicable', 'not_sent', 'rejected', 'completed', 'unknown']),
  'camery.evidence': z.enum(['deterministic', 'synthetic_replay', 'live_model']), 'camery.kind': z.enum(['workflow', 'replayable', 'external', 'gate', 'timer']),
  'camery.tokens_known': z.boolean(), 'camery.cost_known': z.boolean(), 'camery.tokens': count, 'camery.cost_micros': count, 'camery.reserved_tokens': count, 'camery.reserved_cost_micros': count,
  'camery.charged_tokens': count, 'camery.charged_cost_micros': count, 'camery.usage_unknown': z.boolean(), 'camery.behavior_steps': count, 'camery.currency': z.string().regex(/^[A-Z]{3}$/),
};
export type SafeTraceAttributes = Record<string, string | number | boolean>;
export function traceScopeHashes(input: { tenantId: string; projectId: string }): { tenantHash: string; projectHash: string } {
  try {
    const tenant = Object.getOwnPropertyDescriptor(input, 'tenantId'); const project = Object.getOwnPropertyDescriptor(input, 'projectId');
    if (!tenant || !project || !('value' in tenant) || !('value' in project)) throw new Error();
    const parsed = z.object({ tenantId: Name, projectId: Name }).safeParse(jsonCopy({ tenantId: tenant.value, projectId: project.value })); if (parsed.success) return freeze({ tenantHash: digest({ tenantId: parsed.data.tenantId }), projectHash: digest(parsed.data) });
  } catch { /* Do not evaluate source accessors or reflect malformed scope data. */ }
  throw new AgentError('INVALID_TRACE_SCOPE');
}
/** Allowlisted scalar values only. Never evaluate an accessor or serialize arbitrary attributes. */
export function sanitizeTraceAttributes(input: unknown): SafeTraceAttributes {
  const output: SafeTraceAttributes = {};
  if (input === null || typeof input !== 'object') return output;
  for (const [key, schema] of Object.entries(fields)) {
    try { const descriptor = Object.getOwnPropertyDescriptor(input, key); if (!descriptor || !('value' in descriptor)) continue; const value = schema.safeParse(descriptor.value); if (value.success) output[key] = value.data; } catch { /* Drop invalid/native attributes without reflecting their diagnostics. */ }
  }
  return freeze(output);
}
export interface LocalTraceSpan {
  traceId: string; spanId: string; parentSpanId: string | null; name: TraceSpanName; startTime: [number, number]; endTime: [number, number]; statusCode: number; attributes: SafeTraceAttributes;
}
export interface LocalTraceSnapshot { version: 1; scope: { tenantHash: string; projectHash: string }; dropped: number; spans: LocalTraceSpan[] }

import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { digest } from '@camery/methods';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalWorkflowTracing } from '../src/node/local-tracing.js';
import { traceScopeHashes } from '../src/telemetry-data.js';

const scope = { tenantId: 'tenant-private-name', projectId: 'project-private-name' };
const hashes = traceScopeHashes(scope);
const scoped = { 'camery.tenant_hash': hashes.tenantHash, 'camery.project_hash': hashes.projectHash };
const instances: ReturnType<typeof createLocalWorkflowTracing>[] = [];
function fixture(maxSpans?: number) { const value = createLocalWorkflowTracing({ ...scope, ...(maxSpans === undefined ? {} : { maxSpans }) }); instances.push(value); return value; }
afterEach(async () => { vi.restoreAllMocks(); for (const value of instances.splice(0)) await value.shutdown().catch(() => {}); });

it('uses a real local SDK and preserves explicit parent/child trace correlation without registering global tracing', async () => {
  const global = trace.getTracerProvider(); const local = fixture();
  const parent = local.tracer.startSpan('camery.workflow', { attributes: scoped }, ROOT_CONTEXT);
  const child = local.tracer.startSpan('camery.tool', { attributes: { ...scoped, 'camery.step_hash': digest('step'), 'camery.execution': 'executed' } }, trace.setSpan(ROOT_CONTEXT, parent));
  child.setStatus({ code: SpanStatusCode.OK }); child.end(); parent.end(); await local.forceFlush();
  const result = local.snapshot(); expect(result.version).toBe(1); expect(result.scope).toEqual(hashes); expect(result.dropped).toBe(0); expect(result.spans).toHaveLength(2);
  const root = result.spans.find(span => span.name === 'camery.workflow')!; const step = result.spans.find(span => span.name === 'camery.tool')!;
  expect(root.parentSpanId).toBeNull(); expect(step.parentSpanId).toBe(root.spanId); expect(step.traceId).toBe(root.traceId); expect(step.statusCode).toBe(SpanStatusCode.OK);
  expect(step.traceId).toMatch(/^[a-f0-9]{32}$/); expect(step.spanId).toMatch(/^[a-f0-9]{16}$/); expect(trace.getTracerProvider()).toBe(global);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(step.attributes)).toBe(true); expect(Object.isFrozen(step.startTime)).toBe(true);
});
it('exports only allowlisted scalars and never exports arbitrary payload, resources, events or status diagnostics', async () => {
  const local = fixture(); const secret = 'secret-token-source-and-output';
  const span = local.tracer.startSpan('camery.decision', { attributes: { ...scoped, 'camery.input_hash': digest(secret), 'camery.output_hash': digest({ body: secret }), 'camery.tokens': 5,
    'camery.cost_micros': 9, 'camery.tokens_known': true, 'camery.cost_known': true, 'camery.evidence': 'synthetic_replay', 'camery.execution': 'executed', 'camery.state': secret,
    source: secret, prompt: secret, output: secret, authorization: secret, 'process.command_line': secret } }, ROOT_CONTEXT);
  span.addEvent('unsafe-event', { secret }); span.recordException(new Error(secret)); span.setStatus({ code: SpanStatusCode.ERROR, message: secret }); span.end(); await local.forceFlush();
  const serialized = JSON.stringify(local.snapshot()); expect(serialized).not.toContain(secret); expect(serialized).not.toContain(scope.tenantId); expect(serialized).not.toContain(scope.projectId);
  expect(serialized).not.toContain('resource'); expect(serialized).not.toContain('unsafe-event'); expect(serialized).not.toContain('process.command_line'); expect(serialized).not.toContain('exception');
  expect(local.snapshot().spans[0]!.attributes).toEqual({ ...scoped, 'camery.input_hash': digest(secret), 'camery.output_hash': digest({ body: secret }), 'camery.tokens': 5, 'camery.cost_micros': 9, 'camery.tokens_known': true, 'camery.cost_known': true, 'camery.evidence': 'synthetic_replay', 'camery.execution': 'executed' });
});
it('filters wrong tenant/project and unscoped or unknown span names before they consume the bounded buffer', async () => {
  const local = fixture(1); const other = traceScopeHashes({ tenantId: 'other-tenant', projectId: scope.projectId });
  for (const [name, attributes] of [['camery.step', { ...scoped, 'camery.tenant_hash': other.tenantHash }], ['camery.step', { ...scoped, 'camery.project_hash': other.projectHash }], ['camery.step', {}], ['secret-span-name', scoped]] as const) local.tracer.startSpan(name, { attributes }, ROOT_CONTEXT).end();
  local.tracer.startSpan('camery.step', { attributes: scoped }, ROOT_CONTEXT).end(); await local.forceFlush();
  expect(local.snapshot().spans).toHaveLength(1); expect(local.snapshot().dropped).toBe(0); expect(JSON.stringify(local.snapshot())).not.toContain(other.projectHash);
});
it('retains only the newest bounded spans and makes discarded history explicit', async () => {
  const local = fixture(2); for (let index = 0; index < 4; index++) local.tracer.startSpan('camery.step', { attributes: { ...scoped, 'camery.step_hash': digest(index) } }, ROOT_CONTEXT).end();
  await local.forceFlush(); const prior = local.snapshot(); expect(prior.dropped).toBe(2); expect(prior.spans.map(span => span.attributes['camery.step_hash'])).toEqual([digest(2), digest(3)]);
  local.tracer.startSpan('camery.step', { attributes: { ...scoped, 'camery.step_hash': digest(4) } }, ROOT_CONTEXT).end(); await local.forceFlush(); expect(prior.spans).toHaveLength(2); expect(prior.dropped).toBe(2); expect(local.snapshot().dropped).toBe(3);
});
it('supports the bounded default and validates configuration without capturing private diagnostics', async () => {
  const local = fixture(); for (let index = 0; index < 1001; index++) local.tracer.startSpan('camery.step', { attributes: scoped }, ROOT_CONTEXT).end(); await local.forceFlush(); expect(local.snapshot().spans).toHaveLength(1000); expect(local.snapshot().dropped).toBe(1);
  for (const options of [{ ...scope, maxSpans: 0 }, { ...scope, maxSpans: 10001 }, { ...scope, maxSpans: 1.5 }, { ...scope, tenantId: '' }, { ...scope, unexpected: true }]) expect(() => createLocalWorkflowTracing(options)).toThrow('INVALID_LOCAL_TRACING');
  const cyclic: Record<string, unknown> = {}; cyclic['private'] = cyclic; expect(() => createLocalWorkflowTracing(cyclic as never)).toThrow('INVALID_LOCAL_TRACING');
});
it('ignores global exporter environment variables and closes its local provider idempotently', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://private-token@unreachable.example'); vi.stubEnv('OTEL_TRACES_EXPORTER', 'otlp');
  try {
    const local = fixture(); local.tracer.startSpan('camery.workflow', { attributes: scoped }, ROOT_CONTEXT).end(); await local.forceFlush(); expect(local.snapshot().spans).toHaveLength(1);
    await Promise.all([local.shutdown(), local.shutdown()]); local.tracer.startSpan('camery.step', { attributes: scoped }, ROOT_CONTEXT).end(); await local.forceFlush(); expect(local.snapshot().spans).toHaveLength(1);
    expect(JSON.stringify(local.snapshot())).not.toContain('unreachable');
  } finally { vi.unstubAllEnvs(); }
});
it('normalizes SDK flush/shutdown failures without retaining native exception text', async () => {
  const local = fixture(); const flush = vi.spyOn(TracerProvider.prototype, 'forceFlush').mockRejectedValueOnce(new Error('private flush credential'));
  await expect(local.forceFlush()).rejects.toMatchObject({ code: 'TELEMETRY_FLUSH_FAILED', message: 'TELEMETRY_FLUSH_FAILED: agent runtime (not_applicable)' }); flush.mockRestore();
  const shutdown = vi.spyOn(TracerProvider.prototype, 'shutdown').mockRejectedValueOnce(new Error('private shutdown credential'));
  await expect(local.shutdown()).rejects.toMatchObject({ code: 'TELEMETRY_SHUTDOWN_FAILED', message: 'TELEMETRY_SHUTDOWN_FAILED: agent runtime (not_applicable)' });
  await expect(local.shutdown()).rejects.toMatchObject({ code: 'TELEMETRY_SHUTDOWN_FAILED' }); expect(shutdown).toHaveBeenCalledOnce(); shutdown.mockRestore();
});

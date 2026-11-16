import { isSpanContextValid, SpanStatusCode } from '@opentelemetry/api';
import type { Tracer } from '@opentelemetry/api';
import { SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { freeze, jsonCopy } from '@camery/methods';
import { z } from 'zod';
import { AgentError, Name } from '../registry.js';
import { sanitizeTraceAttributes, traceScopeHashes, TraceSpanNames } from '../telemetry-data.js';
import type { LocalTraceSnapshot, LocalTraceSpan, TraceSpanName } from '../telemetry-data.js';

const Configuration = z.strictObject({ tenantId: Name, projectId: Name, maxSpans: z.int().min(1).max(10000).default(1000) });
const time = z.tuple([z.int().min(0).max(Number.MAX_SAFE_INTEGER), z.int().min(0).max(999999999)]);
export interface LocalWorkflowTracing {
  tracer: Tracer;
  snapshot(): LocalTraceSnapshot;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
/** Explicit local-only SDK. No global registration, environment exporter selection, resource detector or transport is installed. */
export function createLocalWorkflowTracing(input: { tenantId: string; projectId: string; maxSpans?: number }): LocalWorkflowTracing {
  let config: z.infer<typeof Configuration>;
  try { config = Configuration.parse(jsonCopy(input)); } catch { throw new AgentError('INVALID_LOCAL_TRACING'); }
  const scope = traceScopeHashes(config); const rows: LocalTraceSpan[] = []; let head = 0; let dropped = 0; let closed = false;
  function retain(span: ReadableSpan): void {
    if (closed || !(TraceSpanNames as readonly string[]).includes(span.name)) return;
    const attributes = sanitizeTraceAttributes(span.attributes);
    if (attributes['camery.tenant_hash'] !== scope.tenantHash || attributes['camery.project_hash'] !== scope.projectHash) return;
    const context = span.spanContext(); const start = time.safeParse(span.startTime); const end = time.safeParse(span.endTime);
    if (!isSpanContextValid(context) || !start.success || !end.success) return;
    const parent = span.parentSpanContext;
    // Sanitize before retaining: the buffer must never own raw resource, event, exception or output data.
    const value: LocalTraceSpan = freeze({ traceId: context.traceId, spanId: context.spanId, parentSpanId: parent && isSpanContextValid(parent) ? parent.spanId : null,
      name: span.name as TraceSpanName, startTime: start.data, endTime: end.data,
      statusCode: [SpanStatusCode.UNSET, SpanStatusCode.OK, SpanStatusCode.ERROR].includes(span.status.code) ? span.status.code : SpanStatusCode.UNSET, attributes });
    if (rows.length < config.maxSpans) rows.push(value);
    else { rows[head] = value; head = (head + 1) % config.maxSpans; dropped++; }
  }
  const exporter: SpanExporter = {
    export(spans, callback) { for (const span of spans) { try { retain(span); } catch { /* A malformed SDK item is discarded without sending its diagnostic to global handlers. */ } } callback({ code: 0 }); },
    async forceFlush() {},
    async shutdown() { closed = true; },
  };
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })], spanLimits: { attributeCountLimit: 64, attributeValueLengthLimit: 256, eventCountLimit: 0, linkCountLimit: 0 } });
  const tracer = provider.getTracer('camery.agents', '0.1.0'); let shutdown: Promise<void> | undefined;
  return Object.freeze({ tracer,
    snapshot(): LocalTraceSnapshot { const spans = Array.from({ length: rows.length }, (_unused, index) => rows[(head + index) % rows.length]!); return freeze(jsonCopy({ version: 1 as const, scope, dropped, spans })); },
    async forceFlush(): Promise<void> { try { await provider.forceFlush(); } catch { throw new AgentError('TELEMETRY_FLUSH_FAILED'); } },
    shutdown(): Promise<void> { closed = true; shutdown ??= (async () => { try { await provider.shutdown(); } catch { throw new AgentError('TELEMETRY_SHUTDOWN_FAILED'); } })(); return shutdown; },
  });
}

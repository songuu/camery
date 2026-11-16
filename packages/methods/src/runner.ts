import { ModelError } from '@camery/model-modes';
import type { CallContext, Json, Outcome } from '@camery/model-modes';
import { captureContext, digest, freeze, jsonCopy, MethodError } from './data.js';
import { validateMethodRules } from './rules.js';
import { ModelReceiptSchema } from './model-call.js';
import type { ModelReceipt } from './model-call.js';
import type { MethodRegistry } from './registry.js';
import type { MethodPack, MethodPin } from './schema.js';
export interface MethodExecutor {
  id: string; effect: 'read' | 'paid'; network: boolean; evidence: 'deterministic' | 'synthetic_replay' | 'live_model';
  execute(input: Json, context: Readonly<CallContext>, pack: MethodPack): Promise<Json>;
  modelReceiptFor?: (context: Readonly<CallContext>) => ModelReceipt | undefined;
}
export interface MethodExecution {
  status: 'candidate'; method: MethodPin; output: Json;
  trace: { tool: string; effect: MethodExecutor['effect']; network: boolean; evidence: MethodExecutor['evidence']; status: 'completed'; modelCall?: ModelReceipt }[];
}
export class MethodRunner {
  private readonly tools = new Map<string, MethodExecutor>();
  private readonly timeoutMs: number;
  constructor(private readonly registry: MethodRegistry, tools: readonly MethodExecutor[], options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 300_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) throw new MethodError('INVALID_CONFIG', 'method timeout');
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9.-]{0,79}$/.test(tool.id) || this.tools.has(tool.id) || !['read', 'paid'].includes(tool.effect) || typeof tool.network !== 'boolean' || !['deterministic', 'synthetic_replay', 'live_model'].includes(tool.evidence) || typeof tool.execute !== 'function' || (tool.modelReceiptFor !== undefined && typeof tool.modelReceiptFor !== 'function')) throw new MethodError('INVALID_CONFIG', 'method tool');
      this.tools.set(tool.id, Object.freeze({ ...tool }));
    }
  }
  async run(pin: MethodPin, original: Json, supplied: CallContext): Promise<MethodExecution> {
    const bound = freeze(jsonCopy(pin)); const pack = this.registry.resolve(bound); const input = jsonCopy(original); freeze(input);
    const captured = captureContext(supplied, 'method execution');
    const tool = this.tools.get(pack.manifest.tool); if (!tool) throw new MethodError('TOOL_MISSING', 'method execution');
    const controller = new AbortController(); let timedOut = false; let started = false; let returned = false;
    const outcome = (): Outcome => tool.effect === 'read' ? 'not_applicable' : returned ? 'completed' : started ? 'unknown' : 'not_sent';
    const abort = (): void => { controller.abort(); }; captured.signal.addEventListener('abort', abort, { once: true }); if (captured.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.timeoutMs);
    const error = (): MethodError => new MethodError(timedOut ? 'TIMEOUT' : 'ABORTED', 'method execution', outcome());
    let onAbort: () => void = () => {};
    try {
      if (controller.signal.aborted) throw error();
      const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(error()); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      const pending = Promise.resolve().then(() => { if (controller.signal.aborted) throw error(); started = true; return tool.execute(input, Object.freeze({ ...captured, signal: controller.signal }), pack); });
      const raw = await Promise.race([pending, cancelled]); returned = true; const output = jsonCopy(raw);
      if (controller.signal.aborted) throw error();
      if (!this.registry.validateOutput(bound, output)) throw new MethodError('OUTPUT_INVALID', 'method execution');
      if (!validateMethodRules(pack, input, output)) throw new MethodError('RULE_FAILED', 'method output rules');
      const rawReceipt = tool.modelReceiptFor?.(captured);
      if (rawReceipt instanceof Promise) { void rawReceipt.catch(() => {}); throw new MethodError('MODEL_RECEIPT_INVALID', 'method model evidence'); }
      let modelCall: ModelReceipt | undefined;
      if (rawReceipt !== undefined) {
        const parsed = ModelReceiptSchema.safeParse(jsonCopy(rawReceipt));
        if (!parsed.success) throw new MethodError('MODEL_RECEIPT_INVALID', 'method model evidence');
        modelCall = parsed.data; const live = modelCall.evidence === 'live_model';
        if (modelCall.tenantId !== captured.tenantId || modelCall.connectionId !== captured.connectionId || modelCall.modeDigest !== captured.modeDigest || modelCall.callId !== captured.idempotencyKey || modelCall.outputDigest !== digest(output) || modelCall.evidence !== tool.evidence || tool.network !== live || tool.effect !== (live ? 'paid' : 'read')) throw new MethodError('MODEL_RECEIPT_INVALID', 'method model evidence');
      } else if (tool.evidence !== 'deterministic') throw new MethodError('MODEL_RECEIPT_REQUIRED', 'method model evidence');
      return { status: 'candidate', method: bound, output, trace: [{ tool: tool.id, effect: tool.effect, network: tool.network, evidence: tool.evidence, status: 'completed', ...(modelCall ? { modelCall } : {}) }] };
    } catch (caught) {
      if (controller.signal.aborted) throw error();
      if (caught instanceof MethodError) throw new MethodError(caught.code, caught.operation, caught.outcome === 'not_applicable' ? outcome() : caught.outcome);
      throw new MethodError('EXECUTION_FAILED', 'method execution', caught instanceof ModelError ? caught.outcome : outcome());
    } finally { clearTimeout(timer); captured.signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); }
  }
}

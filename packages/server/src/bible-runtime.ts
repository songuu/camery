import { BibleError, createStoryBibleMethodPack } from '@camery/bible';
import { executionForChunks, type BibleExecution, type BibleWorkflowOptions } from '@camery/bible/node';
import { MethodRegistry, ModelSession, canonical } from '@camery/methods';
import { NodeHttpTransport, OpenAiCompatibleLlm } from '@camery/model-modes';
import type { BiblePreset } from './bible-options.js';
import type { BibleDeploymentConfig } from './bible-config.js';

export interface BibleModelRuntime {
  readonly presetFor: (projectId: string) => BiblePreset | null;
  readonly sessionFor: BibleWorkflowOptions['sessionFor'];
}
/** Trusted host configuration binds every receipt. Construction performs no network request. */
export function createBibleModelRuntime(config: BibleDeploymentConfig): BibleModelRuntime {
  const { tenantId, projectId, text } = config;
  if (!text) return Object.freeze({ presetFor: () => null, sessionFor: async () => { throw new BibleError('MODEL_FAILED', 'text model unavailable'); } });
  const execution: BibleExecution = executionForChunks({ connectionId: text.connectionId, modelIdentity: text.modelIdentity, modeDigest: text.modeDigest,
    evidence: 'live_model', modelTier: 'economy', currency: text.currency, reservation: text.reservation,
    ...(text.pricing ? { pricing: text.pricing } : {}), limits: text.limits }, 1);
  const method = new MethodRegistry().register(createStoryBibleMethodPack());
  const preset = Object.freeze({ method, execution, label: text.label });
  const transport = new NodeHttpTransport({ tenantId, connectionId: text.connectionId, baseUrl: text.baseUrl,
    timeoutMs: text.timeoutMs, maxInFlight: 1, allowPrivateNetworks: text.allowPrivateNetworks, allowInsecureHttp: text.allowInsecureHttp,
    // This private transport is reached only through the scoped ModelSession; its resolver is never request supplied.
    auth: { scheme: 'Bearer', credentialRef: 'bible-text', resolveSecret: async () => text.token } });
  const client = new OpenAiCompatibleLlm(transport, { model: text.modelIdentity, structuredOutput: text.structuredOutput });
  return Object.freeze({ presetFor: (requested: string) => requested === projectId ? preset : null,
    sessionFor: async (binding: Parameters<BibleWorkflowOptions['sessionFor']>[0], task: Parameters<BibleWorkflowOptions['sessionFor']>[1]) => {
      // Compare the entire trusted execution profile, including prices/reservations, before constructing a session.
      if (binding.tenantId !== tenantId || task.tenantId !== tenantId || canonical(binding.execution) !== canonical(execution)) throw new BibleError('CONFLICT', 'text execution binding');
      return new ModelSession(client, { tenantId, connectionId: text.connectionId, modeDigest: text.modeDigest, modelIdentity: text.modelIdentity,
        evidence: 'live_model', maxCalls: 1, timeoutMs: text.timeoutMs });
    } });
}

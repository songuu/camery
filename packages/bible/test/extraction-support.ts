import { importNovel } from '@camery/ingest';
import { createStructuredGenerationExecutor, digest, MethodRegistry, MethodRunner, ModelSession } from '@camery/methods';
import { OpenAiCompatibleLlm } from '@camery/model-modes';
import type { CallContext, HttpTransport } from '@camery/model-modes';
import type { ChunkOutput, SourceInput } from '../src/contracts.js';
import { createStoryBibleMethodPack } from '../src/extraction.js';

export function sourceInput(text = '第一章 车站\n小林在车站等阿青。\n'): SourceInput {
  return { tenantId: 'tenant-one', projectId: 'project-one', documentId: 'novel-one', kind: 'novel', revision: 1, document: importNovel(text) };
}
export function fixtureOutput(text: string): ChunkOutput {
  const quote = text.includes('小林') ? '小林' : text.slice(0, 1); const start = text.indexOf(quote);
  return { entities: [{ id: 'lin', kind: 'character', name: '小林', aliases: [], description: '本块中出现的人物。', evidence: [{ start, end: start + quote.length, quote }] }], relations: [], claims: [] };
}
export function fixtureRunner(transport: HttpTransport, evidence: 'synthetic_replay'|'live_model' = 'synthetic_replay', maxCalls = 20) {
  const registry = new MethodRegistry(); const method = registry.register(createStoryBibleMethodPack());
  const session = new ModelSession(new OpenAiCompatibleLlm(transport, { model: 'fixture-story-model', structuredOutput: 'json_schema' }), {
    tenantId: 'tenant-one', connectionId: 'fixture-connection', modeDigest: digest('fixture-story-mode'), modelIdentity: 'fixture-provider/story-model',
    evidence, maxCalls, timeoutMs: 1000,
  });
  return { registry, method, session, runner: new MethodRunner(registry, [createStructuredGenerationExecutor(session)]) };
}
export function fixtureContext(key = 'chunk-call-1'): CallContext {
  return { tenantId: 'tenant-one', connectionId: 'fixture-connection', modeDigest: digest('fixture-story-mode'), idempotencyKey: key, signal: new AbortController().signal };
}

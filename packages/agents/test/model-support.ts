import { fileURLToPath } from 'node:url';
import { canonical, MethodRegistry, ModelSession } from '@camery/methods';
import { loadMethodPack } from '@camery/methods/node';
import { stepIdempotencyKey } from '@camery/durable';
import type { Json, TaskKey, WorkflowContext } from '@camery/durable';
import { ModelModeRegistry, OpenAiCompatibleLlm } from '@camery/model-modes';
import type { HttpTransport, HttpReply } from '@camery/model-modes';
import { AgentRegistry, AgentRuntime, createModelDecisionDriver, registerChapterResearchTool, ToolRegistry } from '../src/index.js';
import { loadAgentDefinition } from '../src/node/index.js';
import original from '../../methods/test/fixtures/original-three-episodes.json';
export const source = { sourceId: 'original-story', text: original.text };
export async function researchRuntime(transport: HttpTransport, task: TaskKey) {
  const methods = new MethodRegistry(); const method = methods.register(await loadMethodPack(fileURLToPath(new URL('../../../method-packs/chapter-segmentation/', import.meta.url))));
  const tools = new ToolRegistry(); const tool = registerChapterResearchTool(methods, method, tools); const agents = new AgentRegistry();
  const definition = await loadAgentDefinition(fileURLToPath(new URL('../../../agents/research/', import.meta.url))); const pin = agents.register(definition);
  if (canonical(definition.tools) !== canonical([tool]) || canonical(definition.methods) !== canonical([method])) throw new Error('Disk role must match exact registered method/tool pins');
  const modes = new ModelModeRegistry(); const evidence = { value: null, source: 'fixture://agent-structured-research', modeVersion: '1.0.0', verification: 'unverified', evaluationIds: [] };
  modes.register({ id: 'synthetic-research', version: '1.0.0', kind: 'llm', connector: { kind: 'openai', profile: 'synthetic-research' }, capabilities: Object.fromEntries(['durationSeconds', 'maxReferenceImages', 'firstFrame', 'lastFrame', 'nativeAudio', 'lipsync', 'aspectRatios', 'resolutions', 'inputSlots', 'promptLimits', 'maxConcurrency'].map(key => [key, evidence])), compiler: { text: { sections: ['content'], separator: '\n', prefix: '' } }, cost: evidence, quality: { passed: null, total: null, evaluationIds: [], commonFailures: [] } });
  const mode = modes.pin('synthetic-research', '1.0.0');
  const session = new ModelSession(new OpenAiCompatibleLlm(transport, { model: 'synthetic-research', structuredOutput: 'json_schema' }), { tenantId: task.tenantId, connectionId: 'synthetic-research-connection', modeDigest: mode.digest, modelIdentity: 'fixture/synthetic-research', evidence: 'synthetic_replay', maxCalls: 2, timeoutMs: 1000 });
  const driver = createModelDecisionDriver(agents, tools, pin, session, { modelTier: 'balanced', currency: 'CNY', reservation: { tokens: 64, costMicros: 0 } });
  // A caller may pass a full enqueue record; execution scope contains only its trusted identity.
  const binding = { tenantId: task.tenantId, taskId: task.taskId, projectId: 'synthetic-project', objectIds: [source.sourceId], stage: 'understanding', writers: [], taskBudget: definition.budget, projectAllocation: definition.budget, allocationId: `share-${task.taskId}` };
  return { runtime: new AgentRuntime(agents, tools, driver), pin, session, binding };
}
export function protocolProvider() {
  let calls = 0;
  const transport: HttpTransport = { async exchange(request): Promise<HttpReply> {
    calls++;
    if (request.method !== 'POST' || request.path !== '/chat/completions') throw new Error('Unexpected synthetic protocol call');
    const body = request.body as unknown as { messages: { content: string }[] }; const envelope = JSON.parse(body.messages.at(-1)!.content) as { untrustedSource: Json; untrustedObservations: { output: Json }[] };
    const observation = envelope.untrustedObservations.at(-1);
    const action = observation ? { kind: 'finish', output: observation.output } : { kind: 'tool', tool: 'research.chapter', input: envelope.untrustedSource };
    return { status: 200, contentType: 'application/json', body: { kind: 'json', value: { id: observation ? 'synthetic-finish' : 'synthetic-plan', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ action }) } }], ...(observation ? {} : { usage: { prompt_tokens: 12, completion_tokens: 3 } }) } } };
  } };
  return { transport, calls: () => calls };
}
export function journal(task: TaskKey) {
  const cache = new Map<string, { input: string; output: Json }>();
  const context: WorkflowContext = { task, signal: new AbortController().signal, async step(key, options, effect) {
    const prior = cache.get(key); const input = canonical(options); if (prior) { if (input !== prior.input) throw new Error('STEP_CHANGED'); return structuredClone(prior.output); }
    const output = await effect({ input: options.input, idempotencyKey: stepIdempotencyKey(task, key), signal: new AbortController().signal }); cache.set(key, { input, output: structuredClone(output) }); return output;
  }, waitForSignal: async () => { throw new Error('No question is expected in this fixture'); }, sleepUntil: async () => { throw new Error('No timer is expected in this fixture'); } };
  return { context, cache };
}

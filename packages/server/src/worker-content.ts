import { join } from 'node:path';
import { AgentRegistry } from '@camery/agents';
import { loadAgentDefinition } from '@camery/agents/node';
import { MethodRegistry } from '@camery/methods';
import { loadMethodPack } from '@camery/methods/node';
import { ChapterWorkerError } from './chapter-worker.js';

/** Content is data only; binding the method into the producer pin locks queued tasks to its version. */
export async function loadChapterWorkerContent(directory: string) {
  try {
    const [definition, pack] = await Promise.all([
      loadAgentDefinition(join(directory, 'agents/producer')),
      loadMethodPack(join(directory, 'method-packs/chapter-segmentation')),
    ]);
    const methods = new MethodRegistry(); const method = methods.register(pack);
    const agents = new AgentRegistry(); const producer = agents.register({ ...definition, methods: [method] });
    return Object.freeze({ agents, producer, methods, method });
  } catch { throw new ChapterWorkerError('WORKER_CONTENT'); }
}

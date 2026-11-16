import {
  AgentDispatchHost, persistenceData, TreeKeySchema, validateTaskTreeDefinition,
  type AgentHostStore, type AgentHostWorker, type TaskTreeKey,
} from '@camery/agents';
import type { DurableStore } from '@camery/durable';
import { canonical, freeze, jsonCopy, Pin, type MethodPin } from '@camery/methods';
import { z } from 'zod';
import { ChapterWorkerError, chapterWorkerRoute } from './chapter-worker.js';

export interface ChapterWorkerHostOptions {
  scope: TaskTreeKey; workerId: string; producer: MethodPin; collaboration: AgentHostStore;
  durable: Pick<DurableStore, 'enqueue' | 'get' | 'steps' | 'signal'>; worker: AgentHostWorker;
}
/** Validate the fixed built-in route before every host tree read, including queue/relay rounds. */
export function createChapterWorkerHost(options: ChapterWorkerHostOptions): AgentDispatchHost {
  const scope = persistenceData(TreeKeySchema, options.scope); const producer = persistenceData(Pin, options.producer);
  const store = options.collaboration;
  const tree = store.tree.bind(store);
  const bound: AgentHostStore = {
    tree: async key => {
      const snapshot = freeze(jsonCopy(await tree(key))); const definition = validateTaskTreeDefinition(snapshot.definition);
      if (canonical({ tenantId: definition.tenantId, projectId: definition.projectId, treeId: definition.treeId }) !== canonical(scope) || canonical(definition.routes) !== canonical([{ agent: producer, ...chapterWorkerRoute }])) throw new ChapterWorkerError('WORKER_ROUTE');
      for (const task of definition.tasks) {
        const input = persistenceData(z.strictObject({ sourceId: z.string(), text: z.string().min(1).max(1000000) }), task.input);
        if (task.scope.objectIds.length !== 1 || task.scope.objectIds[0] !== input.sourceId) throw new ChapterWorkerError('WORKER_SCOPE');
      }
      return snapshot;
    },
    syncTask: store.syncTask.bind(store), queueReady: store.queueReady.bind(store), pending: store.pending.bind(store), acknowledge: store.acknowledge.bind(store),
  };
  return new AgentDispatchHost({ tree: scope, workerId: options.workerId, collaboration: bound, durable: options.durable, worker: options.worker });
}

import { z } from 'zod';
import { accessId } from '@camery/access';
import { readRuntimeConfig, snapshotEnvironment } from './secret-config.js';

const Scope = z.strictObject({
  projectId: accessId, treeId: accessId, workerId: accessId,
  // oxlint-disable-next-line eslint/no-control-regex -- Reject control characters at this input boundary.
  contentDirectory: z.string().min(1).max(4096).regex(/^[^\u0000-\u001f\u007f]+$(?![\s\S])/).optional(),
});
export async function readWorkerConfig(env: Record<string, string | undefined>) {
  try {
    const snapshot = snapshotEnvironment(env, ['CAMERY_TENANT_ID', 'CAMERY_DATABASE_URL', 'CAMERY_DATABASE_URL_FILE', 'CAMERY_WORKER_PROJECT_ID', 'CAMERY_WORKER_TREE_ID', 'CAMERY_WORKER_ID', 'CAMERY_WORKER_CONTENT_DIRECTORY']);
    const scoped = Scope.safeParse({ projectId: snapshot['CAMERY_WORKER_PROJECT_ID'], treeId: snapshot['CAMERY_WORKER_TREE_ID'], workerId: snapshot['CAMERY_WORKER_ID'], ...(snapshot['CAMERY_WORKER_CONTENT_DIRECTORY'] !== undefined ? { contentDirectory: snapshot['CAMERY_WORKER_CONTENT_DIRECTORY'] } : {}) });
    if (!scoped.success) throw new Error('Invalid worker scope');
    const database = await readRuntimeConfig(snapshot);
    return Object.freeze({ tenantId: database.tenantId, databaseUrl: database.databaseUrl, ...scoped.data });
  } catch { throw new Error('Invalid worker configuration'); }
}

import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import { AgentRegistry } from '../src/registry.js';
import { PostgresCollaborationStore } from '../src/node/collaboration-store.js';
import { migrateAgents } from '../src/node/migrate.js';
it('does not reflect private database connection or assignment diagnostics', async () => {
  const fail = async () => { throw new Error('synthetic-private-db-password'); };
  const pool = { query: fail, connect: fail } as unknown as Pool; const store = new PostgresCollaborationStore(pool, new AgentRegistry());
  await expect(store.assignment({ tenantId: 'tenant-a', taskId: 'task-a' })).rejects.toThrow('AGENT_STORAGE_FAILED');
  await expect(migrateAgents(pool)).rejects.toThrow('AGENT_STORAGE_FAILED');
});

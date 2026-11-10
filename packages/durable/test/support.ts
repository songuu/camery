import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { EnqueueTask } from '../src/types.js';

export function testPool(): Pool {
  const url = process.env['CAMERY_TEST_DATABASE_URL'];
  if (!url) throw new Error('CAMERY_TEST_DATABASE_URL is required; integration tests never silently skip PostgreSQL');
  return new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5000 });
}
export function makeTask(overrides: Partial<EnqueueTask> = {}): EnqueueTask {
  return { tenantId: randomUUID(), taskId: randomUUID(), workflow: 'test', version: 1, input: null,
    availableAt: new Date('2026-01-01T00:00:00.000Z'), maxAttempts: 3, ...overrides };
}

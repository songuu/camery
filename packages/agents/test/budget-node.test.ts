import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { digest } from '@camery/methods';
import { migrateAgentBudgets, PostgresBudgetLedger } from '../src/node/budgets.js';
const definition = { tenantId: 'tenant-a', projectId: 'project-a', currency: 'CNY', limits: { steps: 10, tokens: 100, costMicros: 100 } };
function connection() {
  const row = { tenant_id: 'tenant-a', project_id: 'project-a', currency: 'CNY', limit_steps: '10', limit_tokens: '100', limit_cost: '100', definition_digest: digest(definition) };
  const totals = { steps: '0', tokens: '0', costMicros: '0' };
  const query = vi.fn(async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => ({ rows: sql.includes('SELECT * FROM camery_agents.budget_projects') ? [row] : sql.includes('COALESCE(SUM') ? [totals] : [], rowCount: 1 }));
  const release = vi.fn(); const connect = vi.fn(async () => ({ query, release })); const pool = { connect } as unknown as Pool;
  return { pool, query, release, connect, row, totals, ledger: new PostgresBudgetLedger(pool) };
}
it('rejects unknown migration history and modified checksums, rolling back without applying DDL', async () => {
  for (const row of [{ version: 4, checksum: 'unknown' }, { version: 1, checksum: 'modified' }]) {
    const f = connection(); f.query.mockImplementation(async sql => ({ rows: sql.includes('FROM camery_agents.migrations') ? [row] : [], rowCount: 1 }));
    await expect(migrateAgentBudgets(f.pool)).rejects.toMatchObject({ code: 'MIGRATION_CONFLICT' }); expect(f.query).toHaveBeenCalledWith('ROLLBACK'); expect(f.release).toHaveBeenCalledOnce();
    expect(f.query.mock.calls.some(([sql]) => sql.includes('CREATE TABLE camery_agents.budget_projects'))).toBe(false);
  }
});
it('applies a new migration once and accepts its exact checksum on repeat', async () => {
  const f = connection(); await migrateAgentBudgets(f.pool); expect(f.query).toHaveBeenCalledWith('COMMIT');
  const history = await Promise.all(['0001-budgets.sql', '0002-collaboration.sql', '0003-outbox-fairness.sql'].map(async (file, index) => ({ version: index + 1, checksum: createHash('sha256').update(await readFile(new URL(`../src/node/migrations/${file}`, import.meta.url), 'utf8')).digest('hex') }))); f.query.mockClear();
  f.query.mockImplementation(async sql => ({ rows: sql.includes('FROM camery_agents.migrations') ? history : [], rowCount: 1 }));
  await migrateAgentBudgets(f.pool); expect(f.query.mock.calls.some(([sql]) => sql.includes('CREATE TABLE camery_agents.budget_projects'))).toBe(false); expect(f.release).toHaveBeenCalledTimes(2);
});
it('rejects connection and rollback failures without reflecting low-level credential-bearing errors', async () => {
  const f = connection(); f.connect.mockRejectedValueOnce(new Error('secret-db-password')); await expect(f.ledger.project({ tenantId: 'tenant-a', projectId: 'project-a' })).rejects.toThrow('BUDGET_STORAGE_FAILED');
  f.query.mockRejectedValue(new Error('secret-db-password')); await expect(f.ledger.project({ tenantId: 'tenant-a', projectId: 'project-a' })).rejects.toThrow('BUDGET_STORAGE_FAILED'); expect(f.release).toHaveBeenCalledOnce();
});
it('refuses corrupt project identity or aggregate amounts instead of releasing any grants', async () => {
  for (const corrupt of ['digest', 'negative', 'fraction'] as const) {
    const f = connection(); if (corrupt === 'digest') f.row.definition_digest = 'b'.repeat(64); else f.totals.tokens = corrupt === 'negative' ? '-1' : '0.5';
    await expect(f.ledger.project({ tenantId: 'tenant-a', projectId: 'project-a' })).rejects.toMatchObject({ code: 'BUDGET_DATA_CORRUPT' }); expect(f.query).toHaveBeenCalledWith('ROLLBACK'); expect(f.release).toHaveBeenCalledOnce();
  }
});

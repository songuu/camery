import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { verifyIngestRuntimeRole } from '../src/node/runtime-role.js';
import { ImportError } from '../src/types.js';

describe('ingest runtime role startup boundary', () => {
  it('accepts only a literal allowed=true response', async () => {
    const query = vi.fn(async () => ({ rows: [{ allowed: true }] }));
    await expect(verifyIngestRuntimeRole({ query } as unknown as Pool)).resolves.toBeUndefined(); expect(query).toHaveBeenCalledOnce();
  });
  it.each([{ rows: [] }, { rows: [{ allowed: false }] }, { rows: [{ allowed: null }] }, { rows: [{ allowed: 'true' }] }, { rows: [{}] }])('fails safely when privilege evidence is missing or denied', async ({ rows }) => {
    const pool = { query: vi.fn(async () => ({ rows })) } as unknown as Pool;
    await expect(verifyIngestRuntimeRole(pool)).rejects.toMatchObject({ code: 'STORAGE_FAILED', operation: 'restricted import role' });
  });
  it('does not expose driver failures or credentials', async () => {
    const pool = { query: vi.fn(async () => { throw new Error('postgresql://private:secret@host/database'); }) } as unknown as Pool;
    await expect(verifyIngestRuntimeRole(pool)).rejects.toThrow('Import restricted import role failed (STORAGE_FAILED)');
  });
  it('preserves an already-safe import error without returning success', async () => {
    const safe = new ImportError('STORAGE_FAILED', 'restricted import role');
    const pool = { query: vi.fn(async () => { throw safe; }) } as unknown as Pool;
    await expect(verifyIngestRuntimeRole(pool)).rejects.toBe(safe);
  });
});

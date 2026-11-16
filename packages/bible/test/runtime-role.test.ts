import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { verifyBibleRuntimeRole } from '../src/node/runtime-role.js';
it('accepts only the explicit database permission gate and scopes its static query to append-only knowledge data',async()=>{
  const query=vi.fn(async()=>({rows:[{allowed:true}]}));await verifyBibleRuntimeRole({query} as unknown as Pool);
  const sql=query.mock.calls[0] as unknown[];expect(sql[0]).toContain('camery_bible');expect(sql[0]).toContain('camery_ingest');expect(sql[0]).toContain('rolcanlogin');
  expect(sql[0]).toContain('session_user=current_user');expect(sql[0]).toContain('has_column_privilege');expect(sql[0]).toContain("'MEMBER'");
});
it.each([false,undefined,null,1,'true'])('refuses non-true permission gate %j',async allowed=>{
  await expect(verifyBibleRuntimeRole({query:async()=>({rows:[{allowed}]})} as unknown as Pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('redacts failed and missing database permission results',async()=>{
  await expect(verifyBibleRuntimeRole({query:async()=>{throw new Error('private-login');}} as unknown as Pool)).rejects.toThrow('restricted Bible role');
  await expect(verifyBibleRuntimeRole({query:async()=>({rows:[]})} as unknown as Pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

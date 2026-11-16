import { expect, it } from 'vitest';
import { ApiClient } from '../src/api.js';
import { createSessionStore } from '../src/session.js';
it('keeps credentials in memory and ignores stale connection completions', () => {
  const state = createSessionStore(); const first = state.getState().reset(); const latest = state.getState().reset();
  const client = new ApiClient(`cmry_${'c'.repeat(43)}`); const identity = { tenantId:'tenant',userId:'user',grants:[] };
  expect(state.getState().connected(first,client,identity)).toBe(false);
  expect(state.getState().connected(latest,client,identity)).toBe(true); expect(state.getState().client).toBe(client);
  expect(JSON.stringify(state.getState())).not.toContain('cmry_'); state.getState().reset();
  expect(state.getState().client).toBeNull(); expect(state.getState().identity).toBeNull();
});

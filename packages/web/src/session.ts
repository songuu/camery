import { createStore } from 'zustand/vanilla';
import type { ApiClient, Identity } from './api.js';
interface SessionState {
  readonly generation: number; readonly client: ApiClient | null; readonly identity: Identity | null;
  reset(): number;
  connected(generation: number, client: ApiClient, identity: Identity): boolean;
}
/** Memory only. A stale authentication response cannot replace a newer connection. */
export function createSessionStore() {
  return createStore<SessionState>((set,get) => ({ generation: 0, client: null, identity: null,
    reset() { const generation = get().generation + 1; set({ generation,client:null,identity:null }); return generation; },
    connected(generation,client,identity) { if (get().generation !== generation) return false; set({ client,identity }); return true; },
  }));
}

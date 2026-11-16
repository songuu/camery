import { AgentError } from './registry.js';
/** Reject asynchronous host callbacks while observing a late rejection so it cannot escape the boundary. */
export function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
    void Promise.resolve(value).catch(() => {}); throw new AgentError('ASYNC_CALLBACK');
  }
  return value;
}

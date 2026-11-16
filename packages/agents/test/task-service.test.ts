import { expect, it } from 'vitest';
import { persistenceData, TaskKeySchema, validateTaskTreeDefinition } from '../src/task-service.js';
import type { TaskTreeDefinition } from '../src/task-service.js';
const agent = { id: 'research', version: '1.0.0', digest: 'a'.repeat(64) };
function definition(): TaskTreeDefinition {
  return { tenantId: 'tenant', projectId: 'project', treeId: 'tree', tasks: [{ taskId: 'root', parentId: null, agent, input: { text: 'source' }, dependencies: [], scope: { tenantId: 'tenant', projectId: 'project', objectIds: ['source'] }, status: 'queued' }], routes: [{ agent, workflow: 'research-flow', version: 1, maxAttempts: 1, outputKind: 'agent_report' }] };
}
it('returns a frozen snapshot of the initial task tree and precise registered-role routes', () => {
  const input = definition(); const saved = validateTaskTreeDefinition(input); input.routes[0]!.workflow = 'changed'; expect(saved.routes[0]!.workflow).toBe('research-flow'); expect(Object.isFrozen(saved.tasks[0]!.input)).toBe(true);
});
it.each(['nonqueued', 'tenant', 'project', 'missing-route', 'wrong-id', 'wrong-version', 'wrong-digest', 'duplicate-route', 'unused-route'] as const)('rejects task declarations that cannot be dispatched consistently: %s', kind => {
  const input = definition();
  if (kind === 'nonqueued') input.tasks = [{ ...input.tasks[0]!, status: 'running' }];
  if (kind === 'tenant' || kind === 'project') input[kind === 'tenant' ? 'tenantId' : 'projectId'] = 'other';
  if (kind.startsWith('wrong-')) { const field = kind === 'wrong-id' ? 'id' : kind === 'wrong-version' ? 'version' : 'digest'; input.routes[0]!.agent = { ...agent, [field]: field === 'digest' ? 'b'.repeat(64) : field === 'version' ? '2.0.0' : 'other' }; }
  if (kind === 'missing-route') input.routes = [];
  if (kind === 'duplicate-route') input.routes.push(structuredClone(input.routes[0]!));
  if (kind === 'unused-route') input.routes.push({ ...input.routes[0]!, agent: { ...agent, id: 'unused', digest: 'b'.repeat(64) } });
  expect(() => validateTaskTreeDefinition(input)).toThrow();
});
it('rejects non-JSON or malformed identities without reflecting supplied content', () => {
  const cyclic: Record<string, unknown> = {}; cyclic['private'] = cyclic;
  for (const input of [cyclic, { tenantId: '', projectId: 'project', taskId: 'private-text' }]) expect(() => persistenceData(TaskKeySchema, input)).toThrow('INVALID_COLLABORATION_INPUT');
  expect(persistenceData(TaskKeySchema, { tenantId: 'tenant', projectId: 'project', taskId: 'task' })).toEqual({ tenantId: 'tenant', projectId: 'project', taskId: 'task' });
});

import { z } from 'zod';
import { freeze, jsonCopy, Pin } from '@camery/methods';
import { Id, Name } from './registry.js';
import { validateTaskTree } from './collaboration.js';
import type { AgentTask } from './collaboration.js';
export const TaskKeySchema = z.strictObject({ tenantId: Name, projectId: Name, taskId: Name });
export type LogicalTaskKey = z.infer<typeof TaskKeySchema>;
export const TreeKeySchema = z.strictObject({ tenantId: Name, projectId: Name, treeId: Name });
export type TaskTreeKey = z.infer<typeof TreeKeySchema>;
export const RouteSchema = z.strictObject({ agent: Pin, workflow: Id, version: z.int().min(1).max(2147483647), maxAttempts: z.int().min(1).max(100), outputKind: z.enum(['agent_report', 'raw']) });
export type AgentTaskRoute = z.infer<typeof RouteSchema>;
export interface TaskTreeDefinition extends TaskTreeKey { tasks: readonly AgentTask[]; routes: AgentTaskRoute[] }
export interface StoredTask { task: AgentTask; treeId: string; revision: number; durableTaskId: string | null }
export interface StoredTaskTree { definition: TaskTreeDefinition; tasks: StoredTask[] }
export class AgentPersistenceError extends Error {
  override readonly name = 'AgentPersistenceError';
  constructor(readonly code: string) { super(`${code}: agent persistence`); }
}
export function persistenceData<T>(schema: z.ZodType<T>, input: unknown): T {
  try { const parsed = schema.safeParse(jsonCopy(input)); if (parsed.success) return freeze(parsed.data) as T; } catch { /* Keep database/client diagnostics free of source text. */ }
  throw new AgentPersistenceError('INVALID_COLLABORATION_INPUT');
}
export function validateTaskTreeDefinition(input: TaskTreeDefinition): TaskTreeDefinition {
  const parsed = persistenceData(TreeKeySchema.extend({ tasks: z.array(z.unknown()).min(1).max(1000), routes: z.array(RouteSchema).min(1).max(64) }), input);
  const tasks = validateTaskTree(parsed.tasks as AgentTask[]); const routes = parsed.routes;
  const matches = (task: AgentTask, route: AgentTaskRoute): boolean => route.agent.id === task.agent.id && route.agent.version === task.agent.version && route.agent.digest === task.agent.digest;
  if (tasks.some(task => task.status !== 'queued' || task.scope.tenantId !== parsed.tenantId || task.scope.projectId !== parsed.projectId) || new Set(routes.map(route => route.agent.digest)).size !== routes.length || tasks.some(task => !routes.some(route => matches(task, route))) || routes.some(route => !tasks.some(task => matches(task, route)))) throw new AgentPersistenceError('INVALID_TASK_TREE_DEFINITION');
  return freeze({ tenantId: parsed.tenantId, projectId: parsed.projectId, treeId: parsed.treeId, tasks, routes: jsonCopy(routes) });
}

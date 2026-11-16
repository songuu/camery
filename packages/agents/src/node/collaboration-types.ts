import type { PoolClient } from 'pg';
import type { Json } from '@camery/durable';
import type { AgentIssue, AgentQuestion, AgentTask, QuestionInput } from '../collaboration.js';
import type { LogicalTaskKey } from '../task-service.js';
export interface StoredQuestion { question: AgentQuestion; gateKey: string | null; durableTaskId: string | null; gateInputDigest: string | null; delivery: 'none' | 'pending' | 'delivered' }
/** Internal transaction capability. Callers share the project's lock; never call a provider from it. */
export interface CollaborationTransaction {
  client: PoolClient; task: AgentTask; revision: number;
  putIssue(issue: AgentIssue, actorId: string): Promise<void>;
  openQuestion(question: QuestionInput, actorId: string, gateKey?: string): Promise<StoredQuestion>;
  event(action: string, detail: Json): Promise<void>;
}
export interface CollaborationTransactions {
  withTask<T>(key: LogicalTaskKey, run: (context: CollaborationTransaction) => Promise<T>): Promise<T>;
}

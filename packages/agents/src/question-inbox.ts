import type { TaskKey } from '@camery/durable';
import type { MethodPin } from '@camery/methods';
import type { AgentQuestion } from './collaboration.js';

export interface QuestionInboxBinding {
  task: Readonly<TaskKey>;
  agent: MethodPin;
  gateKey: string;
}
/** Trusted host capability. Persist the exact open Question before the runtime creates its durable gate. */
export interface QuestionInbox {
  readonly identity: string;
  readonly digest: string;
  open(question: Readonly<AgentQuestion>, binding: Readonly<QuestionInboxBinding>, signal: AbortSignal): Promise<void>;
}

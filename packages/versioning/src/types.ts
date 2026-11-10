import type { ChangeSet, StoryboardPackage } from '@camery/ir';

export interface VersionIssue { code: string; where: string; message: string }
export type ChangeStatus = 'candidate' | 'adopted' | 'rejected' | 'conflicted';
export interface ObjectRevision {
  collection: string; object_id: string; version: number; parent_version: number | null;
  snapshot_revision: number;
  change_set_id: string | null; value: Record<string, unknown> | null;
}
export interface StoredChange {
  request: ChangeSet; status: ChangeStatus; preview: StoryboardPackage | null;
  generated_ids: string[]; issues: VersionIssue[]; warnings: VersionIssue[];
  affected_ids: string[];
  prepared_from_revision: number;
  rejection?: { actor_id: string; reason: string; at: string };
}
export type AdoptionScope = { kind: 'project' | 'episode' | 'scene'; id: string };
export interface Principal { kind: 'user' | 'agent_run' | 'system'; id: string }
export interface AdoptionRecord {
  change_set_id: string; actor_id: string; scope: AdoptionScope;
  from_revision: number; to_revision: number; at: string;
}
export interface VersionState {
  head: StoryboardPackage; revisions: ObjectRevision[]; changes: StoredChange[]; adoptions: AdoptionRecord[];
}
export interface ChangeResult { state: VersionState; status: ChangeStatus; issues: VersionIssue[]; warnings: VersionIssue[] }
export interface SubmitOptions { newId?: () => string }
/** Principal 与授权回调必须由受信服务构造，不能来自 Agent 或请求 JSON 的自报字段。 */
export interface AdoptOptions {
  actor: Principal; scope: AdoptionScope; at: string;
  authorize: (actor: Principal, scope: AdoptionScope) => boolean;
}

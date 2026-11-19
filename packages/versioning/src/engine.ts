import { ChangeSet, StableId, StoryboardPackage, validatePackage } from '@camery/ir';
import { evaluate } from './evaluate';
import { VersioningError } from './errors';
import { synchronousGrant } from './grants';
import { historicalIds, jsonSignature, nextVersion, objects } from './objects';
import type { LocatedObject } from './objects';
import type { AdoptOptions, AdoptionScope, ChangeResult, ChangeStatus, StoredChange, SubmitOptions, VersionIssue, VersionState } from './types';

function failure(state: VersionState, code: string, where: string, message: string): ChangeResult {
  return { state, status: 'rejected', issues: [{ code, where, message }], warnings: [] };
}

function result(state: VersionState, change: StoredChange): ChangeResult {
  return { state, status: change.status, issues: change.issues, warnings: change.warnings };
}

export function createVersionState(input: unknown): VersionState {
  jsonSignature(input);
  const parsed = StoryboardPackage.safeParse(input);
  if (!parsed.success || !validatePackage(parsed.data).valid || parsed.data.revision.status !== 'adopted')
    throw new VersioningError('INVALID_HEAD', '/head', 'Baseline must be a valid adopted snapshot');
  const head = structuredClone(parsed.data);
  return {
    head, changes: [], adoptions: [],
    revisions: [...objects(head)].map(([id, row]) => ({ collection: row.collection, object_id: id, version: row.value.version, parent_version: null, snapshot_revision: head.revision.number, change_set_id: null, value: structuredClone(row.value) })),
  };
}

export function submitChangeSet(state: VersionState, input: unknown, options: SubmitOptions = {}): ChangeResult {
  let signature: string;
  try { signature = jsonSignature(input); }
  catch (error) {
    if (!(error instanceof VersioningError)) throw error;
    return failure(state, error.code, error.where, error.message);
  }
  const parsed = ChangeSet.safeParse(input);
  if (!parsed.success) return { state, status: 'rejected', issues: parsed.error.issues.map(i => ({ code: 'SCHEMA', where: '/' + i.path.join('/'), message: i.message })), warnings: [] };
  if (historicalIds(state).has(parsed.data.id)) return failure(state, 'ID_REUSE', '/id', 'ChangeSet identity must not reuse a current or historical content identity');
  const existing = state.changes.find(c => c.request.id === parsed.data.id);
  if (existing) return jsonSignature(existing.request) === signature ? result(state, existing)
    : failure(state, 'CHANGE_ID_CONFLICT', '/id', 'A different request already uses this ChangeSet ID');
  const upgrading=parsed.data.ops.some(op=>op.op==='upgrade_schema');
  if(upgrading&&parsed.data.ops.length!==1)return failure(state,'SCHEMA_UPGRADE_EXCLUSIVE','/ops','Schema upgrade must be its own ChangeSet');
  if((upgrading&&state.changes.some(change=>change.status==='candidate'))||state.changes.some(change=>change.status==='candidate'&&change.request.ops.some(op=>op.op==='upgrade_schema')))
    return failure(state,'SCHEMA_UPGRADE_PENDING_CHANGES','/changes','Resolve live candidates before preparing another change across a schema upgrade');
  const change = evaluate(state, parsed.data, options);
  const next = structuredClone(state);
  next.changes.push(structuredClone(change));
  return result(next, change);
}

function authorized(state: VersionState, options: AdoptOptions): ChangeResult | undefined {
  if (options.actor.kind !== 'user' || !StableId.safeParse(options.actor.id).success || typeof options.authorize !== 'function')
    return failure(state, 'ADOPTION_AUTHORITY', '/actor', 'Human identity and a trusted host authorization grant are required');
  if (!['project', 'episode', 'scene'].includes(options.scope.kind) || !StableId.safeParse(options.scope.id).success)
    return failure(state, 'ADOPTION_SCOPE', '/scope', 'Adoption scope is invalid');
  if (typeof options.at !== 'string' || !Number.isFinite(Date.parse(options.at)) || new Date(options.at).toISOString() !== options.at)
    return failure(state, 'ADOPTION_TIME', '/at', 'Host must supply a canonical UTC timestamp');
  try {
    if (!synchronousGrant(options.authorize(options.actor, options.scope))) return failure(state, 'ADOPTION_AUTHORITY', '/actor', 'Trusted host denied adoption authority');
  } catch { return failure(state, 'ADOPTION_AUTHORITY', '/actor', 'Trusted host could not verify adoption authority'); }
  return undefined;
}

function location(row: LocatedObject, pkg: StoryboardPackage): { scene: string | undefined; episode: string | undefined } {
  const value = row.value;
  let scene: string | undefined;
  let episode: string | undefined;
  if (row.collection === 'episodes') episode = value.id;
  if (row.collection === 'episode_plans') episode = value.episode_id as string;
  else if (row.collection === 'scenes') { scene = value.id; episode = value.episode_id as string; }
  else if (row.collection === 'shots' || row.collection === 'beats') scene = value.scene_id as string;
  else if (row.collection === 'lines') scene = pkg.beats.find(b => b.id === value.beat_id)?.scene_id;
  else if (row.collection === 'panels' || row.collection === 'shot_takes') scene = pkg.shots.find(s => s.id === value.shot_id)?.scene_id;
  else if (row.collection === 'episode_state_snapshots' || row.collection === 'continuity_snapshots') episode = value.episode_id as string;
  else if (row.collection === 'audio_cues') {
    episode = value.episode_id as string;
    if (typeof value.scene_id === 'string') scene = value.scene_id;
    if (typeof value.line_id === 'string') scene = pkg.beats.find(b => b.id === pkg.lines.find(l => l.id === value.line_id)?.beat_id)?.scene_id;
  }
  if (scene !== undefined) episode = pkg.scenes.find(s => s.id === scene)?.episode_id;
  return { scene, episode };
}

function inScope(row: LocatedObject, pkg: StoryboardPackage, scope: AdoptionScope): boolean {
  if (scope.kind === 'project') return scope.id === pkg.project.id;
  if (row.collection === 'locks') {
    const target = objects(pkg).get(row.value.target as string);
    return target !== undefined && target.collection !== 'locks' && inScope(target, pkg, scope);
  }
  if (row.collection === 'segments') {
    const uses = pkg.shot_takes.filter(t => t.segment_revision_id.id === row.value.id);
    return uses.length > 0 && uses.every(t => {
      const shot = objects(pkg).get(t.shot_id);
      return shot !== undefined && inScope(shot, pkg, scope);
    });
  }
  const owner = location(row, pkg);
  return scope.kind === 'scene' ? owner.scene === scope.id : owner.episode === scope.id;
}

function scopeIssue(before: StoryboardPackage, after: StoryboardPackage, scope: AdoptionScope, affected?: ReadonlySet<string>): VersionIssue | undefined {
  if ((scope.kind === 'project' && scope.id !== before.project.id) || (scope.kind === 'episode' && !before.episodes.some(e => e.id === scope.id)) || (scope.kind === 'scene' && !before.scenes.some(s => s.id === scope.id)))
    return { code: 'ADOPTION_SCOPE', where: '/scope', message: 'Adoption scope does not exist in the adopted snapshot' };
  const oldRows = objects(before);
  const newRows = objects(after);
  for (const id of affected ?? new Set([...oldRows.keys(), ...newRows.keys()])) {
    const old = oldRows.get(id);
    const current = newRows.get(id);
    if (affected === undefined && old && current && jsonSignature(old.value) === jsonSignature(current.value)) continue;
    if (!old && !current && scope.kind !== 'project') return { code: 'ADOPTION_SCOPE', where: '/objects/' + id, message: 'Original affected object is no longer available to prove a narrow rejection scope' };
    if ((old && !inScope(old, before, scope)) || (current && !inScope(current, after, scope)))
      return { code: 'ADOPTION_SCOPE', where: '/objects/' + id, message: 'Explicit or implicit change lies outside the approved scope' };
  }
  return undefined;
}

function setDecision(state: VersionState, id: string, status: ChangeStatus, issues: VersionIssue[], warnings: VersionIssue[]): ChangeResult {
  const next = structuredClone(state);
  const change = next.changes.find(c => c.request.id === id)!;
  change.status = status; change.issues = issues; change.warnings = warnings;
  return result(next, change);
}

/** 仅恢复作用域证据，不作为内容回滚或新的正式快照；对象及其父级使用同一提交时点。 */
function rejectionEvidence(state: VersionState, revision: number): StoryboardPackage {
  const evidence = structuredClone(state.head);
  const latest = new Map<string, VersionState['revisions'][number]>();
  const collections = new Set<string>();
  for (const row of state.revisions) {
    collections.add(row.collection);
    if (row.snapshot_revision <= revision) latest.set(row.object_id, row);
  }
  const target = evidence as unknown as Record<string, unknown>;
  for (const collection of collections) target[collection] = [...latest.values()].filter(row => row.collection === collection && row.value !== null).map(row => structuredClone(row.value));
  return evidence;
}

export function adoptChangeSet(state: VersionState, id: string, options: AdoptOptions): ChangeResult {
  const denied = authorized(state, options);
  if (denied) return denied;
  const stored = state.changes.find(c => c.request.id === id);
  if (!stored) return failure(state, 'MISSING_CHANGE', '/change_set_id', 'ChangeSet does not exist');
  const upgrading=stored.request.ops.some(op=>op.op==='upgrade_schema');
  if(upgrading&&(options.scope.kind!=='project'||options.scope.id!==state.head.project.id))return failure(state,'SCHEMA_UPGRADE_PROJECT_ONLY','/scope','Schema upgrade requires project adoption scope');
  if(upgrading&&stored.status==='candidate'&&state.changes.some(change=>change.request.id!==id&&change.status==='candidate'))return failure(state,'SCHEMA_UPGRADE_PENDING_CHANGES','/changes','Resolve all other live candidates before schema adoption');
  if (stored.request.ops.some(op => op.op === 'lock' || op.op === 'unlock' || op.op === 'unlock_line') && stored.request.author.id !== options.actor.id)
    return failure(state, 'LOCK_AUTHORITY', '/actor', 'The trusted adopting identity must match the human lock request author');
  if (stored.status === 'adopted') return result(state, stored);
  if (stored.status !== 'candidate') return failure(state, 'CHANGE_STATE', '/status', 'Only a live candidate can be adopted');
  let generatedAt = 0;
  const prepared = evaluate(state, stored.request, { newId: () => {
    const next = stored.generated_ids[generatedAt++];
    if (next === undefined) throw new VersioningError('REBASE_REQUIRED', '/generated_ids', 'Dependent material changed; resubmit with a new ChangeSet ID');
    return next;
  } });
  if (prepared.status !== 'candidate' || prepared.preview === null) return setDecision(state, id, prepared.status, prepared.issues, prepared.warnings);
  if (generatedAt !== stored.generated_ids.length) return setDecision(state, id, 'conflicted', [{ code: 'REBASE_REQUIRED', where: '/generated_ids', message: 'Dependent material changed since preview' }], prepared.warnings);
  const outside = scopeIssue(state.head, prepared.preview, options.scope);
  if (outside) return { state, status: 'rejected', issues: [outside], warnings: prepared.warnings };
  const next = structuredClone(state);
  const before = objects(state.head);
  const after = objects(prepared.preview);
  for (const objectId of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(objectId);
    const current = after.get(objectId);
    if (old && current && jsonSignature(old.value) === jsonSignature(current.value)) continue;
    next.revisions.push({
      collection: (current ?? old)!.collection, object_id: objectId,
      version: current?.value.version ?? nextVersion(old!.value.version), parent_version: old?.value.version ?? null,
      snapshot_revision: prepared.preview.revision.number,
      change_set_id: id, value: current ? structuredClone(current.value) : null,
    });
  }
  next.head = structuredClone(prepared.preview);
  next.head.revision.status = 'adopted';
  const change = next.changes.find(c => c.request.id === id)!;
  change.status = 'adopted'; change.preview = structuredClone(next.head); change.issues = []; change.warnings = prepared.warnings; change.affected_ids = prepared.affected_ids;
  next.adoptions.push({ change_set_id: id, actor_id: options.actor.id, scope: structuredClone(options.scope), from_revision: state.head.revision.number, to_revision: next.head.revision.number, at: options.at });
  return result(next, change);
}

export function rejectChangeSet(state: VersionState, id: string, options: AdoptOptions, reason: string): ChangeResult {
  const denied = authorized(state, options);
  if (denied) return denied;
  const stored = state.changes.find(c => c.request.id === id);
  if (!stored) return failure(state, 'MISSING_CHANGE', '/change_set_id', 'ChangeSet does not exist');
  if(stored.request.ops.some(op=>op.op==='upgrade_schema')&&(options.scope.kind!=='project'||options.scope.id!==state.head.project.id))return failure(state,'SCHEMA_UPGRADE_PROJECT_ONLY','/scope','Schema upgrade requires project decision scope');
  if (stored.status !== 'candidate') return failure(state, 'CHANGE_STATE', '/status', 'Only a live candidate can be rejected');
  if (!reason.trim()) return failure(state, 'REJECTION_REASON', '/reason', 'Human rejection must record a reason');
  if (stored.preview) {
    // 拒绝只改变此候选决定，不把旧预览中的其他场次视为一次“回滚”。
    const outside = scopeIssue(rejectionEvidence(state, stored.prepared_from_revision), stored.preview, options.scope, new Set(stored.affected_ids));
    if (outside) return { state, status: 'rejected', issues: [outside], warnings: [] };
  }
  const next = structuredClone(state);
  const change = next.changes.find(c => c.request.id === id)!;
  change.status = 'rejected'; change.rejection = { actor_id: options.actor.id, reason, at: options.at };
  return result(next, change);
}

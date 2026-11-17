import { ChangeSet, EditableCollection, StableId, StoryboardPackage, validatePackage,upgradeV05Package,LEGACY_SCHEMA_VERSION,SCHEMA_VERSION } from '@camery/ir';
import { moveClip, TimelineError } from '@camery/timeline';
import { applyShotEdit, ShotEditError } from './shot-edits';
import { VersioningError } from './errors';
import { changedFields, historicalIds, identityOwners, jsonSignature, nextVersion, objects, overlapsField } from './objects';
import type { VersionedObject } from './objects';
import type { StoredChange, SubmitOptions, VersionIssue, VersionState } from './types';

function requireObject(pkg: StoryboardPackage, id: string, collection?: string): VersionedObject {
  const row = objects(pkg).get(id);
  if (row === undefined || (collection !== undefined && row.collection !== collection)) throw new VersioningError('MISSING_OBJECT', '/objects/' + id, 'Object does not exist in the expected collection');
  return row.value;
}

/** schema 边界内的动态集合操作；最后必须重新通过完整 IR 校验，不能把 record 写入直接当成已验证内容。 */
function rows(pkg: StoryboardPackage, collection: EditableCollection): VersionedObject[] {
  const value=(pkg as unknown as Record<string,unknown>)[collection];
  if(!Array.isArray(value))throw new VersioningError('SCHEMA_VERSION','/ops','Collection does not exist in this schema version');
  return value as VersionedObject[];
}

function checkLocks(before: StoryboardPackage, after: StoryboardPackage, released: string | undefined): void {
  const oldObjects = objects(before);
  const newObjects = objects(after);
  for (const [id, old] of oldObjects) {
    const current = newObjects.get(id);
    const fields = current === undefined ? [''] : changedFields(old.value, current.value);
    if (!fields.length) continue;
    if (old.collection === 'lines' && old.value.locked === true && fields.some(field => overlapsField('text', field)))
      throw new VersioningError('LOCKED_LINE', '/lines/' + id, 'Line text requires an explicit prior unlock');
    for (const lock of before.locks) if (lock.id !== released && lock.target === id &&
        (lock.fields.length === 0 || lock.fields.some(path => fields.some(field => overlapsField(path, field)))))
      throw new VersioningError('LOCKED', '/locks/' + lock.id, 'Operation touches a locked object or field');
  }
}

function humanRequest(request: ChangeSet): void {
  if (request.author.kind !== 'user') throw new VersioningError('LOCK_AUTHORITY', '/author', 'Only an explicit human request may change locks');
}

export function evaluate(state: VersionState, request: ChangeSet, options: SubmitOptions): StoredChange {
  const warnings: VersionIssue[] = [];
  const generated: string[] = [];
  let draft = structuredClone(state.head);
  const initial = objects(state.head);
  const base = new Map<string, number>();
  const historical = historicalIds(state);
  const originalOwners = identityOwners(state.head);
  const allocated = new Set(historical);
  for (const change of state.changes) allocated.add(change.request.id);
  allocated.add(request.id);
  const fail = (status: 'rejected' | 'conflicted', issues: VersionIssue[]): StoredChange => ({ request, status, preview: null, generated_ids: generated, affected_ids: [], prepared_from_revision: state.head.revision.number, issues, warnings });
  try {
    if (request.status !== 'candidate') throw new VersioningError('CHANGE_STATE', '/status', 'Only candidate requests may be submitted');
    const upgrading=request.ops.some(op=>op.op==='upgrade_schema');
    if(upgrading&&request.ops.length!==1)throw new VersioningError('SCHEMA_UPGRADE_EXCLUSIVE','/ops','Schema upgrade must be its own ChangeSet');
    if(upgrading&&request.base_revision!==state.head.revision.number)throw new VersioningError('SCHEMA_UPGRADE_BASE','/base_revision','Schema upgrade requires the exact current snapshot');
    if(request.schema_version!==state.head.schema_version&&!(upgrading&&state.head.schema_version===LEGACY_SCHEMA_VERSION&&request.schema_version===SCHEMA_VERSION))throw new VersioningError('SCHEMA_VERSION','/schema_version','Request does not match the adopted schema version');
    if (request.base_revision > state.head.revision.number) throw new VersioningError('FUTURE_BASE', '/base_revision', 'Request was prepared against an unknown future snapshot');
    for (const ref of request.base_revisions) {
      if (base.has(ref.id)) throw new VersioningError('DUPLICATE_BASE', '/base_revisions', 'Object base revisions must be unique');
      base.set(ref.id, ref.version);
      if (initial.get(ref.id)?.value.version !== ref.version)
        return fail('conflicted', [{ code: 'REVISION_CONFLICT', where: '/base_revisions/' + ref.id, message: 'Read object revision changed or the object was removed' }]);
    }
    const opIds = new Set<string>();
    const touched = new Set<string>();
    const reserve = (id: unknown, where: string): string => {
      if (!StableId.safeParse(id).success) throw new VersioningError('IDENTIFIER', where, 'New objects require canonical ULIDs');
      const value = id as string;
      if (allocated.has(value)) throw new VersioningError('ID_REUSE', where, 'An active or historical object already used this ID');
      allocated.add(value); return value;
    };
    const newId = (): string => {
      if (!options.newId) throw new VersioningError('ID_REQUIRED', '/generated_ids', 'Split references require an ID allocator');
      const id = reserve(options.newId(), '/generated_ids'); generated.push(id); return id;
    };
    for (const [index, op] of request.ops.entries()) {
      if (opIds.has(op.op_id)) throw new VersioningError('DUPLICATE_OP', `/ops/${index}/op_id`, 'Operation IDs must be unique');
      opIds.add(op.op_id);
      const before = structuredClone(draft);
      let released: string | undefined;
      if(op.op==='upgrade_schema'){
        humanRequest(request);
        if(draft.schema_version!==op.from)throw new VersioningError('SCHEMA_VERSION',`/ops/${index}`,'Only a legacy head may be upgraded');
        draft=upgradeV05Package(draft);
      }else if (op.op === 'update' || op.op === 'replace' || op.op === 'remove') {
        const original = requireObject(draft, op.target, op.collection);
        touched.add(op.target);
        const list = rows(draft, op.collection);
        const at = list.findIndex(row => row.id === op.target);
        if (op.op === 'remove') list.splice(at, 1);
        else {
          const value = op.op === 'update' ? { ...original, ...op.set } : op.value;
          if (value.id !== original.id || value.version !== original.version) throw new VersioningError('IMMUTABLE_IDENTITY', `/ops/${index}`, 'An update cannot set object ID or revision');
          if (op.collection === 'lines' && value.locked !== original.locked) throw new VersioningError('LOCK_OPERATION_REQUIRED', `/ops/${index}`, 'Line locks require explicit lock/unlock operations');
          list[at] = value as VersionedObject;
        }
      } else if (op.op === 'add') {
        reserve(op.value.id, `/ops/${index}/value/id`);
        if (op.value.version !== 1) throw new VersioningError('INITIAL_VERSION', `/ops/${index}/value/version`, 'New object revision must be one');
        if (op.collection === 'lines' && op.value.locked === true) throw new VersioningError('LOCK_OPERATION_REQUIRED', `/ops/${index}`, 'New line text requires an explicit subsequent human lock operation');
        rows(draft, op.collection).push(op.value as VersionedObject);
      } else if (op.op === 'move') {
        const shot = draft.shots.find(s => s.id === op.target);
        if (!shot) throw new VersioningError('MISSING_OBJECT', `/ops/${index}/target`, 'Move target is not an active shot');
        const group = draft.shots.filter(s => s.scene_id === shot.scene_id && s.rendition_id === shot.rendition_id);
        const moved = moveClip(group, shot.id, op.before_id);
        const replacement = new Map(moved.map(s => [s.id, s]));
        draft.shots = draft.shots.map(s => replacement.get(s.id) ?? s);
        touched.add(op.target);
      } else if (op.op === 'split' || op.op === 'merge') {
        const targets = op.op === 'split' ? [op.target] : op.targets;
        targets.forEach(id => touched.add(id));
        const replacements = op.op === 'split' ? op.into : [op.into];
        replacements.forEach(row => reserve(row.id, `/ops/${index}/into`));
        draft = applyShotEdit(draft, op, { newId, warn: issue => warnings.push(issue) });
      } else if (op.op === 'lock') {
        humanRequest(request);
        if (objects(draft).get(op.target)?.collection === 'locks') throw new VersioningError('LOCK_TARGET', `/ops/${index}/target`, 'Locks protect content objects, not lock metadata');
        requireObject(draft, op.target);
        touched.add(op.target);
        reserve(op.lock_id, `/ops/${index}/lock_id`);
        const target = requireObject(draft, op.target);
        for (const path of op.fields) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(path) || path.split('.').some(part => ['id', 'version', '__proto__', 'prototype', 'constructor'].includes(part)))
            throw new VersioningError('LOCK_FIELD', `/ops/${index}/fields`, 'Lock field path is invalid or reserved');
          let value: unknown = target;
          for (const part of path.split('.')) {
            if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) throw new VersioningError('LOCK_FIELD', `/ops/${index}/fields`, 'Locked field must exist on the target');
            value = (value as Record<string, unknown>)[part];
          }
        }
        draft.locks.push({ id: op.lock_id, version: 1, target: op.target, fields: op.fields, owner_id: request.author.id, reason: op.reason });
        const line = draft.lines.find(l => l.id === op.target);
        if (line && (op.fields.length === 0 || op.fields.some(path => overlapsField(path, 'text')))) line.locked = true;
      } else if (op.op === 'unlock') {
        humanRequest(request);
        const lock = draft.locks.find(l => l.id === op.lock_id);
        if (!lock) throw new VersioningError('MISSING_OBJECT', `/ops/${index}/lock_id`, 'Lock does not exist');
        if (lock.owner_id !== request.author.id) throw new VersioningError('LOCK_OWNER', `/ops/${index}`, 'Only the lock owner may release this lock');
        touched.add(lock.id); touched.add(lock.target);
        released = lock.id;
        draft.locks = draft.locks.filter(l => l.id !== lock.id);
        const line = draft.lines.find(l => l.id === lock.target);
        if (line && !draft.locks.some(l => l.target === line.id && (l.fields.length === 0 || l.fields.some(path => overlapsField(path, 'text'))))) line.locked = false;
      } else {
        humanRequest(request);
        const line = draft.lines.find(l => l.id === op.target);
        if (!line) throw new VersioningError('MISSING_OBJECT', `/ops/${index}/target`, 'Line does not exist');
        if (draft.locks.some(l => l.target === line.id && (l.fields.length === 0 || l.fields.some(path => overlapsField(path, 'text')))))
          throw new VersioningError('LOCK_OPERATION_REQUIRED', `/ops/${index}`, 'Release the explicit text/object locks first');
        line.locked = false; touched.add(line.id);
      }
      checkLocks(before, draft, released);
      const afterObjects = objects(draft);
      for (const [id, old] of objects(before)) {
        const current = afterObjects.get(id);
        if (current === undefined || jsonSignature(old.value) !== jsonSignature(current.value)) touched.add(id);
      }
    }
    for (const id of touched) if (initial.has(id) && !base.has(id)) throw new VersioningError('BASE_REQUIRED', '/base_revisions/' + id, 'Every explicit and implicit write requires an object base revision');
    for (const [id, row] of objects(draft)) {
      const old = initial.get(id);
      if (old && jsonSignature(row.value) !== jsonSignature(old.value)) row.value.version = nextVersion(old.value.version);
    }
    draft.project.scope.expected_episode_count = draft.episodes.length;
    draft.project.scope.expected_scene_count = draft.scenes.length;
    draft.project.scope.expected_required_beat_count = draft.beats.filter(b => b.required).length;
    draft.revision = { number: nextVersion(state.head.revision.number), status: 'candidate', note: request.id };
    const parsed = StoryboardPackage.safeParse(draft);
    if (!parsed.success) return fail('rejected', parsed.error.issues.map(i => ({ code: 'SCHEMA', where: '/' + i.path.join('/'), message: i.message })));
    for (const [id, owner] of identityOwners(parsed.data)) {
      const oldOwner = originalOwners.get(id);
      if ((oldOwner !== undefined && oldOwner !== owner) || (oldOwner === undefined && historical.has(id)))
        throw new VersioningError('ID_REUSE', '/objects/' + id, 'Stable identity cannot be reassigned or reused after retirement');
    }
    const report = validatePackage(parsed.data);
    if (!report.valid) return fail('rejected', report.errors);
    warnings.push(...report.warnings.filter(issue=>issue.code==='STALE_DEVELOPMENT_DEPENDENCY'));
    const final = objects(parsed.data);
    const affected = [...new Set([...initial.keys(), ...final.keys()])].filter(id => {
      const before = initial.get(id);
      const after = final.get(id);
      return before === undefined || after === undefined || jsonSignature(before.value) !== jsonSignature(after.value);
    });
    return { request, status: 'candidate', preview: parsed.data, generated_ids: generated, affected_ids: affected, prepared_from_revision: state.head.revision.number, issues: [], warnings };
  } catch (error) {
    if (error instanceof VersioningError || error instanceof TimelineError || error instanceof ShotEditError)
      return fail('rejected', [{ code: error.code, where: error.where, message: error.message }]);
    throw error;
  }
}

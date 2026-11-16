import { StableId } from '@camery/ir';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { adoptChangeSet, createVersionState, rejectChangeSet, submitChangeSet } from '../engine';
import { VersioningError } from '../errors';
import { synchronousGrant } from '../grants';
import { jsonSignature, nextVersion } from '../objects';
import type { AdoptOptions, AdoptionRecord, ChangeResult, ObjectRevision, StoredChange, SubmitOptions, VersionState } from '../types';
import { VersionPersistenceError } from './types';
import type { PersistedAdoptOptions, PersistedChangeResult, StoredVersionState, VersionProjectKey } from './types';

type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];
type ProjectRow = { package_id: string; initial_revision: string; head_revision: string; write_version: string };
const where = (key: VersionProjectKey): SQL => sql`tenant_id=${key.tenantId} AND project_id=${key.projectId}`;
const json = (value: unknown): SQL => sql`${jsonSignature(value)}::jsonb`;
function projectKey(input: VersionProjectKey): Readonly<VersionProjectKey> {
  const key = { tenantId: input?.tenantId, projectId: input?.projectId };
  if (!StableId.safeParse(key.tenantId).success || !StableId.safeParse(key.projectId).success) throw new VersionPersistenceError('INVALID_KEY', 'validate', String(key.projectId));
  return Object.freeze(key);
}
function number(value: string, project: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new VersionPersistenceError('CORRUPT_STATE', 'read numeric revision', project);
  return result;
}
function authority(key: VersionProjectKey, options: PersistedAdoptOptions): AdoptOptions {
  const actor = Object.freeze(structuredClone(options.actor)); const scope = Object.freeze(structuredClone(options.scope));
  const at = options.at; const authorize = options.authorize;
  return { actor, scope, at, authorize: (principal, grantedScope) => typeof authorize === 'function' && synchronousGrant(authorize(principal, key, grantedScope)) };
}

/** Server-only adapter: callers can submit requests, never client-supplied VersionState or whole-state replacements. */
export class PostgresVersionStore {
  private readonly db: NodePgDatabase;
  constructor(pool: Pool) { this.db = drizzle(pool); }
  private async operation<T>(key: VersionProjectKey, operation: string, execute: () => Promise<T>): Promise<T> {
    try { return await execute(); }
    catch (error) {
      if (error instanceof VersionPersistenceError || error instanceof VersioningError) throw error;
      // Drizzle errors include SQL parameters; preserve a safe SQLSTATE rather than leaking content or credentials.
      const cause = error instanceof Error && 'cause' in error ? error.cause : error;
      const code = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string' && /^[0-9A-Z]{5}$/.test(cause.code) ? cause.code : undefined;
      throw new VersionPersistenceError('DATABASE_ERROR', operation, key.projectId, code);
    }
  }
  private async load(tx: Tx, key: VersionProjectKey, row: ProjectRow): Promise<StoredVersionState> {
    const snapshots = await tx.execute<{ package: unknown }>(sql`SELECT package FROM camery_versioning.snapshots WHERE ${where(key)} AND revision=${row.head_revision}`);
    let state: VersionState;
    try { state = createVersionState(snapshots.rows[0]?.package); }
    catch { throw new VersionPersistenceError('CORRUPT_STATE', 'read head', key.projectId); }
    if (state.head.project.id !== key.projectId || state.head.package_id !== row.package_id || state.head.revision.number !== number(row.head_revision, key.projectId)) throw new VersionPersistenceError('CORRUPT_STATE', 'read head identity', key.projectId);
    const changes = await tx.execute<{ record: StoredChange }>(sql`SELECT record FROM camery_versioning.changes WHERE ${where(key)} ORDER BY sequence`);
    const revisions = await tx.execute<{ record: ObjectRevision }>(sql`SELECT record FROM camery_versioning.object_revisions WHERE ${where(key)} ORDER BY sequence`);
    const adoptions = await tx.execute<{ record: AdoptionRecord }>(sql`SELECT record FROM camery_versioning.adoptions WHERE ${where(key)} ORDER BY to_revision`);
    state.changes = changes.rows.map(r => r.record); state.revisions = revisions.rows.map(r => r.record); state.adoptions = adoptions.rows.map(r => r.record);
    return { state, writeVersion: number(row.write_version, key.projectId) };
  }
  async read(input: VersionProjectKey): Promise<StoredVersionState | null> {
    const key = projectKey(input);
    return this.operation(key, 'read', () => this.db.transaction(async tx => {
      const rows = await tx.execute<ProjectRow>(sql`SELECT * FROM camery_versioning.projects WHERE ${where(key)}`);
      return rows.rows[0] ? this.load(tx, key, rows.rows[0]) : null;
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' }));
  }
  async initialize(input: VersionProjectKey, snapshot: unknown): Promise<StoredVersionState> {
    const key = projectKey(input); const baseline = createVersionState(snapshot);
    if (baseline.head.project.id !== key.projectId) throw new VersionPersistenceError('PROJECT_MISMATCH', 'initialize', key.projectId);
    return this.operation(key, 'initialize', () => this.db.transaction(async tx => {
      const inserted = await tx.execute(sql`INSERT INTO camery_versioning.projects(tenant_id,project_id,package_id,initial_revision,head_revision)
        VALUES (${key.tenantId},${key.projectId},${baseline.head.package_id},${baseline.head.revision.number},${baseline.head.revision.number}) ON CONFLICT DO NOTHING RETURNING project_id`);
      const selected = await tx.execute<ProjectRow>(sql`SELECT * FROM camery_versioning.projects WHERE ${where(key)} FOR UPDATE`);
      const row = selected.rows[0];
      if (!row) throw new VersionPersistenceError('INITIALIZATION_CONFLICT', 'initialize package identity', key.projectId);
      if (!inserted.rows.length) {
        const initial = await tx.execute<{ package: unknown }>(sql`SELECT package FROM camery_versioning.snapshots WHERE ${where(key)} AND revision=${row.initial_revision}`);
        if (jsonSignature(initial.rows[0]?.package) !== jsonSignature(baseline.head)) throw new VersionPersistenceError('INITIALIZATION_CONFLICT', 'initialize baseline', key.projectId);
        return this.load(tx, key, row);
      }
      await this.snapshot(tx, key, baseline);
      await this.history(tx, key, baseline.revisions, []);
      return { state: baseline, writeVersion: 1 };
    }));
  }
  private async snapshot(tx: Tx, key: VersionProjectKey, state: VersionState): Promise<void> {
    await tx.execute(sql`INSERT INTO camery_versioning.snapshots(tenant_id,project_id,revision,package) VALUES (${key.tenantId},${key.projectId},${state.head.revision.number},${json(state.head)})`);
  }
  private async history(tx: Tx, key: VersionProjectKey, revisions: ObjectRevision[], adoptions: AdoptionRecord[]): Promise<void> {
    for (const revision of revisions) await tx.execute(sql`INSERT INTO camery_versioning.object_revisions(tenant_id,project_id,object_id,version,parent_version,snapshot_revision,change_id,record)
      VALUES (${key.tenantId},${key.projectId},${revision.object_id},${revision.version},${revision.parent_version},${revision.snapshot_revision},${revision.change_set_id},${json(revision)})`);
    for (const adoption of adoptions) await tx.execute(sql`INSERT INTO camery_versioning.adoptions(tenant_id,project_id,change_id,from_revision,to_revision,record)
      VALUES (${key.tenantId},${key.projectId},${adoption.change_set_id},${adoption.from_revision},${adoption.to_revision},${json(adoption)})`);
  }
  private async change(key: VersionProjectKey, operation: string, evaluate: (state: VersionState) => ChangeResult): Promise<PersistedChangeResult> {
    return this.operation(key, operation, () => this.db.transaction(async tx => {
      const selected = await tx.execute<ProjectRow>(sql`SELECT * FROM camery_versioning.projects WHERE ${where(key)} FOR UPDATE`);
      const row = selected.rows[0];
      if (!row) throw new VersionPersistenceError('PROJECT_NOT_FOUND', operation, key.projectId);
      const before = await this.load(tx, key, row); const result = evaluate(before.state);
      if (jsonSignature(result.state) === jsonSignature(before.state)) return { ...result, writeVersion: before.writeVersion };
      const writeVersion = nextVersion(before.writeVersion);
      const oldChanges = new Map(before.state.changes.map(c => [c.request.id, c]));
      for (const change of result.state.changes) {
        const previous = oldChanges.get(change.request.id);
        if (previous && jsonSignature(previous) === jsonSignature(change)) continue;
        const saved = await tx.execute(sql`INSERT INTO camery_versioning.changes(tenant_id,project_id,change_id,status,record)
          VALUES (${key.tenantId},${key.projectId},${change.request.id},${change.status},${json(change)}) ON CONFLICT (tenant_id,project_id,change_id)
          DO UPDATE SET status=excluded.status,record=excluded.record WHERE camery_versioning.changes.record->'request'=excluded.record->'request' RETURNING change_id`);
        if (!saved.rows.length) throw new VersionPersistenceError('PERSISTENCE_CONFLICT', operation, key.projectId);
      }
      if (result.state.head.revision.number !== before.state.head.revision.number) await this.snapshot(tx, key, result.state);
      await this.history(tx, key, result.state.revisions.slice(before.state.revisions.length), result.state.adoptions.slice(before.state.adoptions.length));
      const updated = await tx.execute(sql`UPDATE camery_versioning.projects SET head_revision=${result.state.head.revision.number},write_version=${writeVersion}
        WHERE ${where(key)} AND write_version=${before.writeVersion} AND head_revision=${before.state.head.revision.number} RETURNING write_version`);
      if (!updated.rows.length) throw new VersionPersistenceError('PERSISTENCE_CONFLICT', operation, key.projectId);
      return { ...result, writeVersion };
    }));
  }
  async submit(input: VersionProjectKey, request: unknown, options: SubmitOptions = {}): Promise<PersistedChangeResult> {
    const key = projectKey(input); const detached: unknown = JSON.parse(jsonSignature(request)); const newId = options.newId;
    return this.change(key, 'submit', state => submitChangeSet(state, detached, newId ? { newId } : {}));
  }
  async adopt(input: VersionProjectKey, changeId: string, options: PersistedAdoptOptions): Promise<PersistedChangeResult> {
    const key = projectKey(input); const bound = authority(key, options);
    if (!StableId.safeParse(changeId).success) throw new VersionPersistenceError('INVALID_CHANGE_ID', 'adopt', key.projectId);
    return this.change(key, 'adopt', state => adoptChangeSet(state, changeId, bound));
  }
  async reject(input: VersionProjectKey, changeId: string, options: PersistedAdoptOptions, reason: string): Promise<PersistedChangeResult> {
    const key = projectKey(input); const bound = authority(key, options);
    if (!StableId.safeParse(changeId).success || typeof reason !== 'string') throw new VersionPersistenceError('INVALID_CHANGE_ID', 'reject', key.projectId);
    return this.change(key, 'reject', state => rejectChangeSet(state, changeId, bound, reason));
  }
}

import type { AdoptOptions, AdoptionScope, ChangeResult, Principal, SubmitOptions, VersionState } from '../types';
import type { PoolClient } from 'pg';

export interface VersionProjectKey { tenantId: string; projectId: string }
export interface StoredVersionState { state: VersionState; writeVersion: number }
export interface PersistedChangeResult extends ChangeResult { writeVersion: number }
export interface VersionWriteExpectation { expectedSnapshotRevision: number; expectedWriteVersion: number }
export interface PersistedSubmitOptions extends SubmitOptions { expectation?: VersionWriteExpectation }
/** The trusted host must bind grants to this tenant/project, never to JSON claims of identity. */
export interface PersistedAdoptOptions extends Omit<AdoptOptions, 'authorize'> {
  authorize: (actor: Principal, project: Readonly<VersionProjectKey>, scope: AdoptionScope) => boolean;
  expectation?: VersionWriteExpectation;
}
/** Host-only validation inside the owned transaction: acquire/read, never commit/release or open a second transaction. Safe ADOPTION_SOURCE_* refusals permit one historical-adoption lookup after rollback, never a fresh adoption retry. */
export type VersionAdoptionGuard = (client: PoolClient) => Promise<void>;
export class VersionPersistenceError extends Error {
  override readonly name = 'VersionPersistenceError';
  constructor(readonly code: string, readonly operation: string, readonly projectId: string, readonly databaseCode?: string) {
    super(`${code}: ${operation} project ${projectId}${databaseCode ? ` (SQLSTATE ${databaseCode})` : ''}`);
  }
}

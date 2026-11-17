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
type VersionTransactionEnvelope = Readonly<{ project: Readonly<VersionProjectKey>; expectation?: Readonly<VersionWriteExpectation> }>;
export type VersionTransactionContext = VersionTransactionEnvelope & (
  | Readonly<{ operation: 'submit'; requestSignature: string }>
  | Readonly<{ operation: 'adopt'; changeId: string; actor: Readonly<Principal>; scope: Readonly<AdoptionScope>; at: string; replayed: boolean }>
  | Readonly<{ operation: 'reject'; changeId: string; actor: Readonly<Principal>; scope: Readonly<AdoptionScope>; at: string; reason: string }>
);
/** Trusted host receipt persistence on the same owned transaction, after formal writes and before COMMIT. Context is built from captured execution authority, never caller-supplied JSON. */
export type VersionTransactionReceipt = (client: PoolClient, result: Readonly<PersistedChangeResult>, context: VersionTransactionContext) => Promise<void>;
export class VersionPersistenceError extends Error {
  override readonly name = 'VersionPersistenceError';
  constructor(readonly code: string, readonly operation: string, readonly projectId: string, readonly databaseCode?: string) {
    super(`${code}: ${operation} project ${projectId}${databaseCode ? ` (SQLSTATE ${databaseCode})` : ''}`);
  }
}

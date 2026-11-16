import type { AdoptOptions, AdoptionScope, ChangeResult, Principal, VersionState } from '../types';

export interface VersionProjectKey { tenantId: string; projectId: string }
export interface StoredVersionState { state: VersionState; writeVersion: number }
export interface PersistedChangeResult extends ChangeResult { writeVersion: number }
/** The trusted host must bind grants to this tenant/project, never to JSON claims of identity. */
export interface PersistedAdoptOptions extends Omit<AdoptOptions, 'authorize'> {
  authorize: (actor: Principal, project: Readonly<VersionProjectKey>, scope: AdoptionScope) => boolean;
}
export class VersionPersistenceError extends Error {
  override readonly name = 'VersionPersistenceError';
  constructor(readonly code: string, readonly operation: string, readonly projectId: string, readonly databaseCode?: string) {
    super(`${code}: ${operation} project ${projectId}${databaseCode ? ` (SQLSTATE ${databaseCode})` : ''}`);
  }
}

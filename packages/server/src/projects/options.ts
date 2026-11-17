import type {PostgresProjectIdentityStore} from './identity-map.js';
import type {PostgresProjectIntents} from './intent-store.js';
import type {PostgresVersionStore} from '@camery/versioning/node';
import type {PostgresDevelopmentStore,PostgresDevelopmentIrIdentities} from '@camery/script/node';
import type {ProjectReadStore} from './read-store.js';

/** Trusted host wiring. No store, tenant, callback, credential or whole snapshot comes from an HTTP body. */
export interface ProjectApplicationOptions{
  readonly tenantId:string;
  readonly identities:Pick<PostgresProjectIdentityStore,'resolveProject'|'resolvePrincipal'|'resolve'>;
  readonly versions:Pick<PostgresVersionStore,'read'|'submitWithReceipt'|'adoptGuarded'|'rejectWithReceipt'>;
  readonly reads:ProjectReadStore;
  readonly intents:Pick<PostgresProjectIntents,'listCandidateHeaders'|'findCandidate'|'candidateForChange'|'findDecision'|'putCandidate'|'putDecision'|'readPreparationReceipt'|'readDecisionReceipt'|'preparationReceiptWriter'|'decisionReceiptWriter'>;
  readonly development:{readonly store:Pick<PostgresDevelopmentStore,'read'|'isCurrent'|'readForAdoption'>;readonly identities:Pick<PostgresDevelopmentIrIdentities,'prepare'>};
  readonly newId:()=>string;readonly now?:()=>string;
}

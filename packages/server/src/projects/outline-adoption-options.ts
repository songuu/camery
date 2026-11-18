import type {PostgresProjectIdentityStore} from './identity-map.js';
import type {PostgresVersionStore} from '@camery/versioning/node';
import type {PostgresOutlineStore,PostgresOutlineIrIdentities} from '@camery/script/outline/node';
import type {PostgresOutlineProjectIntents} from './outline-intent-store.js';
import type {PostgresOutlineCandidateCatalog} from './outline-adoption-catalog.js';

/** Host-owned composition. Public commands supply neither stores nor identity/source/authority callbacks. */
export interface OutlineAdoptionOptions{
  readonly tenantId:string;
  readonly identities:Pick<PostgresProjectIdentityStore,'resolveProject'|'resolvePrincipal'|'resolve'>;
  readonly versions:Pick<PostgresVersionStore,'read'|'submitWithReceipt'|'adoptGuarded'|'rejectWithReceipt'>;
  readonly intents:Pick<PostgresOutlineProjectIntents,'findCandidate'|'candidateForChange'|'findDecision'|'putCandidate'|'putDecision'|'readPreparationReceipt'|'readDecisionReceipt'|'preparationReceiptWriter'|'decisionReceiptWriter'>;
  readonly catalog:Pick<PostgresOutlineCandidateCatalog,'list'>;
  readonly outline:{readonly store:Pick<PostgresOutlineStore,'read'|'isCurrent'|'readForAdoption'>;readonly identities:Pick<PostgresOutlineIrIdentities,'prepare'>};
  readonly newId:()=>string;
  readonly now?:()=>string;
}

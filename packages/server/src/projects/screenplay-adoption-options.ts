import type {PostgresVersionStore} from '@camery/versioning/node';
import type {PostgresScreenplayStore} from '@camery/script/screenplay/node';
import type {PostgresProjectIdentityStore} from './identity-map.js';
import type {PostgresScreenplayProjectIntents} from './screenplay-intent-store.js';
import type {PostgresScreenplayAdoptionSource} from './screenplay-adoption-source.js';

/** Trusted host ports; none can be supplied by a candidate command or an HTTP body. */
export interface ScreenplayAdoptionOptions{
  readonly tenantId:string;
  readonly identities:Pick<PostgresProjectIdentityStore,'resolve'|'resolveProject'|'resolvePrincipal'>;
  readonly versions:Pick<PostgresVersionStore,'read'|'submitWithReceipt'|'adoptGuarded'|'rejectWithReceipt'>;
  readonly intents:Pick<PostgresScreenplayProjectIntents,'findCandidate'|'candidateForChange'|'putCandidate'|'findDecision'|'putDecision'|'readPreparationReceipt'|'readDecisionReceipt'|'preparationReceiptWriter'|'decisionReceiptWriter'>;
  readonly source:Pick<PostgresScreenplayAdoptionSource,'readReviewed'|'materialize'|'nativeCandidate'|'sourceBinding'|'handoff'|'adoptionProof'>;
  readonly scripts:Pick<PostgresScreenplayStore,'readHistorical'|'readForAdoption'>;
  readonly newId:()=>string;
  readonly now?:()=>string;
}

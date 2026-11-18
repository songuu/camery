import type {PostgresProjectIdentityStore} from './identity-map.js';
import type {PostgresOutlineFormalReadStore} from './outline-formal-store.js';
/** Only the trusted host supplies a tenant, registry and snapshot reader. */
export interface OutlineFormalReadOptions{readonly tenantId:string;readonly identities:Pick<PostgresProjectIdentityStore,'resolveProject'>;readonly store:Pick<PostgresOutlineFormalReadStore,'snapshot'>}

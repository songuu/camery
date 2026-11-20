import {Pool} from 'pg';
import {PostgresVersionStore} from '@camery/versioning/node';
import {PostgresOutlineStore} from '@camery/script/outline/node';
import {PostgresScreenplayStore} from '@camery/script/screenplay/node';
import {snapshotEnvironment} from '../secret-config.js';
import {loadServerConfig} from '../config.js';
import {assertOutlineAdoptionAuthority} from './outline-adoption-config.js';
import type {ScreenplayAdoptionOptions} from './screenplay-adoption-options.js';
import {PostgresProjectIdentityStore} from './identity-map.js';
import {verifyScreenplayProjectAdoptionRole,verifyScreenplayProjectIdentityReaderRole} from './screenplay-adoption-role.js';
import {PostgresScreenplayProjectIntents} from './screenplay-intent-store.js';
import {PostgresScreenplayAdoptionSource} from './screenplay-adoption-source.js';
import {newProjectObjectId} from './ids.js';

export interface ScreenplayAdoptionDeployment{readonly tenantId:string;readonly readerDatabaseUrl:string;readonly adoptionDatabaseUrl:string}

/** Internal composition only. Both independent LOGINs must already have exactly their installed capabilities. */
export async function createScreenplayAdoptionRuntime(config:ScreenplayAdoptionDeployment):Promise<{readonly adoptionOptions:ScreenplayAdoptionOptions;close():Promise<void>}>{
  const pools:Pool[]=[];let closing:Promise<void>|undefined;
  const close=():Promise<void>=>closing??=Promise.allSettled(pools.map(async pool=>{await pool.end();})).then(results=>{if(results.some(result=>result.status==='rejected'))throw new Error('Screenplay adoption runtime shutdown failed');});
  try{
    const captured=snapshotEnvironment(config as unknown as Record<string,string|undefined>,['tenantId','readerDatabaseUrl','adoptionDatabaseUrl']),tenantId=captured['tenantId'];
    const readerUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:captured['readerDatabaseUrl']}).databaseUrl,adopterUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:captured['adoptionDatabaseUrl']}).databaseUrl;
    // Reuse the existing strict PostgreSQL authority parser, including its query-option allowlist.
    assertOutlineAdoptionAuthority(readerUrl,adopterUrl);
    const poolFor=(connectionString:string)=>{const pool=new Pool({connectionString,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:15000,statement_timeout:15000});pools.push(pool);pool.on('error',()=>console.error('Screenplay adoption database connection unavailable'));return pool;};
    const reader=poolFor(readerUrl),adopter=poolFor(adopterUrl);await verifyScreenplayProjectIdentityReaderRole(reader);await verifyScreenplayProjectAdoptionRole(adopter);
    const identities=new PostgresProjectIdentityStore(reader),outline=new PostgresOutlineStore(adopter),scripts=new PostgresScreenplayStore(adopter,outline);
    const adoptionOptions:ScreenplayAdoptionOptions=Object.freeze({tenantId:tenantId!,identities,versions:new PostgresVersionStore(adopter),intents:new PostgresScreenplayProjectIntents(adopter),source:new PostgresScreenplayAdoptionSource({pool:adopter,scripts,outline}),scripts,newId:newProjectObjectId});
    return Object.freeze({adoptionOptions,close});
  }catch{await close().catch(()=>{});throw new Error('Screenplay adoption runtime startup failed');}
}

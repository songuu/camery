import {Pool} from 'pg';
import {PostgresVersionStore} from '@camery/versioning/node';
import {PostgresOutlineStore,PostgresOutlineIrIdentities} from '@camery/script/outline/node';
import {snapshotEnvironment} from '../secret-config.js';
import {loadServerConfig} from '../config.js';
import type {OutlineAdoptionDeployment} from './outline-adoption-config.js';
import {assertOutlineAdoptionAuthority} from './outline-adoption-config.js';
import type {OutlineAdoptionOptions} from './outline-adoption-options.js';
import type {OutlineFormalReadOptions} from './outline-formal-options.js';
import {PostgresProjectIdentityStore} from './identity-map.js';
import {verifyProjectIdentityReaderRole} from './identity-role.js';
import {verifyOutlineProjectAdoptionRole} from './outline-adoption-role.js';
import {PostgresOutlineProjectIntents} from './outline-intent-store.js';
import {PostgresOutlineCandidateCatalog} from './outline-adoption-catalog.js';
import {PostgresOutlineFormalReadStore} from './outline-formal-store.js';
import {newProjectObjectId} from './ids.js';

/** The independently provisioned host verifies credentials and composes stores; installation remains an explicit operation. */
export async function createOutlineAdoptionRuntime(config:OutlineAdoptionDeployment):Promise<{readonly adoptionOptions:OutlineAdoptionOptions;readonly formalOptions:OutlineFormalReadOptions;close():Promise<void>}>{
  const pools:Pool[]=[];let closing:Promise<void>|undefined;
  const close=():Promise<void>=>closing??=Promise.allSettled(pools.map(async pool=>{await pool.end();})).then(results=>{if(results.some(result=>result.status==='rejected'))throw new Error('Outline adoption runtime shutdown failed');});
  try{
    const captured=snapshotEnvironment(config as unknown as Record<string,string|undefined>,['tenantId','readerDatabaseUrl','adoptionDatabaseUrl']),tenantId=captured['tenantId'];
    const readerUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:captured['readerDatabaseUrl']}).databaseUrl,adopterUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:captured['adoptionDatabaseUrl']}).databaseUrl;assertOutlineAdoptionAuthority(readerUrl,adopterUrl);
    const poolFor=(connectionString:string)=>{const pool=new Pool({connectionString,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:15000,statement_timeout:15000});pools.push(pool);pool.on('error',()=>console.error('Outline adoption database connection unavailable'));return pool;};
    const reader=poolFor(readerUrl),adopter=poolFor(adopterUrl);await verifyProjectIdentityReaderRole(reader);await verifyOutlineProjectAdoptionRole(adopter);
    const identities=new PostgresProjectIdentityStore(reader),source=new PostgresOutlineStore(adopter);
    const adoptionOptions:OutlineAdoptionOptions=Object.freeze({tenantId:tenantId!,identities,versions:new PostgresVersionStore(adopter),intents:new PostgresOutlineProjectIntents(adopter),catalog:new PostgresOutlineCandidateCatalog(adopter),outline:Object.freeze({store:source,identities:new PostgresOutlineIrIdentities(adopter,source,newProjectObjectId)}),newId:newProjectObjectId});
    const formalOptions:OutlineFormalReadOptions=Object.freeze({tenantId:tenantId!,identities,store:new PostgresOutlineFormalReadStore(adopter)});
    return Object.freeze({adoptionOptions,formalOptions,close});
  }catch{await close().catch(()=>{});throw new Error('Outline adoption runtime startup failed');}
}

import {Pool} from 'pg';
import {PostgresVersionStore} from '@camery/versioning/node';
import {PostgresDevelopmentStore,PostgresDevelopmentIrIdentities} from '@camery/script/node';
import {snapshotEnvironment} from '../secret-config.js';
import {loadServerConfig} from '../config.js';
import type {ProjectDeploymentConfig} from './config.js';
import type {ProjectApplicationOptions} from './options.js';
import {PostgresProjectIdentityStore} from './identity-map.js';
import {PostgresProjectIntents} from './intent-store.js';
import {verifyProjectIdentityReaderRole} from './identity-role.js';
import {verifyProjectAdoptionRole} from './adoption-role.js';
import {newProjectObjectId} from './ids.js';

/** Runtime never provisions roles, migrations, projects, task workers or model sessions. */
export async function createProjectRuntime(config:ProjectDeploymentConfig):Promise<{readonly options:ProjectApplicationOptions;close():Promise<void>}>{
  const pools:Pool[]=[];let closing:Promise<void>|undefined;
  const close=():Promise<void>=>closing??=Promise.allSettled(pools.map(async pool=>{await pool.end();})).then(results=>{if(results.some(result=>result.status==='rejected'))throw new Error('Project runtime shutdown failed');});
  try{
    // Capture only own data before any role check can yield to a mutable host configuration.
    const captured=snapshotEnvironment(config as unknown as Record<string,string|undefined>,['tenantId','readerDatabaseUrl','adoptionDatabaseUrl']);
    const tenantId=captured['tenantId'];const readerUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:captured['readerDatabaseUrl']}).databaseUrl;const adopterUrl=loadServerConfig({CAMERY_TENANT_ID:tenantId,CAMERY_DATABASE_URL:captured['adoptionDatabaseUrl']}).databaseUrl;
    const poolFor=(connectionString:string):Pool=>{const pool=new Pool({connectionString,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,query_timeout:15000,statement_timeout:15000});pools.push(pool);pool.on('error',()=>{console.error('Project database connection unavailable');});return pool;};
    const reader=poolFor(readerUrl);const adopter=poolFor(adopterUrl);
    await verifyProjectIdentityReaderRole(reader);await verifyProjectAdoptionRole(adopter);
    const source=new PostgresDevelopmentStore(adopter);
    const options:ProjectApplicationOptions=Object.freeze({tenantId:tenantId!,identities:new PostgresProjectIdentityStore(reader),versions:new PostgresVersionStore(adopter),intents:new PostgresProjectIntents(adopter),development:Object.freeze({store:source,identities:new PostgresDevelopmentIrIdentities(adopter,source,newProjectObjectId)}),newId:newProjectObjectId});
    return Object.freeze({options,close});
  }catch{await close().catch(()=>{});throw new Error('Project runtime startup failed');}
}

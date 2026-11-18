import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {AccessService,issueSession} from '@camery/access';
import {PostgresVersionStore} from '@camery/versioning/node';
import {PostgresOutlineIrIdentities,PostgresOutlineStore} from '@camery/script/outline/node';
import type {OutlineAdoptionSource} from '@camery/script/outline/node';
import {PostgresProjectIdentityStore} from '../src/projects/identity-map.js';
import {PostgresOutlineProjectIntents} from '../src/projects/outline-intent-store.js';
import {OutlineAdoptionApplication} from '../src/projects/outline-adoption-application.js';
import {PostgresOutlineCandidateCatalog} from '../src/projects/outline-adoption-catalog.js';
import {grantOutlineProjectAdoptionRole,verifyOutlineProjectAdoptionRole} from '../src/projects/outline-adoption-role.js';
import type {OutlineAdoptionOptions} from '../src/projects/outline-adoption-options.js';
import {allocateOutlineIntentId,outlineIntentPgFixture} from './outline-intent-pg-support.js';

/** Source text is synthetic; sessions, source review and all application/version writes use real PG stores. */
export async function outlineAdoptionPgFixture(pool:Pool,owned:string[],capacity=false){
  const f=await outlineIntentPgFixture(pool,owned,{capacity}),access=new AccessService({tenantId:f.scope.tenantId,store:f.sessions});
  await f.sessions.provisionMember({...f.scope,userId:'viewer',role:'viewer'});
  const headers={editor:{authorization:''},reviewer:{authorization:''},viewer:{authorization:''}};
  for(const role of ['editor','reviewer','viewer'] as const)headers[role].authorization='Bearer '+(await issueSession({tenantId:f.scope.tenantId,userId:role,ttlSeconds:3600},f.sessions)).token;
  let generated=0;
  const newId=()=>{generated++;return allocateOutlineIntentId();};
  function optionsFor(database:Pool=pool):OutlineAdoptionOptions{
    const source=new PostgresOutlineStore(database);
    return {tenantId:f.scope.tenantId,identities:new PostgresProjectIdentityStore(database),versions:new PostgresVersionStore(database),intents:new PostgresOutlineProjectIntents(database),catalog:new PostgresOutlineCandidateCatalog(database),outline:{store:source,identities:new PostgresOutlineIrIdentities(database,source,newId)},newId,now:()=>new Date().toISOString()};
  }
  const application=(database:Pool=pool)=>new OutlineAdoptionApplication(optionsFor(database));
  function command(applicationId='app-preparation',source:OutlineAdoptionSource=f.source,expectedSnapshotRevision=1,expectedWriteVersion=1){
    return {applicationId,runDigest:source.runDigest,briefDigest:source.briefDigest,candidateDigest:source.candidateDigest,reviewDigest:source.reviewDigest,sourceDigest:source.sourceDigest,expectedSnapshotRevision,expectedWriteVersion};
  }
  const subject=(role:keyof typeof headers)=>access.authenticate(headers[role].authorization);
  async function persistenceCounts(){
    const counts:Record<string,number>={};
    for(const [schema,tables] of [['camery_script',['ir_identities']],['camery_outline',['identity_preparations']],['camery_projects',['outline_candidate_intents','outline_candidate_receipts','outline_decision_intents','outline_decision_receipts']]] as const)
      for(const table of tables)counts[schema+'.'+table]=Number((await pool.query<{n:string}>(`SELECT count(*)::text n FROM ${schema}.${table} WHERE tenant_id=$1`,[f.scope.tenantId])).rows[0]!.n);
    return counts;
  }
  return {...f,headers,subject,optionsFor,application,command,generated:()=>generated,persistenceCounts};
}

/** Only this helper's unpredictable role is provisioned and removed; no pre-existing role is altered. */
export async function withOutlineAdoptionRole<T>(admin:Pool,databaseUrl:string,action:(runtime:Pool,name:string)=>Promise<T>,installer=grantOutlineProjectAdoptionRole):Promise<T>{
  const name='outline_adopt_'+randomBytes(10).toString('hex'),password=randomBytes(24).toString('hex');let created=false;let runtime:Pool|undefined;
  try{
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);created=true;
    await installer(admin,name);const url=new URL(databaseUrl);url.username=name;url.password=password;
    runtime=new Pool({connectionString:url.toString(),max:4,connectionTimeoutMillis:5000});
    return await action(runtime,name);
  }finally{await runtime?.end();if(created){await admin.query(`DROP OWNED BY "${name}"`);await admin.query(`DROP ROLE "${name}"`);}}
}

export {verifyOutlineProjectAdoptionRole};

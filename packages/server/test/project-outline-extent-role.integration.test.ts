import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {migrateBible} from '@camery/bible/node';
import {migrateVersioning} from '@camery/versioning/node';
import {migrateDevelopment,PostgresDevelopmentIrIdentities,PostgresDevelopmentStore} from '@camery/script/node';
import {migrateOutline,migrateOutlineIdentities,PostgresOutlineIrIdentities} from '@camery/script/outline/node';
import {migrateIngest} from '../../ingest/src/node/index.js';
import {fixtureId as id} from '../../ir/test/fixtures.js';
import {outlineIdentityPgFixture} from '../../script/test/outline-ir-identities-pg-support.js';
import {createDevelopmentSourceFixture} from '../../script/test/outline-source-pg-support.js';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {grantProjectAdoptionRole,verifyProjectAdoptionRole} from '../src/projects/adoption-role.js';
const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for shared identity extent LOGIN tests');
const admin=new Pool({connectionString:databaseUrl,max:3,connectionTimeoutMillis:5000}),owned:string[]=[],role='project_extent_'+randomBytes(8).toString('hex');let runtime:Pool|undefined,created=false;
beforeAll(async()=>{await migrateIngest(admin);await migrateBible(admin);await migrateDevelopment(admin);await migrateOutline(admin);await migrateOutlineIdentities(admin);await migrateVersioning(admin);await migrateProjectIdentities(admin);
  const password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);created=true;
  await grantProjectAdoptionRole(admin,role);const url=new URL(databaseUrl!);url.username=role;url.password=password;runtime=new Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});await verifyProjectAdoptionRole(runtime);
});
afterAll(async()=>{let failed=false;try{await runtime?.end();for(const tenant of owned)for(const [schema,tables] of [['camery_outline',['identity_preparations']],['camery_script',['ir_identities']],['camery_outline',['reviews','candidates','runs','briefs']],['camery_script',['run_origins','reviews','candidates','runs','briefs']],['camery_bible',['reviews','candidates','chunks','runs']],['camery_ingest',['reading_checkpoints','documents']]] as const)for(const table of tables)try{await admin.query(`DELETE FROM ${schema}.${table} WHERE tenant_id=$1`,[tenant]);}catch{failed=true;}
    if(created){await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);}
  }finally{await admin.end();}if(failed)throw new Error('Identity extent LOGIN cleanup failed');
});
it('uses the existing adopter LOGIN to validate committed Outline extents and preserve the shared actual episode IDs',async()=>{
  const f=await outlineIdentityPgFixture(admin,owned,{kind:'bible'}),first=await new PostgresOutlineIrIdentities(admin,f.store,()=>id(randomUUID())).prepare({source:f.source,target:f.target});
  const development=await createDevelopmentSourceFixture(admin,f.scope),{kind:_kind,...source}=development.descriptor;
  const prepared=await new PostgresDevelopmentIrIdentities(runtime!,new PostgresDevelopmentStore(runtime!),()=>id(randomUUID())).prepare({source,target:f.target});
  expect(prepared.identities.episodes.map(row=>row.episodeId)).toEqual(first.identities.episodes.map(row=>row.episodeId));await verifyProjectAdoptionRole(runtime!);
  for(const table of ['runs','reviews','candidates'])await expect(runtime!.query(`SELECT record FROM camery_outline.${table} WHERE tenant_id=$1`,[f.scope.tenantId])).rejects.toMatchObject({code:'42501'});
  await expect(runtime!.query('UPDATE camery_outline.identity_preparations SET episode_count=episode_count WHERE tenant_id=$1',[f.scope.tenantId])).rejects.toMatchObject({code:'42501'});
});
it.each([['runs','record'],['reviews','record'],['candidates','record'],['runs','created_at']] as const)('rejects extra %s.%s column authority',async(table,column)=>{
  await admin.query(`GRANT SELECT(${column}) ON camery_outline.${table} TO ${role}`);
  try{await expect(verifyProjectAdoptionRole(runtime!)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await admin.query(`REVOKE SELECT(${column}) ON camery_outline.${table} FROM ${role}`);}await verifyProjectAdoptionRole(runtime!);
});
it('requires the actual minimal extent column grants and rejects grant options on them',async()=>{
  await admin.query(`REVOKE SELECT(brief_digest) ON camery_outline.runs FROM ${role}`);
  try{await expect(verifyProjectAdoptionRole(runtime!)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await admin.query(`GRANT SELECT(brief_digest) ON camery_outline.runs TO ${role}`);}await verifyProjectAdoptionRole(runtime!);
  await admin.query(`GRANT SELECT(brief_id) ON camery_outline.runs TO ${role} WITH GRANT OPTION`);
  try{await expect(verifyProjectAdoptionRole(runtime!)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await admin.query(`REVOKE GRANT OPTION FOR SELECT(brief_id) ON camery_outline.runs FROM ${role}`);}await verifyProjectAdoptionRole(runtime!);
});
it('keeps the original adopter operational with a base Outline schema but no identity extension or Outline USAGE',async()=>{
  const suffix=randomBytes(8).toString('hex'),database='camery_legacy_adopter_'+suffix,legacyRole='project_legacy_extent_'+suffix;
  if(!/^camery_legacy_adopter_[a-f0-9]{16}$/.test(database))throw new Error('Unowned legacy test database');
  await admin.query(`CREATE DATABASE "${database}"`);const address=new URL(databaseUrl!);address.pathname='/'+database;
  const installer=new Pool({connectionString:address.toString(),max:2,connectionTimeoutMillis:5000});let reader:Pool|undefined,createdRole=false;
  try{
    await migrateIngest(installer);await migrateBible(installer);await migrateDevelopment(installer);await migrateOutline(installer);await migrateVersioning(installer);await migrateProjectIdentities(installer);
    const password=randomBytes(24).toString('hex');await installer.query(`CREATE ROLE ${legacyRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION`);createdRole=true;await grantProjectAdoptionRole(installer,legacyRole);
    const login=new URL(address);login.username=legacyRole;login.password=password;reader=new Pool({connectionString:login.toString(),max:2,connectionTimeoutMillis:5000});
    expect((await reader.query("SELECT has_schema_privilege('camery_outline','USAGE') AS allowed")).rows).toEqual([{allowed:false}]);
    // Name resolution required schema USAGE even for an absent optional table; catalog discovery preserves legacy operation.
    await expect(reader.query("SELECT to_regclass('camery_outline.identity_preparations')")).rejects.toMatchObject({code:'42501'});await verifyProjectAdoptionRole(reader);
    const f=await createDevelopmentSourceFixture(installer,{tenantId:'legacy-extent',projectId:'project'}),{kind:_kind,...source}=f.descriptor;
    const target={tenantId:id('legacy-extent-tenant'),projectId:id('legacy-extent-project')};
    const prepared=await new PostgresDevelopmentIrIdentities(reader,new PostgresDevelopmentStore(reader),()=>id(randomUUID())).prepare({source,target});expect(prepared.identities.episodes).toHaveLength(3);await verifyProjectAdoptionRole(reader);
    expect((await installer.query("SELECT to_regclass('camery_outline.identity_preparations') AS relation")).rows).toEqual([{relation:null}]);
  }finally{await reader?.end();try{if(createdRole){await installer.query(`DROP OWNED BY ${legacyRole}`);await installer.query(`DROP ROLE ${legacyRole}`);}}finally{await installer.end();await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);}}
});

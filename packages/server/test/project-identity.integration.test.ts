import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {PostgresVersionStore,migrateVersioning} from '@camery/versioning/node';
import {makePackage,fixtureId as id} from '../../ir/test/fixtures';
import {ProjectIdentityRegistrar,PostgresProjectIdentityStore} from '../src/projects/identity-map.js';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {grantProjectIdentityReaderRole,verifyProjectIdentityReaderRole} from '../src/projects/identity-role.js';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for shared project identity tests');
const pool=new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5000});
const tenants:{ordinary:string;ir:string}[]=[];
beforeAll(async()=>{await migrateVersioning(pool);await migrateProjectIdentities(pool);});
afterAll(async()=>{
  let failed=false;
  for(const tenant of tenants){
    try{
      const client=await pool.connect();
      try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');
        for(const table of ['principals','projects','tenants'])await client.query(`DELETE FROM camery_projects.${table} WHERE tenant_id=$1`,[tenant.ordinary]);
        for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1`,[tenant.ir]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    }catch{failed=true;}
  }
  await pool.end();if(failed)throw new Error('Shared project identity fixture cleanup failed');
});
async function fixture(){
  const suffix=randomUUID();const tenantId='identity-'+suffix;const irTenantId=id('tenant-'+suffix);tenants.push({ordinary:tenantId,ir:irTenantId});
  const projectId='project';const irProjectId=id('prj_demo');const irActorId=id('actor-'+suffix);const registrar=new ProjectIdentityRegistrar(pool);const store=new PostgresProjectIdentityStore(pool);const versions=new PostgresVersionStore(pool);
  await registrar.registerTenant({tenantId,irTenantId});await versions.initialize({tenantId:irTenantId,projectId:irProjectId},makePackage());
  return {tenantId,projectId,irTenantId,irProjectId,irActorId,registrar,store,versions};
}
it('persists the exact shared identity across fresh pools, separates same slugs by tenant, and keeps agents distinct',async()=>{
  const a=await fixture();const b=await fixture();
  for(const f of [a,b]){
    await f.registrar.registerProject({tenantId:f.tenantId,projectId:f.projectId,irProjectId:f.irProjectId});
    for(const kind of ['user','agent_run','system'] as const)await f.registrar.registerPrincipal({tenantId:f.tenantId,kind,key:'same-key',irActorId:id(f.tenantId+'-'+kind)});
  }
  const reopened=new Pool({connectionString:databaseUrl,max:1});
  try{
    const store=new PostgresProjectIdentityStore(reopened);
    for(const f of [a,b])for(const kind of ['user','agent_run','system'] as const){
      const identity=await store.resolve({tenantId:f.tenantId,projectId:'project',kind,key:'same-key'});
      expect(identity).toEqual({scope:{tenantId:f.tenantId,projectId:'project'},versionKey:{tenantId:f.irTenantId,projectId:f.irProjectId},principal:{kind,id:id(f.tenantId+'-'+kind)}});
    }
    await expect(store.resolveProject({tenantId:a.tenantId,projectId:'missing'})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
    await expect(store.resolvePrincipal({tenantId:a.tenantId,kind:'user',key:'missing'})).rejects.toMatchObject({code:'PRINCIPAL_BINDING_MISSING'});
  }finally{await reopened.end();}
});
it('serializes concurrent equal registration and rejects rebinding, aliases and cross-tenant principal reuse',async()=>{
  const f=await fixture();const command={tenantId:f.tenantId,projectId:f.projectId,irProjectId:f.irProjectId};
  const projects=await Promise.all(Array.from({length:8},()=>f.registrar.registerProject(command)));expect(projects.every(row=>JSON.stringify(row)===JSON.stringify(projects[0]))).toBe(true);
  const principal={tenantId:f.tenantId,kind:'user' as const,key:'editor',irActorId:f.irActorId};const actors=await Promise.all(Array.from({length:8},()=>f.registrar.registerPrincipal(principal)));expect(actors.every(row=>row.principal.id===f.irActorId)).toBe(true);
  await expect(f.registrar.registerTenant({tenantId:f.tenantId,irTenantId:id('replacement-'+f.tenantId)})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  await expect(f.registrar.registerProject({...command,irProjectId:id('replacement-project')})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  await expect(f.registrar.registerProject({...command,projectId:'alias'})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  await expect(f.registrar.registerPrincipal({...principal,irActorId:id('replacement-actor')})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  await expect(f.registrar.registerPrincipal({...principal,kind:'agent_run'})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  const other=await fixture();await expect(other.registrar.registerPrincipal({...principal,tenantId:other.tenantId})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  expect((await pool.query<{count:string}>('SELECT count(*)::text count FROM camery_projects.projects WHERE tenant_id=$1',[f.tenantId])).rows[0]?.count).toBe('1');
});
it('requires an installed actual version project and cannot invent a formal head during registration or resolution',async()=>{
  const suffix=randomUUID();const tenantId='identity-empty-'+suffix;const irTenantId=id(suffix);tenants.push({ordinary:tenantId,ir:irTenantId});const registrar=new ProjectIdentityRegistrar(pool);const store=new PostgresProjectIdentityStore(pool);
  await expect(store.resolveProject({tenantId,projectId:'project'})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
  await expect(registrar.registerProject({tenantId,projectId:'project',irProjectId:id('prj_demo')})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
  await registrar.registerTenant({tenantId,irTenantId});await expect(registrar.registerProject({tenantId,projectId:'project',irProjectId:id('prj_demo')})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
  expect((await pool.query<{count:string}>('SELECT count(*)::text count FROM camery_versioning.projects WHERE tenant_id=$1',[irTenantId])).rows[0]?.count).toBe('0');
  expect((await pool.query<{count:string}>('SELECT count(*)::text count FROM camery_projects.projects WHERE tenant_id=$1',[tenantId])).rows[0]?.count).toBe('0');
});
it('enforces scope, canonical identities, principal kinds and actual project references in SQL',async()=>{
  const f=await fixture();const other=await fixture();
  const statements:[string,unknown[],string][]=[
    ['INSERT INTO camery_projects.tenants(tenant_id,ir_tenant_id) VALUES($1,$2)',[f.tenantId+'\n',id(randomUUID())],'23514'],
    ['INSERT INTO camery_projects.tenants(tenant_id,ir_tenant_id) VALUES($1,$2)',[f.tenantId+'-bad',f.irTenantId+'\n'],'23514'],
    ['INSERT INTO camery_projects.projects(tenant_id,project_id,ir_tenant_id,ir_project_id) VALUES($1,$2,$3,$4)',[f.tenantId,'cross',other.irTenantId,f.irProjectId],'23503'],
    ['INSERT INTO camery_projects.principals(tenant_id,principal_kind,principal_key,ir_tenant_id,ir_actor_id) VALUES($1,$2,$3,$4,$5)',[f.tenantId,'human','editor',f.irTenantId,f.irActorId],'23514'],
    ['INSERT INTO camery_projects.principals(tenant_id,principal_kind,principal_key,ir_tenant_id,ir_actor_id) VALUES($1,$2,$3,$4,$5)',[f.tenantId,'user','editor',other.irTenantId,f.irActorId],'23503'],
  ];
  for(const [sql,values,code] of statements)await expect(pool.query(sql,values)).rejects.toMatchObject({code});
});
it('recovers a committed registration after a simulated lost ACK using the original immutable mapping',async()=>{
  const f=await fixture();const client=await pool.connect();let lost=false;
  const wrapper=new Proxy(client,{get(target,property){if(property==='query')return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql==='COMMIT'&&!lost){lost=true;throw new Error('simulated ACK lost');}return result;};if(property==='release')return ()=>{};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;}});
  const registrar=new ProjectIdentityRegistrar({connect:async()=>wrapper} as unknown as Pool);const input={tenantId:f.tenantId,projectId:f.projectId,irProjectId:f.irProjectId};
  try{await expect(registrar.registerProject(input)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(lost).toBe(true);expect(await new ProjectIdentityRegistrar(pool).registerProject(input)).toEqual({tenantId:f.tenantId,projectId:f.projectId,versionKey:{tenantId:f.irTenantId,projectId:f.irProjectId}});}
  finally{client.release();}
});
it('handles an actual checked-out backend termination without persisting a partial binding or leaking a pool client',async()=>{
  const f=await fixture();const client=await pool.connect();const pid=(await client.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;let killed=false;let released=false;let destroyed=false;let ownedListener:((...args:unknown[])=>void)|undefined;
  const wrapper=new Proxy(client,{get(target,property){
    if(property==='on')return (event:Parameters<typeof client.on>[0],listener:(...args:unknown[])=>void)=>{if(event==='error')ownedListener=listener;return target.on(event,listener);};
    if(property==='query')return async(sql:string,values?:unknown[])=>{const result=await target.query(sql,values);if(sql.startsWith('SELECT pg_advisory_xact_lock')&&!killed){const termination=await pool.query<{terminated:boolean}>('SELECT pg_terminate_backend($1) terminated',[pid]);expect(termination.rows[0]?.terminated).toBe(true);killed=true;await new Promise<void>(resolve=>{setImmediate(resolve);});}return result;};
    if(property==='release')return (destroy?:boolean)=>{released=true;destroyed=destroy===true;target.release(destroy);};const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
  try{
    await expect(new ProjectIdentityRegistrar({connect:async()=>wrapper} as unknown as Pool).registerProject({tenantId:f.tenantId,projectId:f.projectId,irProjectId:f.irProjectId})).rejects.toMatchObject({code:'STORAGE_FAILED'});
    expect(killed).toBe(true);expect(released).toBe(true);expect(destroyed).toBe(true);expect(ownedListener).toBeTypeOf('function');
    // pg-pool restores its own idle error listener during release, including destroyed clients; only the transaction-owned handler must be removed.
    expect(client.listeners('error')).not.toContain(ownedListener);
    await expect(f.store.resolveProject({tenantId:f.tenantId,projectId:f.projectId})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
  }finally{if(!released)client.release(true);}
});
it('limits an actual independent LOGIN to reading exact bindings and rejects capability expansion',async()=>{
  const f=await fixture();await f.registrar.registerProject({tenantId:f.tenantId,projectId:f.projectId,irProjectId:f.irProjectId});await f.registrar.registerPrincipal({tenantId:f.tenantId,kind:'user',key:'editor',irActorId:f.irActorId});
  const suffix=randomBytes(8).toString('hex');const role='identity_reader_'+suffix;const extraRole='identity_extra_'+suffix;const schema='identity_probe_'+suffix;const password=randomBytes(24).toString('hex');let reader:Pool|undefined;
  await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
  try{
    await pool.query(`CREATE ROLE ${extraRole} NOLOGIN NOINHERIT`);await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`CREATE TABLE ${schema}.canary(value text)`);await pool.query(`CREATE SEQUENCE ${schema}.sequence_probe`);
    await grantProjectIdentityReaderRole(pool,role);const url=new URL(databaseUrl!);url.username=role;url.password=password;reader=new Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});await verifyProjectIdentityReaderRole(reader);
    const store=new PostgresProjectIdentityStore(reader);expect((await store.resolve({tenantId:f.tenantId,projectId:f.projectId,kind:'user',key:'editor'})).principal.id).toBe(f.irActorId);
    for(const sql of [
      'INSERT INTO camery_projects.tenants(tenant_id,ir_tenant_id) VALUES(\'injected\',\'01K8H9K9QM4T7YFA51GW7ZV009\')',
      'UPDATE camery_projects.projects SET project_id=project_id',
      'DELETE FROM camery_projects.principals',
      'TRUNCATE camery_projects.principals',
      'SELECT * FROM camery_projects.migrations',
      'SELECT * FROM camery_versioning.projects',
      `CREATE TABLE camery_projects.denied_${suffix}(value text)`,
    ])await expect(reader.query(sql)).rejects.toMatchObject({code:'42501'});
    await expect(new ProjectIdentityRegistrar(reader).registerTenant({tenantId:f.tenantId+'-blocked',irTenantId:id(randomUUID())})).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const expansions:[string,string][]=[
      [`GRANT INSERT ON camery_projects.tenants TO ${role}`,`REVOKE INSERT ON camery_projects.tenants FROM ${role}`],
      [`GRANT UPDATE(project_id) ON camery_projects.projects TO ${role}`,`REVOKE UPDATE(project_id) ON camery_projects.projects FROM ${role}`],
      [`GRANT SELECT ON ${schema}.canary TO ${role}`,`REVOKE SELECT ON ${schema}.canary FROM ${role}`],
      [`GRANT SELECT(value) ON ${schema}.canary TO ${role}`,`REVOKE SELECT(value) ON ${schema}.canary FROM ${role}`],
      [`GRANT USAGE ON SEQUENCE ${schema}.sequence_probe TO ${role}`,`REVOKE USAGE ON SEQUENCE ${schema}.sequence_probe FROM ${role}`],
      [`GRANT USAGE ON SCHEMA camery_projects TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR USAGE ON SCHEMA camery_projects FROM ${role}`],
      [`GRANT SELECT ON camery_projects.tenants TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR SELECT ON camery_projects.tenants FROM ${role}`],
      [`GRANT CREATE ON SCHEMA camery_projects TO ${role}`,`REVOKE CREATE ON SCHEMA camery_projects FROM ${role}`],
      [`ALTER ROLE ${role} REPLICATION`,`ALTER ROLE ${role} NOREPLICATION`],
      [`GRANT ${extraRole} TO ${role}`,`REVOKE ${extraRole} FROM ${role}`],
    ];
    for(const [grant,revoke] of expansions){await pool.query(grant);try{await expect(verifyProjectIdentityReaderRole(reader)).rejects.toMatchObject({code:'STORAGE_FAILED'});}finally{await pool.query(revoke);}await verifyProjectIdentityReaderRole(reader);}
    await migrateProjectIdentities(pool);expect(await store.resolveProject({tenantId:f.tenantId,projectId:f.projectId})).toHaveProperty('versionKey.projectId',f.irProjectId);
  }finally{
    await reader?.end();await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.query(`DROP OWNED BY ${role}`);await pool.query(`DROP ROLE IF EXISTS ${role}`);await pool.query(`DROP ROLE IF EXISTS ${extraRole}`);
  }
});

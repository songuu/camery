import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {AccessService,issueSession} from '@camery/access';
import {migrateAccess,PostgresSessionStore} from '@camery/access/node';
import {migrateVersioning,PostgresVersionStore} from '@camery/versioning/node';
import {ProjectIdentityRegistrar,PostgresProjectIdentityStore} from '../src/projects/identity-map.js';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {grantProjectIdentityReaderRole,verifyProjectIdentityReaderRole} from '../src/projects/identity-role.js';
import {resolveProjectAuthority} from '../src/projects/authority.js';
import {changeSet,fixtureId as id,makePackage} from '../../ir/test/fixtures';

const databaseUrl=process.env['CAMERY_TEST_DATABASE_URL'];if(!databaseUrl)throw new Error('CAMERY_TEST_DATABASE_URL required for mapped host authority integration');
it('composes actual authenticated permissions, read-only bindings and version CAS with review revocation before ACK recovery',async()=>{
  const admin=new Pool({connectionString:databaseUrl});const scope={tenantId:'mapped-authority-'+randomUUID(),projectId:'project'};
  const versionKey={tenantId:id(scope.tenantId),projectId:id('prj_demo')};const role='project_authority_'+randomBytes(8).toString('hex');const password=randomBytes(24).toString('hex');let reader:Pool|undefined;let roleCreated=false;
  try{
    await migrateAccess(admin);await migrateVersioning(admin);await migrateProjectIdentities(admin);
    const versions=new PostgresVersionStore(admin);await versions.initialize(versionKey,makePackage());
    const register=new ProjectIdentityRegistrar(admin);await register.registerTenant({tenantId:scope.tenantId,irTenantId:versionKey.tenantId});await register.registerProject({...scope,irProjectId:versionKey.projectId});
    const sessions=new PostgresSessionStore(admin);const credentials:{editor:string;reviewer:string}={editor:'',reviewer:''};
    for(const member of ['editor','reviewer'] as const){
      await sessions.provisionMember({...scope,userId:member,role:member});const session=await issueSession({tenantId:scope.tenantId,userId:member,ttlSeconds:3600},sessions);credentials[member]='Bearer '+session.token;
      await register.registerPrincipal({tenantId:scope.tenantId,kind:'user',key:member,irActorId:id(scope.tenantId+member)});
    }
    await register.registerPrincipal({tenantId:scope.tenantId,kind:'agent_run',key:'reviewer',irActorId:id(scope.tenantId+'agent')});
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);roleCreated=true;await grantProjectIdentityReaderRole(admin,role);
    const url=new URL(databaseUrl!);url.username=role;url.password=password;reader=new Pool({connectionString:url.toString(),max:2});await verifyProjectIdentityReaderRole(reader);
    const identities=new PostgresProjectIdentityStore(reader);const access=new AccessService({tenantId:scope.tenantId,store:sessions});
    const editor=await access.authenticate(credentials.editor);await expect(resolveProjectAuthority({identities,subject:editor,projectId:scope.projectId,permission:'candidate:review'})).rejects.toMatchObject({code:'FORBIDDEN'});
    const author=await resolveProjectAuthority({identities,subject:editor,projectId:scope.projectId,permission:'candidate:write'});
    const request=changeSet([{op:'update',op_id:id(scope.tenantId+'op'),collection:'shots',target:id('sh_1'),set:{action:'明确审阅后采用'}}],{id:id(scope.tenantId+'change'),author:author.principal,base_revisions:[{id:id('sh_1'),version:1}]});
    const submitted=await versions.submit(author.versionKey,request,{expectation:{expectedSnapshotRevision:5,expectedWriteVersion:1}});expect(submitted.status).toBe('candidate');
    const reviewer=await resolveProjectAuthority({identities,subject:await access.authenticate(credentials.reviewer),projectId:scope.projectId,permission:'candidate:review'});
    const options={actor:reviewer.principal,scope:{kind:'project' as const,id:reviewer.versionKey.projectId},at:'2026-11-17T05:00:00.000Z',authorize:reviewer.authorize,expectation:{expectedSnapshotRevision:5,expectedWriteVersion:2}};
    const adopted=await versions.adopt(reviewer.versionKey,request.id,options);expect(adopted.status).toBe('adopted');expect(adopted.writeVersion).toBe(3);expect(adopted.state.adoptions).toEqual([expect.objectContaining({actor_id:id(scope.tenantId+'reviewer'),from_revision:5,to_revision:6})]);
    expect((await identities.resolve({ ...scope,kind:'agent_run',key:'reviewer'})).principal.id).not.toBe(reviewer.principal.id);
    expect((await versions.adopt(reviewer.versionKey,request.id,options)).state).toEqual(adopted.state);
    await sessions.provisionMember({...scope,userId:'reviewer',role:'viewer'});
    await expect(resolveProjectAuthority({identities,subject:await access.authenticate(credentials.reviewer),projectId:scope.projectId,permission:'candidate:review'})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect((await versions.read(versionKey))!.state).toEqual(adopted.state);expect((await versions.read(versionKey))!.writeVersion).toBe(3);
    await expect(resolveProjectAuthority({identities,subject:editor,projectId:'ungranted',permission:'candidate:write'})).rejects.toMatchObject({code:'FORBIDDEN'});
  }finally{
    await reader?.end();
    for(const table of ['principals','projects','tenants'])await admin.query(`DELETE FROM camery_projects.${table} WHERE tenant_id=$1`,[scope.tenantId]);
    const client=await admin.connect();try{await client.query('BEGIN');await client.query('SET CONSTRAINTS ALL DEFERRED');for(const table of ['adoptions','object_revisions','changes','snapshots','projects'])await client.query(`DELETE FROM camery_versioning.${table} WHERE tenant_id=$1 AND project_id=$2`,[versionKey.tenantId,versionKey.projectId]);await client.query('COMMIT');}finally{client.release();}
    for(const table of ['sessions','memberships','users'])await admin.query(`DELETE FROM camery_access.${table} WHERE tenant_id=$1`,[scope.tenantId]);
    if(roleCreated){await admin.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`);}await admin.end();
  }
});

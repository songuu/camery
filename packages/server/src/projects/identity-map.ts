import type {Pool,PoolClient} from 'pg';
import {freeze} from '@camery/methods';
import {ProjectIdentityError,ProjectIdentityScopeSchema,PrincipalIdentityScopeSchema,ResolveProjectIdentitySchema,RegisterTenantIdentitySchema,RegisterProjectIdentitySchema,RegisterPrincipalIdentitySchema,captureIdentity,storedIdentityId} from './contracts.js';
import type {ProjectIdentityScope,PrincipalIdentityScope,ResolveProjectIdentity,ProjectIdentityBinding,PrincipalIdentityBinding,ResolvedProjectIdentity,TenantIdentityBinding} from './contracts.js';

type TenantRow={tenant_id:string;ir_tenant_id:string};
type ProjectRow=TenantRow&{project_id:string;ir_project_id:string};
type PrincipalRow=TenantRow&{principal_kind:string;principal_key:string;ir_actor_id:string};
type ResolvedRow=ProjectRow&{principal_kind:string|null;principal_key:string|null;ir_actor_id:string|null};
function one<T>(rows:T[]):T|undefined{if(rows.length>1)throw new ProjectIdentityError('STORAGE_FAILED','duplicate binding');return rows[0];}
function tenantBinding(row:TenantRow,tenantId:string):TenantIdentityBinding{
  if(row.tenant_id!==tenantId)throw new ProjectIdentityError('STORAGE_FAILED','stored tenant binding');return freeze({tenantId,irTenantId:storedIdentityId(row.ir_tenant_id)});
}
function projectBinding(row:ProjectRow,key:ProjectIdentityScope):ProjectIdentityBinding{
  if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId)throw new ProjectIdentityError('STORAGE_FAILED','stored project binding');
  return freeze({...key,versionKey:{tenantId:storedIdentityId(row.ir_tenant_id),projectId:storedIdentityId(row.ir_project_id)}});
}
function principalBinding(row:PrincipalRow,key:PrincipalIdentityScope):PrincipalIdentityBinding{
  if(row.tenant_id!==key.tenantId||row.principal_kind!==key.kind||row.principal_key!==key.key)throw new ProjectIdentityError('STORAGE_FAILED','stored principal binding');storedIdentityId(row.ir_tenant_id);
  return freeze({...key,principal:{kind:key.kind,id:storedIdentityId(row.ir_actor_id)}});
}
async function read<T>(operation:string,action:()=>Promise<T>):Promise<T>{
  try{return await action();}catch(error){if(error instanceof ProjectIdentityError)throw error;throw new ProjectIdentityError('STORAGE_FAILED',operation);}
}
/** Shared installer transaction; runtime resolution uses a single SELECT and never acquires a writing connection. */
export async function identityTransaction<T>(pool:Pool,operation:string,action:(client:PoolClient)=>Promise<T>,conflicts=false):Promise<T>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ProjectIdentityError('STORAGE_FAILED',operation);}let failed=false;let destroy=false;
  const onError=()=>{failed=true;destroy=true;};const connected=()=>{if(failed)throw new ProjectIdentityError('STORAGE_FAILED',operation);};client.on('error',onError);
  try{await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');connected();const result=await action(client);connected();await client.query('COMMIT');connected();return result;}
  catch(error){
    try{await client.query('ROLLBACK');}catch{destroy=true;throw new ProjectIdentityError('STORAGE_FAILED',operation);}
    connected();if(error instanceof ProjectIdentityError)throw error;
    let code:unknown;try{const descriptor=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code'):undefined;if(descriptor&&'value' in descriptor)code=descriptor.value;}catch{/* Driver metadata must never expose an accessor exception. */}
    throw new ProjectIdentityError(conflicts&&(code==='23503'||code==='23505')?'BINDING_CONFLICT':'STORAGE_FAILED',operation);
  // oxlint-disable-next-line eslint/no-unsafe-finally -- Release failures remain redacted and cannot masquerade as a successful registration.
  }finally{try{client.release(destroy);}catch{throw new ProjectIdentityError('STORAGE_FAILED',operation);}finally{client.off('error',onError);}}
}

/** Resolves already registered authority only; authorization must come from the trusted calling application. */
export class PostgresProjectIdentityStore{
  constructor(private readonly pool:Pool){}
  async resolveProject(input:ProjectIdentityScope):Promise<ProjectIdentityBinding>{
    const key=captureIdentity(ProjectIdentityScopeSchema,input,'resolve project');
    return read('resolve project',async()=>{
      const result=await this.pool.query<ProjectRow>('SELECT tenant_id,project_id,ir_tenant_id,ir_project_id FROM camery_projects.projects WHERE tenant_id=$1 AND project_id=$2',[key.tenantId,key.projectId]);
      const row=one(result.rows);if(!row)throw new ProjectIdentityError('PROJECT_BINDING_MISSING','resolve project');return projectBinding(row,key);
    });
  }
  async resolvePrincipal(input:PrincipalIdentityScope):Promise<PrincipalIdentityBinding>{
    const key=captureIdentity(PrincipalIdentityScopeSchema,input,'resolve principal');
    return read('resolve principal',async()=>{
      const result=await this.pool.query<PrincipalRow>('SELECT tenant_id,principal_kind,principal_key,ir_tenant_id,ir_actor_id FROM camery_projects.principals WHERE tenant_id=$1 AND principal_kind=$2 AND principal_key=$3',[key.tenantId,key.kind,key.key]);
      const row=one(result.rows);if(!row)throw new ProjectIdentityError('PRINCIPAL_BINDING_MISSING','resolve principal');return principalBinding(row,key);
    });
  }
  async resolve(input:ResolveProjectIdentity):Promise<ResolvedProjectIdentity>{
    const key=captureIdentity(ResolveProjectIdentitySchema,input,'resolve authority');const scope={tenantId:key.tenantId,projectId:key.projectId};const principal={tenantId:key.tenantId,kind:key.kind,key:key.key};
    return read('resolve authority',async()=>{
      // One statement observes the two immutable mappings from one database snapshot, including a missing principal.
      const result=await this.pool.query<ResolvedRow>('SELECT p.tenant_id,p.project_id,p.ir_tenant_id,p.ir_project_id,a.principal_kind,a.principal_key,a.ir_actor_id FROM camery_projects.projects p LEFT JOIN camery_projects.principals a ON a.tenant_id=p.tenant_id AND a.ir_tenant_id=p.ir_tenant_id AND a.principal_kind=$3 AND a.principal_key=$4 WHERE p.tenant_id=$1 AND p.project_id=$2',[key.tenantId,key.projectId,key.kind,key.key]);
      const row=one(result.rows);if(!row)throw new ProjectIdentityError('PROJECT_BINDING_MISSING','resolve authority');const project=projectBinding(row,scope);
      if(row.principal_kind===null&&row.principal_key===null&&row.ir_actor_id===null)throw new ProjectIdentityError('PRINCIPAL_BINDING_MISSING','resolve authority');
      const actor=principalBinding({...row,principal_kind:row.principal_kind!,principal_key:row.principal_key!,ir_actor_id:row.ir_actor_id!},principal);
      return freeze({scope,versionKey:project.versionKey,principal:actor.principal});
    });
  }
}

/** Explicit trusted installer, intentionally separate from the read-only runtime facade. It never initializes IR. */
export class ProjectIdentityRegistrar{
  constructor(private readonly pool:Pool){}
  private async tenant(client:PoolClient,tenantId:string):Promise<TenantIdentityBinding>{
    const result=await client.query<TenantRow>('SELECT tenant_id,ir_tenant_id FROM camery_projects.tenants WHERE tenant_id=$1',[tenantId]);const row=one(result.rows);
    if(!row)throw new ProjectIdentityError('PROJECT_BINDING_MISSING','registered tenant');return tenantBinding(row,tenantId);
  }
  private async lock(client:PoolClient,kind:string,key:readonly string[]):Promise<void>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['camery_projects:identity',kind,...key])]);
  }
  async registerTenant(input:unknown):Promise<TenantIdentityBinding>{
    const command=captureIdentity(RegisterTenantIdentitySchema,input,'register tenant');
    return identityTransaction(this.pool,'register tenant',async client=>{
      await this.lock(client,'tenant',[command.tenantId]);const existing=await client.query<TenantRow>('SELECT tenant_id,ir_tenant_id FROM camery_projects.tenants WHERE tenant_id=$1',[command.tenantId]);const row=one(existing.rows);
      if(row){const binding=tenantBinding(row,command.tenantId);if(binding.irTenantId!==command.irTenantId)throw new ProjectIdentityError('BINDING_CONFLICT','register tenant');return binding;}
      const inserted=await client.query<TenantRow>('INSERT INTO camery_projects.tenants(tenant_id,ir_tenant_id) VALUES($1,$2) RETURNING tenant_id,ir_tenant_id',[command.tenantId,command.irTenantId]);const saved=one(inserted.rows);if(!saved||saved.ir_tenant_id!==command.irTenantId)throw new ProjectIdentityError('STORAGE_FAILED','register tenant');return tenantBinding(saved,command.tenantId);
    },true);
  }
  async registerProject(input:unknown):Promise<ProjectIdentityBinding>{
    const command=captureIdentity(RegisterProjectIdentitySchema,input,'register project');const key={tenantId:command.tenantId,projectId:command.projectId};
    return identityTransaction(this.pool,'register project',async client=>{
      await this.lock(client,'project',[key.tenantId,key.projectId]);const tenant=await this.tenant(client,key.tenantId);
      const existing=await client.query<ProjectRow>('SELECT tenant_id,project_id,ir_tenant_id,ir_project_id FROM camery_projects.projects WHERE tenant_id=$1 AND project_id=$2',[key.tenantId,key.projectId]);const row=one(existing.rows);
      if(row){const binding=projectBinding(row,key);if(binding.versionKey.tenantId!==tenant.irTenantId||binding.versionKey.projectId!==command.irProjectId)throw new ProjectIdentityError('BINDING_CONFLICT','register project');return binding;}
      const inserted=await client.query<ProjectRow>('INSERT INTO camery_projects.projects(tenant_id,project_id,ir_tenant_id,ir_project_id) VALUES($1,$2,$3,$4) RETURNING tenant_id,project_id,ir_tenant_id,ir_project_id',[key.tenantId,key.projectId,tenant.irTenantId,command.irProjectId]);const saved=one(inserted.rows);if(!saved||saved.ir_tenant_id!==tenant.irTenantId||saved.ir_project_id!==command.irProjectId)throw new ProjectIdentityError('STORAGE_FAILED','register project');return projectBinding(saved,key);
    },true);
  }
  async registerPrincipal(input:unknown):Promise<PrincipalIdentityBinding>{
    const command=captureIdentity(RegisterPrincipalIdentitySchema,input,'register principal');const key={tenantId:command.tenantId,kind:command.kind,key:command.key};
    return identityTransaction(this.pool,'register principal',async client=>{
      await this.lock(client,'principal',[key.tenantId,key.kind,key.key]);const tenant=await this.tenant(client,key.tenantId);
      const existing=await client.query<PrincipalRow>('SELECT tenant_id,principal_kind,principal_key,ir_tenant_id,ir_actor_id FROM camery_projects.principals WHERE tenant_id=$1 AND principal_kind=$2 AND principal_key=$3',[key.tenantId,key.kind,key.key]);const row=one(existing.rows);
      if(row){const binding=principalBinding(row,key);if(row.ir_tenant_id!==tenant.irTenantId||binding.principal.id!==command.irActorId)throw new ProjectIdentityError('BINDING_CONFLICT','register principal');return binding;}
      const inserted=await client.query<PrincipalRow>('INSERT INTO camery_projects.principals(tenant_id,principal_kind,principal_key,ir_tenant_id,ir_actor_id) VALUES($1,$2,$3,$4,$5) RETURNING tenant_id,principal_kind,principal_key,ir_tenant_id,ir_actor_id',[key.tenantId,key.kind,key.key,tenant.irTenantId,command.irActorId]);const saved=one(inserted.rows);if(!saved||saved.ir_tenant_id!==tenant.irTenantId||saved.ir_actor_id!==command.irActorId)throw new ProjectIdentityError('STORAGE_FAILED','register principal');return principalBinding(saved,key);
    },true);
  }
}

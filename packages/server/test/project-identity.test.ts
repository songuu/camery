import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {PostgresProjectIdentityStore,ProjectIdentityRegistrar} from '../src/projects/identity-map.js';
import {ProjectIdentityError} from '../src/projects/contracts.js';

const tenant='01K8H9K9QM4T7YFA51GW7ZV001';
const project='01K8H9K9QM4T7YFA51GW7ZV002';
const actor='01K8H9K9QM4T7YFA51GW7ZV003';
const ordinary={tenantId:'tenant-a',projectId:'project-a'};
const principal={tenantId:ordinary.tenantId,kind:'user' as const,key:'editor'};
const projectRow={tenant_id:ordinary.tenantId,project_id:ordinary.projectId,ir_tenant_id:tenant,ir_project_id:project};
const principalRow={tenant_id:ordinary.tenantId,principal_kind:'user',principal_key:'editor',ir_tenant_id:tenant,ir_actor_id:actor};
const projectBinding={...ordinary,versionKey:{tenantId:tenant,projectId:project}};
const principalBinding={...principal,principal:{kind:'user',id:actor}};
function fixture(rows:unknown[]=[]){
  const query=vi.fn().mockResolvedValue({rows});const pool={query,connect:vi.fn()} as unknown as Pool;
  return {query,pool,store:new PostgresProjectIdentityStore(pool)};
}
function installer(handler?:(sql:string,values?:unknown[])=>unknown){
  const client=new EventEmitter() as EventEmitter&{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>};
  client.query=vi.fn(async(sql:string,values?:unknown[])=>handler?.(sql,values)??{rows:[]});client.release=vi.fn();
  const connect=vi.fn().mockResolvedValue(client);const pool={connect} as unknown as Pool;
  return {pool,client,connect,registrar:new ProjectIdentityRegistrar(pool)};
}
it('resolves only the exact project pair with one SELECT and returns detached frozen authority',async()=>{
  const f=fixture([projectRow]);const input={...ordinary};const pending=f.store.resolveProject(input);input.projectId='changed';
  const result=await pending;expect(result).toEqual(projectBinding);expect(Object.isFrozen(result.versionKey)).toBe(true);
  expect(f.query).toHaveBeenCalledOnce();expect(f.query.mock.calls[0]?.[1]).toEqual(['tenant-a','project-a']);expect(f.query.mock.calls[0]?.[0]).toMatch(/^SELECT/);
});
it('preserves the actual principal kind rather than converting agents into users',async()=>{
  for(const kind of ['user','agent_run','system'] as const){const f=fixture([{...principalRow,principal_kind:kind}]);expect(await f.store.resolvePrincipal({...principal,kind})).toEqual({...principalBinding,kind,principal:{kind,id:actor}});}
});
it('resolves project and principal from one consistent scoped statement',async()=>{
  const f=fixture([{...projectRow,principal_kind:'user',principal_key:'editor',ir_actor_id:actor}]);
  expect(await f.store.resolve({...ordinary,kind:'user',key:'editor'})).toEqual({scope:ordinary,versionKey:projectBinding.versionKey,principal:{kind:'user',id:actor}});
  expect(f.query).toHaveBeenCalledOnce();expect(f.query.mock.calls[0]?.[1]).toEqual(['tenant-a','project-a','user','editor']);
});
it('reports absent project and principal bindings without creating or allocating anything',async()=>{
  const f=fixture();await expect(f.store.resolveProject(ordinary)).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
  await expect(f.store.resolvePrincipal(principal)).rejects.toMatchObject({code:'PRINCIPAL_BINDING_MISSING'});
  await expect(f.store.resolve({...ordinary,kind:'user',key:'editor'})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
  f.query.mockResolvedValueOnce({rows:[{...projectRow,principal_kind:null,principal_key:null,ir_actor_id:null}]});
  await expect(f.store.resolve({...ordinary,kind:'user',key:'editor'})).rejects.toMatchObject({code:'PRINCIPAL_BINDING_MISSING'});
  expect(f.pool.connect).not.toHaveBeenCalled();
});
it('rejects accessors, unexpected fields and malformed identifiers before storage',async()=>{
  const f=fixture([projectRow]);let getter=0;const dangerous={...ordinary,get extra(){getter++;return 'bad';}};
  for(const input of [dangerous,{...ordinary,extra:true},{...ordinary,tenantId:'tenant-a\n'},Object.assign(Object.create({}),ordinary),null])await expect(f.store.resolveProject(input as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.store.resolvePrincipal({...principal,kind:'human'} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(getter).toBe(0);expect(f.query).not.toHaveBeenCalled();
});
it('fails closed on corrupt, cross-scope or duplicate stored rows',async()=>{
  for(const row of [{...projectRow,tenant_id:'other'},{...projectRow,ir_project_id:project+'\n'},{...projectRow,ir_tenant_id:'not-ulid'}]){const f=fixture([row]);await expect(f.store.resolveProject(ordinary)).rejects.toMatchObject({code:'STORAGE_FAILED'});}
  const f=fixture([projectRow,projectRow]);await expect(f.store.resolveProject(ordinary)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const p=fixture([{...principalRow,principal_kind:'agent_run'}]);await expect(p.store.resolvePrincipal(principal)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('redacts driver errors from read paths',async()=>{
  const f=fixture();f.query.mockRejectedValue(new Error('postgresql://secret-password@host private source'));
  const failure=await f.store.resolveProject(ordinary).catch(error=>error);expect(failure).toBeInstanceOf(ProjectIdentityError);expect(failure.code).toBe('STORAGE_FAILED');expect(String(failure)).not.toContain('secret');
});
it('explicitly registers a tenant once and refuses semantic rebinding',async()=>{
  const f=installer(sql=>sql.startsWith('SELECT tenant_id,ir_tenant_id')?{rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]}:undefined);
  expect(await f.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant})).toEqual({tenantId:'tenant-a',irTenantId:tenant});
  expect(f.client.query.mock.calls.map(call=>call[0])).toContain('COMMIT');expect(f.client.listenerCount('error')).toBe(0);
  await expect(f.registrar.registerTenant({tenantId:'tenant-a',irTenantId:actor})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
});
it('registers a new tenant and scoped project/principal without manufacturing a version head',async()=>{
  for(const action of ['tenant','project','principal'] as const){
    const f=installer((sql)=>{
      if(sql.startsWith('SELECT tenant_id,ir_tenant_id')&&action!=='tenant')return {rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]};
      if(sql.startsWith('INSERT INTO camery_projects.tenants'))return {rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]};
      if(sql.startsWith('INSERT INTO camery_projects.projects'))return {rows:[projectRow]};
      if(sql.startsWith('INSERT INTO camery_projects.principals'))return {rows:[principalRow]};
      return undefined;
    });
    const result=action==='tenant'?await f.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant}):action==='project'?await f.registrar.registerProject({...ordinary,irProjectId:project}):await f.registrar.registerPrincipal({...principal,irActorId:actor});
    expect(result).toEqual(action==='tenant'?{tenantId:'tenant-a',irTenantId:tenant}:action==='project'?projectBinding:principalBinding);
    expect(f.client.query.mock.calls.some(call=>/INSERT INTO camery_versioning/.test(call[0]))).toBe(false);
  }
});
it('validates installer commands and canonical ULIDs before opening a connection',async()=>{
  const f=installer();for(const value of [tenant+'\n',tenant.toLowerCase(),'8'+tenant.slice(1),'bad'])await expect(f.registrar.registerTenant({tenantId:'tenant-a',irTenantId:value})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.registrar.registerProject({...ordinary,irProjectId:project,actor:'injected'} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.registrar.registerPrincipal({...principal,kind:'human',irActorId:actor} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.connect).not.toHaveBeenCalled();
});
it('rolls back a registration when its tenant is missing or its real project FK refuses it',async()=>{
  const missing=installer();await expect(missing.registrar.registerProject({...ordinary,irProjectId:project})).rejects.toMatchObject({code:'PROJECT_BINDING_MISSING'});
  for(const code of ['23503','23505']){const f=installer(sql=>{if(sql.startsWith('SELECT tenant_id,ir_tenant_id'))return {rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]};if(sql.startsWith('INSERT'))throw Object.assign(new Error('private SQL'),{code});return undefined;});await expect(f.registrar.registerProject({...ordinary,irProjectId:project})).rejects.toMatchObject({code:'BINDING_CONFLICT'});expect(f.client.query.mock.calls.map(call=>call[0])).toContain('ROLLBACK');}
});
it('checks existing project/principal bindings for exact semantics',async()=>{
  const f=installer(sql=>sql.startsWith('SELECT tenant_id,ir_tenant_id')?{rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]}:sql.includes('FROM camery_projects.projects')?{rows:[projectRow]}:sql.includes('FROM camery_projects.principals')?{rows:[principalRow]}:undefined);
  expect(await f.registrar.registerProject({...ordinary,irProjectId:project})).toEqual(projectBinding);expect(await f.registrar.registerPrincipal({...principal,irActorId:actor})).toEqual(principalBinding);
  await expect(f.registrar.registerProject({...ordinary,irProjectId:actor})).rejects.toMatchObject({code:'BINDING_CONFLICT'});await expect(f.registrar.registerPrincipal({...principal,irActorId:project})).rejects.toMatchObject({code:'BINDING_CONFLICT'});
});
it('captures registration inputs before an awaited checkout',async()=>{
  const f=installer(sql=>sql.startsWith('INSERT INTO camery_projects.tenants')?{rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]}:undefined);let unlock:(value:unknown)=>void=()=>{};
  f.connect.mockReturnValueOnce(new Promise(resolve=>{unlock=resolve;}));const input={tenantId:'tenant-a',irTenantId:tenant};const pending=f.registrar.registerTenant(input);input.tenantId='other';input.irTenantId=actor;unlock(f.client);
  expect(await pending).toEqual({tenantId:'tenant-a',irTenantId:tenant});
});
it('owns connection errors and destroys failed clients while redacting checkout, rollback and release failures',async()=>{
  const disconnected=installer(sql=>{if(sql==='COMMIT')disconnected.client.emit('error',new Error('secret connection'));if(sql.startsWith('INSERT INTO camery_projects.tenants'))return {rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]};return undefined;});
  await expect(disconnected.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(disconnected.client.release).toHaveBeenCalledWith(true);expect(disconnected.client.listenerCount('error')).toBe(0);
  const checkout=installer();checkout.connect.mockRejectedValueOnce(new Error('secret connect'));await expect(checkout.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const rollback=installer(sql=>{if(sql==='ROLLBACK')throw new Error('secret rollback');return undefined;});await expect(rollback.registrar.registerProject({...ordinary,irProjectId:project})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(rollback.client.release).toHaveBeenCalledWith(true);
  const release=installer();release.client.release.mockImplementation(()=>{throw new Error('secret release');});await expect(release.registrar.registerProject({...ordinary,irProjectId:project})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(release.client.listenerCount('error')).toBe(0);
});
it('fails closed on missing or inconsistent insertion acknowledgements',async()=>{
  for(const action of ['tenant','project','principal'] as const)for(const malformed of [null,'different','tenant'] as const){
    const f=installer(sql=>{
      if(sql.startsWith('SELECT tenant_id,ir_tenant_id')&&action!=='tenant')return {rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant}]};
      if(sql.startsWith('INSERT'))return {rows:malformed===null?[]:[action==='tenant'?{tenant_id:'tenant-a',ir_tenant_id:actor}:action==='project'?{...projectRow,...(malformed==='tenant'?{ir_tenant_id:actor}:{ir_project_id:actor})}:{...principalRow,...(malformed==='tenant'?{ir_tenant_id:project}:{ir_actor_id:project})}]};return undefined;
    });
    const pending=action==='tenant'?f.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant}):action==='project'?f.registrar.registerProject({...ordinary,irProjectId:project}):f.registrar.registerPrincipal({...principal,irActorId:actor});
    await expect(pending).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.client.query.mock.calls.map(call=>call[0])).not.toContain('COMMIT');
  }
});
it('redacts synchronous checkout failures and never executes driver error metadata accessors',async()=>{
  const checkout=installer();checkout.connect.mockImplementation(()=>{throw new Error('secret sync checkout');});await expect(checkout.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  let accessed=0;const error={get code(){accessed++;throw new Error('secret accessor');}};
  const f=installer(sql=>{if(sql.startsWith('SELECT tenant_id'))throw error;return undefined;});await expect(f.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant})).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(accessed).toBe(0);
});
it('rejects partial joined principal evidence and corrupt duplicate installer rows',async()=>{
  const f=fixture([{...projectRow,principal_kind:'user',principal_key:'editor',ir_actor_id:null}]);await expect(f.store.resolve({...ordinary,kind:'user',key:'editor'})).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const p=fixture([{...principalRow,principal_key:'other'}]);await expect(p.store.resolvePrincipal(principal)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const duplicate=installer(sql=>sql.startsWith('SELECT tenant_id,ir_tenant_id')?{rows:[{tenant_id:'tenant-a',ir_tenant_id:tenant},{tenant_id:'tenant-a',ir_tenant_id:tenant}]}:undefined);await expect(duplicate.registrar.registerTenant({tenantId:'tenant-a',irTenantId:tenant})).rejects.toMatchObject({code:'STORAGE_FAILED'});
});

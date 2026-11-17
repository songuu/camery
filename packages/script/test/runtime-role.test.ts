import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { grantDevelopmentRuntimeRole,verifyDevelopmentRuntimeRole } from '../src/node/runtime-role.js';
it('accepts only literal true and checks append-only privileges, grants, identity and every user schema',async()=>{
  const query=vi.fn(async(_sql:string)=>({rows:[{allowed:true}]}));await verifyDevelopmentRuntimeRole({query} as unknown as Pool);
  const sql=query.mock.calls[0]![0];for(const text of ['camery_script','rolcanlogin','NOT r.rolreplication','session_user=current_user','has_column_privilege',"'MEMBER'",'WITH GRANT OPTION',"CASE WHEN c.relkind='S'","has_schema_privilege(n.oid,'USAGE WITH GRANT OPTION')"])expect(sql).toContain(text);
  expect(sql).not.toContain("has_schema_privilege('camery_access'");
});
it.each([false,null,undefined,1,'true'])('rejects a non-literal permission result %j',async allowed=>{
  await expect(verifyDevelopmentRuntimeRole({query:async()=>({rows:[{allowed}]})} as unknown as Pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('redacts missing results and arbitrary database errors',async()=>{
  for(const query of [async()=>({rows:[]}),async()=>{throw new Error('private-login');}])await expect(verifyDevelopmentRuntimeRole({query} as unknown as Pool)).rejects.toThrow('restricted development role');
});
function installer(options:{connect?:boolean;failure?:string;release?:boolean}={}){
  const release=vi.fn((destroy?:boolean)=>{if(options.release)throw new Error('private');return destroy;});
  const query=vi.fn(async(sql:string)=>{if(options.failure&&sql.startsWith(options.failure))throw new Error('private');return {rows:[]};});
  const connect=vi.fn(async()=>{if(options.connect)throw new Error('private');return {query,release};});return {pool:{connect} as unknown as Pool,query,release,connect};
}
it('grants only schema usage and the five static append-only table capabilities in one explicit installer transaction',async()=>{
  const db=installer();await grantDevelopmentRuntimeRole(db.pool,'development_runtime');expect(db.query.mock.calls.map(([sql])=>sql)).toEqual([
    'BEGIN','GRANT USAGE ON SCHEMA camery_script TO "development_runtime"',
    'GRANT SELECT,INSERT ON camery_script.briefs,camery_script.runs,camery_script.candidates,camery_script.reviews,camery_script.run_origins TO "development_runtime"','COMMIT']);expect(db.release).toHaveBeenCalledOnce();
});
it.each(['','role;DROP TABLE','role\n','a'.repeat(64),'UPPER'])('rejects installer role injection %j before connecting',async role=>{
  const db=installer();await expect(grantDevelopmentRuntimeRole(db.pool,role)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(db.connect).not.toHaveBeenCalled();
});
it.each(['BEGIN','GRANT USAGE','GRANT SELECT','COMMIT'])('redacts installer failure at %s and releases its connection',async failure=>{
  const db=installer({failure});await expect(grantDevelopmentRuntimeRole(db.pool,'development_runtime')).rejects.toThrow('grant development role');expect(db.release).toHaveBeenCalledOnce();
});
it('redacts installer connection, rollback and release failures',async()=>{
  await expect(grantDevelopmentRuntimeRole(installer({connect:true}).pool,'development_runtime')).rejects.toThrow('grant development role');
  const query=vi.fn(async(sql:string)=>{if(sql==='ROLLBACK'||sql.startsWith('GRANT'))throw new Error('private');return {rows:[]};});const release=vi.fn();
  await expect(grantDevelopmentRuntimeRole({connect:async()=>({query,release})} as unknown as Pool,'development_runtime')).rejects.toThrow('grant development role');expect(release).toHaveBeenCalledWith(true);
  await expect(grantDevelopmentRuntimeRole(installer({release:true}).pool,'development_runtime')).rejects.toThrow('grant development role');
});

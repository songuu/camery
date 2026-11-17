import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {migrateProjectIdentities} from '../src/projects/migrate.js';
import {grantProjectIdentityReaderRole,verifyProjectIdentityReaderRole} from '../src/projects/identity-role.js';

function fixture(handler?:(sql:string,values?:unknown[])=>unknown){
  const client=new EventEmitter() as EventEmitter&{query:ReturnType<typeof vi.fn>;release:ReturnType<typeof vi.fn>};
  client.query=vi.fn(async(sql:string,values?:unknown[])=>handler?.(sql,values)??{rows:[]});client.release=vi.fn();const connect=vi.fn().mockResolvedValue(client);
  return {client,connect,pool:{connect} as unknown as Pool};
}
it('installs its checksummed append-only identity schema explicitly under an installer lock',async()=>{
  const f=fixture();await migrateProjectIdentities(f.pool);const calls=f.client.query.mock.calls;
  expect(calls[0]?.[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');expect(calls.some(call=>String(call[0]).includes('camery_projects:migrations'))).toBe(true);
  const sql=await readFile(new URL('../src/projects/migrations/0001-identity-bindings.sql',import.meta.url),'utf8');
  expect(calls.some(call=>call[0]===sql)).toBe(true);expect(calls.find(call=>String(call[0]).startsWith('INSERT INTO camery_projects.migrations'))?.[1]).toEqual([1,createHash('sha256').update(sql,'utf8').digest('hex')]);expect(calls.at(-1)?.[0]).toBe('COMMIT');
});
it('leaves already installed schema intact and rejects checksum or future migration drift',async()=>{
  const sql=await readFile(new URL('../src/projects/migrations/0001-identity-bindings.sql',import.meta.url),'utf8');const checksum=createHash('sha256').update(sql,'utf8').digest('hex');
  const good=fixture(query=>query.startsWith('SELECT version,checksum')?{rows:[{version:1,checksum}]}:undefined);await migrateProjectIdentities(good.pool);expect(good.client.query.mock.calls.some(call=>call[0]===sql)).toBe(false);
  for(const rows of [[{version:1,checksum:'bad'}],[{version:2,checksum}],[{version:1,checksum},{version:2,checksum}]]){const f=fixture(query=>query.startsWith('SELECT version,checksum')?{rows}:undefined);await expect(migrateProjectIdentities(f.pool)).rejects.toMatchObject({code:'BINDING_CONFLICT'});expect(f.client.query.mock.calls.map(call=>call[0])).toContain('ROLLBACK');}
});
it('grants only SELECT on the three binding tables, with no runtime installation capability',async()=>{
  const f=fixture();await grantProjectIdentityReaderRole(f.pool,'identity_reader');const calls=f.client.query.mock.calls.map(call=>call[0]);
  expect(calls).toContain('GRANT USAGE ON SCHEMA camery_projects TO "identity_reader"');expect(calls).toContain('GRANT SELECT ON camery_projects.tenants,camery_projects.projects,camery_projects.principals TO "identity_reader"');
  expect(calls.join('\n')).not.toMatch(/GRANT.*(?:INSERT|UPDATE|DELETE|CREATE|ALL|migrations)/);
});
it('rejects unsafe role names before checkout',async()=>{
  const f=fixture();for(const role of ['reader\n','reader; DROP ROLE x','Admin','a'.repeat(64),''])await expect(grantProjectIdentityReaderRole(f.pool,role)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.connect).not.toHaveBeenCalled();
});
it('verifies the exact reader capabilities without granting or mutating anything',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{allowed:true}]});await verifyProjectIdentityReaderRole({query} as unknown as Pool);expect(query).toHaveBeenCalledOnce();
  const sql=String(query.mock.calls[0]?.[0]);for(const token of ['rolreplication','rolinherit','session_user=current_user','USAGE WITH GRANT OPTION','has_column_privilege','has_sequence_privilege'])expect(sql).toContain(token);expect(sql).not.toMatch(/^\s*GRANT /m);
});
it('rejects missing or expanded capabilities and redacts verifier driver errors',async()=>{
  for(const rows of [[],[{allowed:false}],[{allowed:null}]])await expect(verifyProjectIdentityReaderRole({query:vi.fn().mockResolvedValue({rows})} as unknown as Pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  const failure=await verifyProjectIdentityReaderRole({query:vi.fn().mockRejectedValue(new Error('secret role URL'))} as unknown as Pool).catch(error=>error);expect(String(failure)).not.toContain('secret');
});
it('redacts installation driver, checkout and release errors',async()=>{
  for(const command of ['migration','grant'] as const){
    const f=fixture(query=>{if(query==='COMMIT')throw new Error('secret SQL');return undefined;});await expect(command==='migration'?migrateProjectIdentities(f.pool):grantProjectIdentityReaderRole(f.pool,'reader')).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.client.query.mock.calls.map(call=>call[0])).toContain('ROLLBACK');
    const checkout=fixture();checkout.connect.mockRejectedValue(new Error('secret connection'));await expect(command==='migration'?migrateProjectIdentities(checkout.pool):grantProjectIdentityReaderRole(checkout.pool,'reader')).rejects.toMatchObject({code:'STORAGE_FAILED'});
    const release=fixture();release.client.release.mockImplementation(()=>{throw new Error('secret release');});await expect(command==='migration'?migrateProjectIdentities(release.pool):grantProjectIdentityReaderRole(release.pool,'reader')).rejects.toMatchObject({code:'STORAGE_FAILED'});
  }
});

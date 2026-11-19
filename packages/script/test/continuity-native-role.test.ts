import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {grantContinuityAdoptionRole,verifyContinuityAdoptionRole} from '../src/continuity/node/native-role.js';
import {grantContinuityRuntimeRole,verifyContinuityRuntimeRole} from '../src/continuity/node/runtime-role.js';

function fixture(){
  const state={allowed:true,rows:1,emitError:false},client=new EventEmitter();
  const query=vi.fn(async(text:string)=>{
    if(state.emitError&&text==='COMMIT')queueMicrotask(()=>client.emit('error',new Error('private asynchronous credential')));
    if(text.includes('pg_get_serial_sequence')&&!text.includes('WITH permitted'))return {rows:[{changes:'camery_versioning.changes_sequence_seq',history:'camery_versioning.object_revisions_sequence_seq'}]};
    return {rows:text.includes('WITH permitted')?Array.from({length:state.rows},()=>({allowed:state.allowed})):[]};
  });
  const release=vi.fn(),connect=vi.fn(async()=>Object.assign(client,{query,release}));return {state,client,query,release,connect,pool:{query,connect} as unknown as Pool};
}
it('installs a dedicated adopter without continuity review writes, broad UPDATE or role creation',async()=>{
  const f=fixture();await grantContinuityAdoptionRole(f.pool,'continuity_adopter');const sql=f.query.mock.calls.map(call=>call[0]).join('\n');
  expect(sql).toContain('GRANT SELECT,INSERT ON camery_continuity.native_bindings,camery_continuity.native_adoptions');expect(sql).toContain('GRANT SELECT ON camery_continuity.candidates,camery_continuity.reviews,camery_versioning.projects');
  expect(sql).toContain('GRANT UPDATE(head_revision,write_version) ON camery_versioning.projects');expect(sql).toContain('GRANT UPDATE(status,record) ON camery_versioning.changes');
  expect(sql).toContain('GRANT USAGE ON SEQUENCE');expect(sql).not.toContain('CREATE ROLE');expect(sql).not.toContain('GRANT UPDATE ON');expect(f.release).toHaveBeenCalledWith(false);
});
it('requires explicit native reader mode and keeps old reviewer grants intact',async()=>{
  const f=fixture();await grantContinuityRuntimeRole(f.pool,'continuity_reviewer',{nativeProofs:true});expect(f.query.mock.calls.some(call=>call[0].includes('GRANT SELECT ON')&&call[0].includes('camery_continuity.native_bindings'))).toBe(true);
  f.query.mockClear();await verifyContinuityRuntimeRole(f.pool,{nativeProofs:true});expect(f.query.mock.calls[0]![0]).toContain("'native_bindings'");
  f.query.mockClear();await verifyContinuityRuntimeRole(f.pool);expect(f.query.mock.calls[0]![0]).not.toContain("'native_bindings'");
});
it.each(['','UPPER','role;DROP','a'.repeat(64)])('rejects unsafe role names before accessing a connection %#',async role=>{const f=fixture();await expect(grantContinuityAdoptionRole(f.pool,role)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.connect).not.toHaveBeenCalled();});
it('rejects malformed sequence identities without issuing sequence grants',async()=>{
  const f=fixture();f.query.mockResolvedValue({rows:[{changes:'public.sequence',history:'camery_versioning.sequence'}]} as never);await expect(grantContinuityAdoptionRole(f.pool,'continuity_adopter')).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.query.mock.calls.some(call=>call[0].startsWith('GRANT USAGE ON SEQUENCE'))).toBe(false);
});
it('verifies one literal true and normalizes unknown query failures',async()=>{
  const f=fixture();await verifyContinuityAdoptionRole(f.pool);f.state.allowed=false;await expect(verifyContinuityAdoptionRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});f.state.allowed=true;f.state.rows=0;await expect(verifyContinuityAdoptionRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
  f.query.mockRejectedValue(new Proxy({},{getPrototypeOf(){throw new Error('private');}}));await expect(verifyContinuityAdoptionRole(f.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});
});
it('handles asynchronous installer errors and always destroys broken connections',async()=>{
  const f=fixture();f.state.emitError=true;await expect(grantContinuityAdoptionRole(f.pool,'continuity_adopter')).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(f.release).toHaveBeenCalledWith(true);expect(f.client.listenerCount('error')).toBe(0);
});

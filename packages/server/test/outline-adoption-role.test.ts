import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {grantOutlineProjectAdoptionRole,verifyOutlineProjectAdoptionRole} from '../src/projects/outline-adoption-role.js';

type SequenceRow={changes:unknown;history:unknown};
function fixture(){
  const events=new EventEmitter(),state={sequences:[{changes:'camery_versioning.changes_sequence_seq',history:'camery_versioning.object_revisions_sequence_seq'}] as SequenceRow[],fail:'',error:new Error('private postgresql://credential'),disconnect:'',release:false};
  const query=vi.fn(async(sql:string)=>{
    if(state.fail&&sql.startsWith(state.fail))throw state.error;
    if(state.disconnect&&sql.startsWith(state.disconnect))events.emit('error',new Error('private disconnected credential'));
    return {rows:sql.startsWith('SELECT pg_get_serial_sequence')?state.sequences:[]};
  });
  const release=vi.fn((_destroy?:boolean)=>{if(state.release)throw new Error('private release credential');});
  const client=Object.assign(events,{query,release}),connect=vi.fn(async()=>client);
  return {state,query,client,release,connect,pool:{connect} as unknown as Pool};
}
const sqlOf=(f:ReturnType<typeof fixture>)=>f.query.mock.calls.map(([sql])=>sql);
async function refused(action:Promise<unknown>,code='STORAGE_FAILED'){
  let caught:unknown;try{await action;}catch(error){caught=error;}
  expect(caught).toMatchObject({name:'ProjectIdentityError',code});expect(String(caught)).not.toContain('private');
}

it('grants source reads, append-only evidence and exactly the native mutable columns in one transaction',async()=>{
  const f=fixture();await grantOutlineProjectAdoptionRole(f.pool,'outline_adopter');const sql=sqlOf(f),grants=sql.filter(value=>value.startsWith('GRANT'));
  expect(sql[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');expect(sql.at(-1)).toBe('COMMIT');
  for(const table of ['camery_outline.briefs','camery_outline.runs','camery_outline.candidates','camery_outline.reviews','camery_script.briefs','camery_script.runs','camery_script.candidates','camery_script.reviews','camery_script.run_origins','camery_bible.runs','camery_bible.chunks','camery_bible.candidates','camery_bible.reviews','camery_ingest.documents','camery_ingest.scripts','camery_projects.tenants','camery_projects.projects','camery_projects.principals']){
    const tableGrants=grants.filter(value=>value.includes(' ON '+table+' TO '));expect(tableGrants).toEqual([`GRANT SELECT ON ${table} TO "outline_adopter"`]);
  }
  for(const table of ['camery_script.ir_identities','camery_outline.identity_preparations','camery_projects.outline_candidate_intents','camery_projects.outline_candidate_receipts','camery_projects.outline_decision_intents','camery_projects.outline_decision_receipts','camery_versioning.snapshots','camery_versioning.changes','camery_versioning.object_revisions','camery_versioning.adoptions'])expect(grants).toContain(`GRANT SELECT,INSERT ON ${table} TO "outline_adopter"`);
  expect(grants.filter(value=>value.startsWith('GRANT UPDATE'))).toEqual(['GRANT UPDATE(head_revision,write_version) ON camery_versioning.projects TO "outline_adopter"','GRANT UPDATE(status,record) ON camery_versioning.changes TO "outline_adopter"']);
  expect(grants.filter(value=>value.includes('ON SEQUENCE'))).toEqual(['GRANT USAGE ON SEQUENCE "camery_versioning"."changes_sequence_seq","camery_versioning"."object_revisions_sequence_seq" TO "outline_adopter"']);
  expect(grants.join('\n')).not.toMatch(/\b(?:DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL|CREATE|ALTER)\b|WITH GRANT OPTION|camery_(?:access|agents|durable)|\.migrations\b/);
  expect(f.release).toHaveBeenCalledWith(false);expect(f.client.listenerCount('error')).toBe(0);
});
it.each(['','Outline_adopter','outline_adopter\n','x;DROP ROLE x','a'.repeat(64)])('rejects unsafe installer role %j before checkout',async role=>{
  const f=fixture();await refused(grantOutlineProjectAdoptionRole(f.pool,role),'INVALID_INPUT');expect(f.connect).not.toHaveBeenCalled();
});
it.each([null,undefined,'other_schema.sequence','camery_versioning.bad;sequence','camery_versioning.sequence\n','camery_versioning.changes_sequence_seq'])('refuses a missing, unsafe or aliased history sequence %j before any grant',async history=>{
  const f=fixture();f.state.sequences=[{changes:'camery_versioning.changes_sequence_seq',history}];await refused(grantOutlineProjectAdoptionRole(f.pool,'outline_adopter'));expect(sqlOf(f).some(sql=>sql.startsWith('GRANT'))).toBe(false);expect(sqlOf(f).at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledWith(false);
});
it.each([{sequences:[]},{sequences:[{changes:null,history:'camery_versioning.object_revisions_sequence_seq'}]},{sequences:[{changes:'camery_versioning.changes_sequence_seq',history:'camery_versioning.object_revisions_sequence_seq'},{changes:'camery_versioning.changes_sequence_seq',history:'camery_versioning.object_revisions_sequence_seq'}]}])('refuses incomplete or ambiguous sequence authority',async({sequences})=>{
  const f=fixture();f.state.sequences=sequences;await refused(grantOutlineProjectAdoptionRole(f.pool,'outline_adopter'));expect(sqlOf(f).some(sql=>sql.startsWith('GRANT'))).toBe(false);
});
it.each(['BEGIN','GRANT SELECT ON camery_outline.runs','COMMIT'])('rolls installer transaction back after %s driver failure',async prefix=>{
  const f=fixture();f.state.fail=prefix;await refused(grantOutlineProjectAdoptionRole(f.pool,'outline_adopter'));expect(sqlOf(f).at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledOnce();expect(f.client.listenerCount('error')).toBe(0);
});
it('destroys a disconnected installer connection and never commits its attempted grants',async()=>{
  const f=fixture();f.state.disconnect='GRANT SELECT ON camery_outline.runs';await refused(grantOutlineProjectAdoptionRole(f.pool,'outline_adopter'));expect(sqlOf(f)).not.toContain('COMMIT');expect(sqlOf(f).at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledWith(true);expect(f.client.listenerCount('error')).toBe(0);
});
it('redacts rollback and release failures while always dropping the installer error listener',async()=>{
  const rollback=fixture();rollback.state.fail='ROLLBACK';rollback.query.mockRejectedValueOnce(new Error('private begin'));await refused(grantOutlineProjectAdoptionRole(rollback.pool,'outline_adopter'));expect(rollback.release).toHaveBeenCalledWith(true);expect(rollback.client.listenerCount('error')).toBe(0);
  const release=fixture();release.state.release=true;await refused(grantOutlineProjectAdoptionRole(release.pool,'outline_adopter'));expect(release.release).toHaveBeenCalledOnce();expect(release.client.listenerCount('error')).toBe(0);
});
it('reports failed checkout without releasing an unowned installer connection',async()=>{
  for(const sync of [false,true]){const f=fixture();if(sync)f.connect.mockImplementationOnce(()=>{throw new Error('private synchronous connection');});else f.connect.mockRejectedValueOnce(new Error('private async connection'));await refused(grantOutlineProjectAdoptionRole(f.pool,'outline_adopter'));expect(f.release).not.toHaveBeenCalled();}
});
it('keeps primitive and accessor driver failures behind the safe installer boundary',async()=>{
  const getter=vi.fn(()=>{throw new Error('private code accessor');});
  for(const error of ['private primitive',Object.defineProperty({},'code',{get:getter})]){const f=fixture();f.query.mockRejectedValueOnce(error);await refused(grantOutlineProjectAdoptionRole(f.pool,'outline_adopter'));expect(f.release).toHaveBeenCalledOnce();}
  expect(getter).not.toHaveBeenCalled();
});
it('redacts an opaque installer exception even when its prototype trap throws private text',async()=>{
  const f=fixture(),opaque=new Proxy({},{getPrototypeOf(){throw new Error('private prototype trap');}});f.query.mockRejectedValueOnce(opaque);
  await refused(grantOutlineProjectAdoptionRole(f.pool,'outline_adopter'));expect(f.release).toHaveBeenCalledOnce();expect(f.client.listenerCount('error')).toBe(0);
});
it('requires the effective LOGIN closure including inherited and column capabilities instead of provisioning at runtime',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[{allowed:true}]}),connect=vi.fn();await verifyOutlineProjectAdoptionRole({query,connect} as unknown as Pool);expect(connect).not.toHaveBeenCalled();expect(query).toHaveBeenCalledOnce();
  const sql=query.mock.calls[0]![0] as string;
  for(const term of ['rolcanlogin','rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolinherit','rolreplication','session_user=current_user','pg_has_role','MEMBER','pg_attribute','has_column_privilege','has_table_privilege','has_schema_privilege','has_sequence_privilege','WITH GRANT OPTION','c.relowner=r.oid','n.nspowner=r.oid'])expect(sql).toContain(term);
  expect(sql).toContain("n.nspname !~ '^pg_'");expect(sql).toContain("a.table_name IS NULL");expect(sql).toContain('head_revision');expect(sql).toContain('write_version');expect(sql).toContain("IN ('status','record')");expect(sql).toContain('pg_get_serial_sequence');
  expect(sql).not.toMatch(/^\s*(?:GRANT|CREATE ROLE|ALTER ROLE)\s/m);
});
it.each([{rows:[]},{rows:[{allowed:false}]},{rows:[{allowed:null}]},{rows:[{allowed:'true'}]},{rows:[{}]}])('fails closed when the effective-role verifier does not return literal true',async({rows})=>{
  const query=vi.fn().mockResolvedValue({rows});await refused(verifyOutlineProjectAdoptionRole({query} as unknown as Pool));expect(query).toHaveBeenCalledOnce();
});
it('redacts unavailable effective-role verification including an opaque driver exception',async()=>{
  const opaque=new Proxy({},{getPrototypeOf(){throw new Error('private prototype');}});
  for(const error of [new Error('private postgresql://credential'),'private primitive',opaque]){const query=vi.fn().mockRejectedValue(error);await refused(verifyOutlineProjectAdoptionRole({query} as unknown as Pool));}
});

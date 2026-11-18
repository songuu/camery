import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {migrateOutlineProjectIntents} from '../src/projects/outline-intent-migrate.js';

type MigrationRow={version:number;checksum:string};
async function fixture(){
  const paths=['../src/projects/migrations/0001-identity-bindings.sql','../src/projects/migrations/0002-application-intents.sql','../src/projects/migrations/0003-candidate-catalog.sql','../../script/src/outline/node/identity-migrations/0001-outline-ir-identities.sql','../src/projects/outline-intent-migrations/0001-outline-intents.sql'];
  const files=await Promise.all(paths.map(async path=>{const sql=await readFile(new URL(path,import.meta.url),'utf8');return {sql,checksum:createHash('sha256').update(sql,'utf8').digest('hex')};}));
  const state={projects:files.slice(0,3).map((file,i)=>({version:i+1,checksum:file.checksum})),identities:[{version:1,checksum:files[3]!.checksum}],extension:[] as MigrationRow[],exists:{projects:true,identities:true},fail:'',release:false,disconnect:false};
  const emitter=new EventEmitter();let snapshot:MigrationRow[]=[];
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(sql===state.fail)throw new Error('private credential');
    if(sql.startsWith('BEGIN'))snapshot=structuredClone(state.extension);
    if(sql==='ROLLBACK')state.extension=structuredClone(snapshot);
    if(sql.includes('to_regclass'))return {rows:[{...state.exists}]};
    if(sql==='SELECT version,checksum FROM camery_projects.migrations ORDER BY version')return {rows:structuredClone(state.projects)};
    if(sql==='SELECT version,checksum FROM camery_outline.identity_migrations ORDER BY version')return {rows:structuredClone(state.identities)};
    if(sql==='SELECT version,checksum FROM camery_projects.outline_migrations ORDER BY version')return {rows:structuredClone(state.extension)};
    if(sql.startsWith('INSERT INTO camery_projects.outline_migrations'))state.extension.push({version:values[0] as number,checksum:values[1] as string});
    if(sql===files[4]!.sql&&state.disconnect)emitter.emit('error',new Error('private backend'));
    return {rows:[]};
  });
  const release=vi.fn((_destroy?:boolean)=>{if(state.release)throw new Error('private release');});
  const client=Object.assign(emitter,{query,release}),connect=vi.fn(async()=>client);
  return {state,files,query,release,client,connect,pool:{connect} as unknown as Pool};
}

it('installs the dedicated v1 ledger explicitly after immutable prerequisites, without grants or changing source ledgers',async()=>{
  const f=await fixture(),original=structuredClone({projects:f.state.projects,identities:f.state.identities});
  await migrateOutlineProjectIntents(f.pool);
  expect(f.state.extension).toEqual([{version:1,checksum:f.files[4]!.checksum}]);
  expect(f.query.mock.calls.filter(([sql])=>sql===f.files[4]!.sql)).toHaveLength(1);
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('CREATE TABLE IF NOT EXISTS camery_projects.outline_migrations'))).toBe(true);
  expect(f.query.mock.calls.some(([sql])=>/\bGRANT\b/i.test(sql))).toBe(false);
  expect(f.query.mock.calls.some(([sql])=>f.files.slice(0,4).some(file=>file.sql===sql))).toBe(false);
  expect({projects:f.state.projects,identities:f.state.identities}).toEqual(original);
  await migrateOutlineProjectIntents(f.pool);
  expect(f.query.mock.calls.filter(([sql])=>sql===f.files[4]!.sql)).toHaveLength(1);
  expect(f.release).toHaveBeenCalledTimes(2);expect(f.release).toHaveBeenLastCalledWith(false);
  expect(f.client.listenerCount('error')).toBe(0);
});

it('takes shared migration locks in script, outline, projects order before inspecting prerequisites',async()=>{
  const f=await fixture();await migrateOutlineProjectIntents(f.pool);
  const calls=f.query.mock.calls,locks=calls.filter(([sql])=>sql.includes('pg_advisory_xact_lock'));
  expect(locks).toEqual(['camery_script','camery_outline','camery_projects'].map(schema=>['SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[schema+':migrations']]));
  expect(calls.findIndex(([sql])=>sql.includes('to_regclass'))).toBeGreaterThan(calls.findLastIndex(([sql])=>sql.includes('pg_advisory_xact_lock')));
});

it.each(['projects','identities'] as const)('requires the existing %s ledger without creating source schemas',async domain=>{
  const f=await fixture();f.state.exists[domain]=false;
  await expect(migrateOutlineProjectIntents(f.pool)).rejects.toMatchObject({code:'SCHEMA_UPGRADE_REQUIRED'});
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('CREATE'))).toBe(false);
  expect(f.release).toHaveBeenCalledWith(false);expect(f.client.listenerCount('error')).toBe(0);
});

it.each(['projects','identities'] as const)('requires the complete %s prerequisite and does not run old installers',async domain=>{
  const f=await fixture();f.state[domain].pop();
  await expect(migrateOutlineProjectIntents(f.pool)).rejects.toMatchObject({code:'SCHEMA_UPGRADE_REQUIRED'});
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('CREATE'))).toBe(false);
  expect(f.query.mock.calls.some(([sql])=>f.files.some(file=>file.sql===sql))).toBe(false);
  expect(f.state.extension).toEqual([]);
});

it.each(['projects','identities'] as const)('refuses forged, out-of-order and extra %s prerequisite rows',async domain=>{
  for(const mode of ['checksum','version','extra'] as const){
    const f=await fixture();
    if(mode==='checksum')f.state[domain][0]!.checksum='0'.repeat(64);
    if(mode==='version')f.state[domain][0]!.version=2;
    if(mode==='extra')f.state[domain].push({version:f.state[domain].length+1,checksum:'0'.repeat(64)});
    await expect(migrateOutlineProjectIntents(f.pool)).rejects.toMatchObject({code:'CONFLICT'});
    expect(f.query.mock.calls.some(([sql])=>sql.startsWith('CREATE'))).toBe(false);
    expect(f.query.mock.calls.some(([sql])=>sql===f.files[4]!.sql)).toBe(false);
  }
});

it.each([0,1,2])('checks the actual source checksum of projects prerequisite row %i',async index=>{
  const f=await fixture();f.state.projects[index]!.checksum='f'.repeat(64);
  await expect(migrateOutlineProjectIntents(f.pool)).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('CREATE'))).toBe(false);
  expect(f.state.extension).toEqual([]);
});

it.each(['checksum','version','extra'] as const)('refuses a corrupt dedicated %s ledger without rerunning DDL',async mode=>{
  const f=await fixture();f.state.extension=[{version:1,checksum:f.files[4]!.checksum}];
  if(mode==='checksum')f.state.extension[0]!.checksum='0'.repeat(64);
  if(mode==='version')f.state.extension[0]!.version=2;
  if(mode==='extra')f.state.extension.push({version:2,checksum:'0'.repeat(64)});
  await expect(migrateOutlineProjectIntents(f.pool)).rejects.toMatchObject({code:'CONFLICT'});
  expect(f.query.mock.calls.some(([sql])=>sql===f.files[4]!.sql)).toBe(false);
});

it.each(['query','commit','rollback','release','disconnect','connection'] as const)('redacts %s failures, rolls back and releases only the owned connection',async mode=>{
  const f=await fixture();
  if(mode==='query')f.state.fail=f.files[4]!.sql;
  if(mode==='commit')f.state.fail='COMMIT';
  if(mode==='rollback'){f.state.fail='ROLLBACK';f.state.projects=[];}
  if(mode==='release')f.state.release=true;
  if(mode==='disconnect')f.state.disconnect=true;
  if(mode==='connection')f.connect.mockRejectedValueOnce(new Error('private login'));
  const error=await migrateOutlineProjectIntents(f.pool).then(()=>undefined,(failure:unknown)=>failure);
  expect(error).toMatchObject({code:'STORAGE_FAILED'});expect(String(error)).not.toContain('private');
  expect(f.release).toHaveBeenCalledTimes(mode==='connection'?0:1);expect(f.client.listenerCount('error')).toBe(0);
  if(mode==='rollback'||mode==='disconnect')expect(f.release).toHaveBeenCalledWith(true);
  if(mode==='query'||mode==='commit'||mode==='disconnect'){
    expect(f.query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(true);expect(f.state.extension).toEqual([]);
  }
});

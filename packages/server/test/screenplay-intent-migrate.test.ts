import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {expect,it,vi} from 'vitest';
import {migrateScreenplayProjectIntents} from '../src/projects/screenplay-intent-migrate.js';

async function fixture(){
  const paths=['../src/projects/migrations/0001-identity-bindings.sql','../src/projects/migrations/0002-application-intents.sql','../src/projects/migrations/0003-candidate-catalog.sql','../../script/src/screenplay/node/migrations/0001-screenplay.sql','../src/projects/screenplay-intent-migrations/0001-screenplay-intents.sql'];
  const files=await Promise.all(paths.map(async path=>{const sql=await readFile(new URL(path,import.meta.url),'utf8');return {sql,checksum:createHash('sha256').update(sql).digest('hex')};}));
  const projects=files.slice(0,3).map((row,index)=>({version:index+1,checksum:row.checksum})),screenplay=[{version:1,checksum:files[3]!.checksum}],extension=[] as {version:number;checksum:string}[];
  const state={projects,screenplay,extension,ready:true,fail:'',disconnect:false};let prior=structuredClone(extension);const client=new EventEmitter();
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(sql===state.fail)throw new Error('private installer secret');if(sql==='BEGIN')prior=structuredClone(state.extension);if(sql==='ROLLBACK')state.extension=prior;
    if(sql.includes('to_regclass'))return {rows:[{ready:state.ready}]};
    if(sql==='SELECT version,checksum FROM camery_projects.migrations ORDER BY version')return {rows:state.projects};
    if(sql==='SELECT version,checksum FROM camery_screenplay.migrations ORDER BY version')return {rows:state.screenplay};
    if(sql==='SELECT version,checksum FROM camery_projects.screenplay_migrations ORDER BY version')return {rows:state.extension};
    if(sql===files[4]!.sql&&state.disconnect)client.emit('error',new Error('private installer disconnected'));
    if(sql.startsWith('INSERT INTO camery_projects.screenplay_migrations'))state.extension.push({version:values[0] as number,checksum:values[1] as string});return {rows:[]};
  });
  const release=vi.fn(),connection=Object.assign(client,{query,release}),pool={connect:vi.fn(async()=>connection)} as unknown as Pool;
  return {state,files,pool,query,release};
}
it('installs the source journal explicitly once and preserves the actual predecessor migration checksums',async()=>{
  const f=await fixture();await migrateScreenplayProjectIntents(f.pool);await migrateScreenplayProjectIntents(f.pool);expect(f.state.extension).toEqual([{version:1,checksum:f.files[4]!.checksum}]);expect(f.query.mock.calls.filter(([sql])=>sql===f.files[4]!.sql)).toHaveLength(1);expect(f.release).toHaveBeenCalledTimes(2);
});
it.each(['missing','projects-short','projects-hash','screenplay-short','screenplay-hash','applied-hash'] as const)('refuses %s before altering source journal state',async mode=>{
  const f=await fixture();if(mode==='missing')f.state.ready=false;if(mode==='projects-short')f.state.projects.pop();if(mode==='projects-hash')f.state.projects[0]!.checksum='wrong';if(mode==='screenplay-short')f.state.screenplay=[];if(mode==='screenplay-hash')f.state.screenplay[0]!.checksum='wrong';if(mode==='applied-hash')f.state.extension=[{version:1,checksum:'wrong'}];
  await expect(migrateScreenplayProjectIntents(f.pool)).rejects.toMatchObject({code:mode==='missing'||mode.endsWith('short')?'SCHEMA_UPGRADE_REQUIRED':'CONFLICT'});expect(f.query.mock.calls.some(([sql])=>sql===f.files[4]!.sql)).toBe(false);expect(f.query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(false);
});
it('rolls back installer failure and disconnect without exposing driver messages or leaking a connection',async()=>{
  for(const disconnected of [false,true]){const f=await fixture();if(disconnected)f.state.disconnect=true;else f.state.fail=f.files[4]!.sql;await expect(migrateScreenplayProjectIntents(f.pool)).rejects.toThrow(expect.objectContaining({code:'STORAGE_FAILED'}));expect(f.state.extension).toEqual([]);expect(f.query.mock.calls.some(([sql])=>sql==='ROLLBACK')).toBe(true);expect(f.release).toHaveBeenCalledWith(disconnected);}
});

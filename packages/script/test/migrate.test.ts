import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect,it,vi } from 'vitest';
import type { Pool } from 'pg';
import { migrateDevelopment } from '../src/node/migrate.js';
const checksum=(version:1|2|3|4=1)=>createHash('sha256').update(readFileSync(new URL(`../src/node/migrations/${['0001-development.sql','0002-brief-runs.sql','0003-development-origins.sql','0004-development-ir-identities.sql'][version-1]}`,import.meta.url))).digest('hex');
function database(options:{applied?:unknown[];failure?:string;connect?:boolean;release?:boolean}={}){
  const release=vi.fn((destroy?:boolean)=>{if(options.release)throw new Error('private-release');return destroy;});
  const query=vi.fn(async(sql:string,_values?:unknown[])=>{if(options.failure&&sql.startsWith(options.failure))throw new Error('private-driver');return {rows:sql.startsWith('SELECT version')?options.applied??[]:[]};});
  const connect=vi.fn(async()=>{if(options.connect)throw new Error('private-login');return {query,release};});
  return {pool:{connect} as unknown as Pool,query,release,connect};
}
it('installs four ordered checksum migrations transactionally and reuses their exact applied versions',async()=>{
  const first=database();await migrateDevelopment(first.pool);
  expect(first.query.mock.calls.map(([sql])=>sql)).toContain('BEGIN');expect(first.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  expect(first.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO camery_script.migrations')).map(([,values])=>values)).toEqual([[1,checksum(1)],[2,checksum(2)],[3,checksum(3)],[4,checksum(4)]]);
  const sql=first.query.mock.calls.find(([value])=>value.includes('CREATE TABLE camery_script.briefs'))?.[0];
  expect(sql).toContain('REFERENCES camery_script.briefs');expect(sql).toContain('REFERENCES camery_script.candidates');expect(sql).toContain('run_id COLLATE "C" DESC');
  expect(first.release).toHaveBeenCalledOnce();
  expect(first.query.mock.calls.some(([value])=>value.includes('CREATE INDEX development_runs_brief_idx'))).toBe(true);
  expect(first.query.mock.calls.some(([value])=>value.includes('CREATE TABLE camery_script.run_origins'))).toBe(true);
  expect(first.query.mock.calls.some(([value])=>value.includes('CREATE TABLE camery_script.ir_identities'))).toBe(true);
  const retry=database({applied:[{version:1,checksum:checksum(1)},{version:2,checksum:checksum(2)},{version:3,checksum:checksum(3)},{version:4,checksum:checksum(4)}]});await migrateDevelopment(retry.pool);
  expect(retry.query.mock.calls.some(([value])=>value.includes('CREATE TABLE camery_script.briefs'))).toBe(false);
  expect(retry.query.mock.calls.some(([value])=>value.startsWith('INSERT INTO camery_script.migrations'))).toBe(false);
});
it('increments a valid version-one installation without reapplying its table definitions or checksum',async()=>{
  const db=database({applied:[{version:1,checksum:checksum(1)}]});await migrateDevelopment(db.pool);
  expect(db.query.mock.calls.some(([value])=>value.includes('CREATE TABLE camery_script.briefs'))).toBe(false);
  expect(db.query.mock.calls.some(([value])=>value.includes('CREATE INDEX development_runs_brief_idx'))).toBe(true);
  expect(db.query.mock.calls.filter(([value])=>value.startsWith('INSERT INTO camery_script.migrations')).map(([,values])=>values)).toEqual([[2,checksum(2)],[3,checksum(3)],[4,checksum(4)]]);
});
it('adds only the local identity table to an existing three-migration installation',async()=>{
  const db=database({applied:[{version:1,checksum:checksum(1)},{version:2,checksum:checksum(2)},{version:3,checksum:checksum(3)}]});await migrateDevelopment(db.pool);
  expect(db.query.mock.calls.some(([value])=>value.includes('CREATE TABLE camery_script.briefs'))).toBe(false);expect(db.query.mock.calls.some(([value])=>value.includes('CREATE TABLE camery_script.run_origins'))).toBe(false);
  expect(db.query.mock.calls.filter(([value])=>value.startsWith('INSERT INTO camery_script.migrations')).map(([,values])=>values)).toEqual([[4,checksum(4)]]);
});
it.each([{applied:[{version:1,checksum:'changed'}]},{applied:[{version:2,checksum:checksum(2)}]},{applied:[{version:1,checksum:checksum(1)},{version:2,checksum:'changed'}]},
  {applied:[{version:1,checksum:checksum(1)},{version:2,checksum:checksum(2)},{version:3,checksum:'changed'}]},
  {applied:[{version:1,checksum:checksum(1)},{version:2,checksum:checksum(2)},{version:3,checksum:checksum(3)},{version:4,checksum:'changed'}]},
  {applied:[{version:1,checksum:checksum(1)},{version:2,checksum:checksum(2)},{version:3,checksum:checksum(3)},{version:4,checksum:checksum(4)},{version:5,checksum:'unknown'}]}])('rejects altered, gapped or unknown migration history %#',async({applied})=>{
  const db=database({applied});await expect(migrateDevelopment(db.pool)).rejects.toMatchObject({code:'CONFLICT'});expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
});
it.each(['BEGIN','SELECT pg_advisory','CREATE SCHEMA','CREATE TABLE IF NOT EXISTS','SELECT version','CREATE TABLE camery_script.briefs','-- Cover the referencing side','-- References retain','-- Append-only source-local','INSERT INTO camery_script.migrations','COMMIT'])('redacts migration driver failure at %s',async failure=>{
  const db=database({failure});await expect(migrateDevelopment(db.pool)).rejects.toMatchObject({code:'STORAGE_FAILED'});expect(db.release).toHaveBeenCalledOnce();
});
it('redacts connection, rollback and release failures and destroys the connection after failed rollback',async()=>{
  await expect(migrateDevelopment(database({connect:true}).pool)).rejects.toThrow('migration connection');
  const db=database({applied:[{version:2,checksum:'x'}],failure:'ROLLBACK'});await expect(migrateDevelopment(db.pool)).rejects.toThrow('migration rollback');expect(db.release).toHaveBeenCalledWith(true);
  await expect(migrateDevelopment(database({release:true}).pool)).rejects.toThrow('migration release');
});

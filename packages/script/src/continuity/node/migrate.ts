import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {ContinuityError} from '../contracts.js';

/** Explicit installation only; native version history must already have its own successful installation. */
export async function migrateContinuity(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ContinuityError('STORAGE_FAILED','migration connection','migration');}
  let destroy=false,known:ContinuityError|undefined;
  const refuse=(code:'INCOMPLETE'|'CONFLICT',operation:string):never=>{known=new ContinuityError(code,operation,'migration');throw known;};
  try{
    const sql=await readFile(new URL('./migrations/0001-continuity.sql',import.meta.url),'utf8'),checksum=createHash('sha256').update(sql,'utf8').digest('hex');
    if(sql.includes('\r'))refuse('CONFLICT','migration bytes');
    await client.query('BEGIN');await client.query('SET LOCAL search_path = pg_catalog');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_continuity:migrations',0))");
    const prerequisites=await client.query<{snapshots_ready:boolean;projects_ready:boolean}>("SELECT to_regclass('camery_versioning.snapshots') IS NOT NULL AS snapshots_ready,to_regclass('camery_versioning.projects') IS NOT NULL AS projects_ready");
    if(prerequisites.rows.length!==1||prerequisites.rows[0]?.snapshots_ready!==true||prerequisites.rows[0]?.projects_ready!==true)refuse('INCOMPLETE','native versioning prerequisite');
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_continuity');await client.query('CREATE TABLE IF NOT EXISTS camery_continuity.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const result=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_continuity.migrations ORDER BY version');
    if(result.rows.length>1||result.rows.some(row=>row.version!==1||row.checksum!==checksum))refuse('CONFLICT','migration checksum');
    if(result.rows.length===0){await client.query(sql);await client.query('INSERT INTO camery_continuity.migrations(version,checksum) VALUES($1,$2)',[1,checksum]);}
    await client.query('COMMIT');
  }catch{
    try{await client.query('ROLLBACK');}catch{destroy=true;throw new ContinuityError('STORAGE_FAILED','migration rollback','migration');}
    throw known??new ContinuityError('STORAGE_FAILED','migration','migration');
  }
  // oxlint-disable-next-line eslint/no-unsafe-finally -- Installation must release even when the database fails; dependency diagnostics never cross this boundary.
  finally{try{client.release(destroy);}catch{throw new ContinuityError('STORAGE_FAILED','migration release','migration');}}
}

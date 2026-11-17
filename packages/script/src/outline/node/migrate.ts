import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool,PoolClient } from 'pg';
import { OutlineError } from '../contracts.js';

/** Explicit trusted installer. Runtime constructors never migrate or grant capabilities. */
export async function migrateOutline(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new OutlineError('STORAGE_FAILED','migration connection','migration');}let destroy=false;
  try{
    const sql=await readFile(new URL('./migrations/0001-outline.sql',import.meta.url),'utf8'),checksum=createHash('sha256').update(sql,'utf8').digest('hex');
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_outline:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_outline');await client.query('CREATE TABLE IF NOT EXISTS camery_outline.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const rows=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_outline.migrations ORDER BY version');
    if(rows.rows.length>1||rows.rows.some(row=>row.version!==1||row.checksum!==checksum))throw new OutlineError('CONFLICT','migration checksum','migration');
    if(rows.rows.length===0){await client.query(sql);await client.query('INSERT INTO camery_outline.migrations(version,checksum) VALUES($1,$2)',[1,checksum]);}
    await client.query('COMMIT');
  }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;throw new OutlineError('STORAGE_FAILED','migration rollback','migration');}if(error instanceof OutlineError)throw error;throw new OutlineError('STORAGE_FAILED','migration','migration');}
  // oxlint-disable-next-line eslint/no-unsafe-finally -- Never expose credential-bearing driver errors after an installer action.
  finally{try{client.release(destroy);}catch{throw new OutlineError('STORAGE_FAILED','migration release','migration');}}
}

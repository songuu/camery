import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { DevelopmentError } from '../contracts.js';

/** Explicit installer only: runtime repositories never install schemas or grant their own capabilities. */
export async function migrateDevelopment(pool:Pool):Promise<void>{
  const client=await pool.connect().catch(()=>{throw new DevelopmentError('STORAGE_FAILED','migration connection');});let destroy=false;
  try{
    const migrations=await Promise.all(['0001-development.sql','0002-brief-runs.sql','0003-development-origins.sql','0004-development-ir-identities.sql'].map(async(name,index)=>{const sql=await readFile(new URL('./migrations/'+name,import.meta.url),'utf8');return {version:index+1,sql,checksum:createHash('sha256').update(sql,'utf8').digest('hex')};}));
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_script:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_script');await client.query('CREATE TABLE IF NOT EXISTS camery_script.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const applied=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_script.migrations ORDER BY version');
    if(applied.rows.length>migrations.length||applied.rows.some((row,index)=>row.version!==migrations[index]!.version||row.checksum!==migrations[index]!.checksum))throw new DevelopmentError('CONFLICT','migration checksum');
    for(const migration of migrations.slice(applied.rows.length)){await client.query(migration.sql);await client.query('INSERT INTO camery_script.migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
    await client.query('COMMIT');
  }catch(error){
    try{await client.query('ROLLBACK');}catch{destroy=true;throw new DevelopmentError('STORAGE_FAILED','migration rollback');}
    if(error instanceof DevelopmentError)throw error;throw new DevelopmentError('STORAGE_FAILED','migration');
  // oxlint-disable-next-line eslint/no-unsafe-finally -- A release failure must not expose credential-bearing driver details.
  }finally{try{client.release(destroy);}catch{throw new DevelopmentError('STORAGE_FAILED','migration release');}}
}

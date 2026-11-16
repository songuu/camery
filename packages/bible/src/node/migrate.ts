import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { BibleError } from '../contracts.js';
import { textHash } from '../data.js';
/** Explicit installer only. Runtime construction never migrates a schema or grants itself privileges. */
export async function migrateBible(pool:Pool):Promise<void> {
  const client=await pool.connect().catch(()=>{throw new BibleError('STORAGE_FAILED','migration connection');});
  try {
    const migrations=await Promise.all(['0001-bible.sql','0002-catalog.sql'].map(async(name,index)=>{const sql=await readFile(new URL('./migrations/'+name,import.meta.url),'utf8');return {version:index+1,sql,checksum:textHash(sql)};}));
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_bible:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_bible');
    await client.query('CREATE TABLE IF NOT EXISTS camery_bible.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const applied=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_bible.migrations ORDER BY version');
    if(applied.rows.length>migrations.length||applied.rows.some((row,index)=>row.version!==migrations[index]!.version||row.checksum!==migrations[index]!.checksum))throw new BibleError('CONFLICT','migration checksum');
    for(const migration of migrations.slice(applied.rows.length)){await client.query(migration.sql);await client.query('INSERT INTO camery_bible.migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
    await client.query('COMMIT');
  } catch(error) {
    try{await client.query('ROLLBACK');}catch{throw new BibleError('STORAGE_FAILED','migration rollback');}
    if(error instanceof BibleError)throw error;throw new BibleError('STORAGE_FAILED','migration');
  } finally {client.release();}
}

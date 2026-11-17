import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {ProjectIdentityError} from './contracts.js';
import {identityTransaction} from './identity-map.js';

/** Explicit installation after the versioning schema; no runtime resolver calls this function. */
export async function migrateProjectIdentities(pool:Pool):Promise<void>{
  await identityTransaction(pool,'identity migration',async client=>{
    const sql=await readFile(new URL('./migrations/0001-identity-bindings.sql',import.meta.url),'utf8');const checksum=createHash('sha256').update(sql,'utf8').digest('hex');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_projects:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_projects');await client.query('CREATE TABLE IF NOT EXISTS camery_projects.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const result=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_projects.migrations ORDER BY version');
    if(result.rows.length>1||result.rows.some(row=>row.version!==1||row.checksum!==checksum))throw new ProjectIdentityError('BINDING_CONFLICT','identity migration checksum');
    if(!result.rows.length){await client.query(sql);await client.query('INSERT INTO camery_projects.migrations(version,checksum) VALUES($1,$2)',[1,checksum]);}
  });
}

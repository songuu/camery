import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool} from 'pg';
import {ProjectIdentityError} from './contracts.js';
import {identityTransaction} from './identity-map.js';

/** Explicit installation after the versioning schema; no runtime resolver calls this function. */
export async function migrateProjectIdentities(pool:Pool):Promise<void>{
  await identityTransaction(pool,'identity migration',async client=>{
    const migrations=await Promise.all(['0001-identity-bindings.sql','0002-application-intents.sql','0003-candidate-catalog.sql'].map(async(name,index)=>{const sql=await readFile(new URL('./migrations/'+name,import.meta.url),'utf8');return {version:index+1,sql,checksum:createHash('sha256').update(sql,'utf8').digest('hex')};}));
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_projects:migrations',0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_projects');await client.query('CREATE TABLE IF NOT EXISTS camery_projects.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const result=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_projects.migrations ORDER BY version');
    if(result.rows.length>migrations.length||result.rows.some((row,index)=>row.version!==migrations[index]!.version||row.checksum!==migrations[index]!.checksum))throw new ProjectIdentityError('BINDING_CONFLICT','identity migration checksum');
    for(const migration of migrations.slice(result.rows.length)){await client.query(migration.sql);await client.query('INSERT INTO camery_projects.migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
  });
}

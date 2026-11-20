import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {ProjectApplicationError} from './intent-contracts.js';

type Migration={version:number;sql:string;checksum:string};
const failed=(operation:string):never=>{throw new ProjectApplicationError('STORAGE_FAILED',operation);};
async function migration(path:string,version:number):Promise<Migration>{const sql=await readFile(new URL(path,import.meta.url),'utf8');if(sql.includes('\r'))throw new ProjectApplicationError('CONFLICT','screenplay journal migration bytes');return {version,sql,checksum:createHash('sha256').update(sql).digest('hex')};}
function requireInstalled(rows:{version:number;checksum:string}[],expected:Migration[]):void{
  if(rows.length<expected.length)throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','screenplay journal prerequisites');
  if(rows.length!==expected.length||rows.some((row,index)=>row.version!==expected[index]?.version||row.checksum!==expected[index]?.checksum))throw new ProjectApplicationError('CONFLICT','screenplay journal prerequisite checksum');
}
/** Explicit installation after existing project and SC migrations; runtime requests never install or grant. */
export async function migrateScreenplayProjectIntents(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{return failed('screenplay journal migration connection');}
  let broken=false,destroy=false;const onError=()=>{broken=true;destroy=true;},healthy=()=>{if(broken)failed('screenplay journal migration connection');};client.on('error',onError);
  try{
    const projects=await Promise.all(['0001-identity-bindings.sql','0002-application-intents.sql','0003-candidate-catalog.sql'].map((name,index)=>migration('./migrations/'+name,index+1)));
    const screenplay=await migration('../../../script/src/screenplay/node/migrations/0001-screenplay.sql',1),extension=await migration('./screenplay-intent-migrations/0001-screenplay-intents.sql',1);
    await client.query('BEGIN');await client.query('SET LOCAL search_path = pg_catalog');healthy();
    for(const namespace of ['camery_screenplay:migrations','camery_projects:migrations'])await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[namespace]);
    const installed=await client.query<{ready:boolean}>("SELECT to_regclass('camery_projects.migrations') IS NOT NULL AND to_regclass('camery_screenplay.migrations') IS NOT NULL AS ready");healthy();
    if(installed.rows.length!==1||installed.rows[0]?.ready!==true)throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','screenplay journal prerequisite schemas');
    requireInstalled((await client.query('SELECT version,checksum FROM camery_projects.migrations ORDER BY version')).rows,projects);
    requireInstalled((await client.query('SELECT version,checksum FROM camery_screenplay.migrations ORDER BY version')).rows,[screenplay]);
    await client.query('CREATE TABLE IF NOT EXISTS camery_projects.screenplay_migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const applied=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_projects.screenplay_migrations ORDER BY version');
    if(applied.rows.length>1||applied.rows.some(row=>row.version!==1||row.checksum!==extension.checksum))throw new ProjectApplicationError('CONFLICT','screenplay journal migration checksum');
    if(!applied.rows.length){await client.query(extension.sql);healthy();await client.query('INSERT INTO camery_projects.screenplay_migrations(version,checksum) VALUES($1,$2)',[1,extension.checksum]);}
    healthy();await client.query('COMMIT');healthy();
  }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;return failed('screenplay journal migration rollback');}healthy();if(error instanceof ProjectApplicationError)throw error;return failed('screenplay journal migration transaction');}
  finally{try{client.release(destroy);}catch{failed('screenplay journal migration release');}finally{client.off('error',onError);}}
}

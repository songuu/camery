import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {OutlineError} from '../contracts.js';
type Migration={version:number;sql:string;checksum:string};
function failure(operation:string):never{throw new OutlineError('STORAGE_FAILED',operation,'identity migration');}
async function migration(path:string,version:number):Promise<Migration>{const sql=await readFile(new URL(path,import.meta.url),'utf8');return {version,sql,checksum:createHash('sha256').update(sql,'utf8').digest('hex')};}
function prerequisite(rows:readonly {version:number;checksum:string}[],expected:readonly Migration[]):void{
  if(rows.some((row,index)=>row.version!==expected[index]?.version||row.checksum!==expected[index]?.checksum))throw new OutlineError('CONFLICT','prerequisite checksum','identity migration');
  if(rows.length!==expected.length)throw new OutlineError('INCOMPLETE','prerequisite installation','identity migration');
}
/** Explicit shared-metadata installer. It neither installs its source domains nor grants runtime privileges. */
export async function migrateOutlineIdentities(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{return failure('identity migration connection');}let destroy=false,disconnected=false;
  const onError=()=>{destroy=true;disconnected=true;},connected=()=>{if(disconnected)failure('identity migration connection');};client.on('error',onError);
  try{
    const development=await Promise.all(['0001-development.sql','0002-brief-runs.sql','0003-development-origins.sql','0004-development-ir-identities.sql'].map((name,index)=>migration('../../node/migrations/'+name,index+1)));
    const outline=await migration('./migrations/0001-outline.sql',1),extension=await migration('./identity-migrations/0001-outline-ir-identities.sql',1);
    await client.query('BEGIN');connected();
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_script:migrations',0))");connected();
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_outline:migrations',0))");connected();
    const installed=await client.query<{development:boolean;outline:boolean}>("SELECT to_regclass('camery_script.migrations') IS NOT NULL AS development,to_regclass('camery_outline.migrations') IS NOT NULL AS outline");connected();
    if(installed.rows.length!==1||installed.rows[0]!.development!==true||installed.rows[0]!.outline!==true)throw new OutlineError('INCOMPLETE','source schemas required','identity migration');
    const oldDevelopment=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_script.migrations ORDER BY version');connected();prerequisite(oldDevelopment.rows,development);
    const oldOutline=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_outline.migrations ORDER BY version');connected();prerequisite(oldOutline.rows,[outline]);
    await client.query('CREATE TABLE IF NOT EXISTS camery_outline.identity_migrations(version integer PRIMARY KEY,checksum text NOT NULL)');connected();
    const applied=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_outline.identity_migrations ORDER BY version');connected();
    if(applied.rows.length>1||applied.rows.some(row=>row.version!==extension.version||row.checksum!==extension.checksum))throw new OutlineError('CONFLICT','identity migration checksum','identity migration');
    if(!applied.rows.length){await client.query(extension.sql);connected();await client.query('INSERT INTO camery_outline.identity_migrations(version,checksum) VALUES($1,$2)',[extension.version,extension.checksum]);connected();}
    await client.query('COMMIT');connected();
  }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;return failure('identity migration rollback');}connected();if(error instanceof OutlineError)throw error;return failure('identity migration transaction');}
  // Release failures are unknown storage outcomes; never expose driver credentials.
  finally{try{client.release(destroy);}catch{failure('identity migration release');}finally{client.off('error',onError);}}
}

import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {ProjectApplicationError} from './intent-contracts.js';
import {knownOutlineIntentError} from './outline-intent-data.js';
type Migration={version:number;sql:string;checksum:string};
function failed(operation:string):never{throw new ProjectApplicationError('STORAGE_FAILED',operation);}
async function migration(path:string,version:number):Promise<Migration>{const sql=await readFile(new URL(path,import.meta.url),'utf8');return {version,sql,checksum:createHash('sha256').update(sql,'utf8').digest('hex')};}
function prerequisites(rows:readonly {version:number;checksum:string}[],expected:readonly Migration[]):void{
  if(rows.some((row,index)=>row.version!==expected[index]?.version||row.checksum!==expected[index]?.checksum))throw new ProjectApplicationError('CONFLICT','outline intent prerequisite checksum');
  if(rows.length!==expected.length)throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','outline intent prerequisite installation');
}
/** Explicit installer: old project initialization and runtime requests never extend their own privileges or schema. */
export async function migrateOutlineProjectIntents(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{return failed('outline migration connection');}
  let destroy=false,disconnected=false;const onError=()=>{destroy=true;disconnected=true;},connected=()=>{if(disconnected)failed('outline migration connection');};client.on('error',onError);
  try{
    const projects=await Promise.all(['0001-identity-bindings.sql','0002-application-intents.sql','0003-candidate-catalog.sql'].map((name,index)=>migration('./migrations/'+name,index+1)));
    const identities=await migration('../../../script/src/outline/node/identity-migrations/0001-outline-ir-identities.sql',1),extensions=await Promise.all(['0001-outline-intents.sql','0002-outline-candidate-catalog.sql'].map((name,index)=>migration('./outline-intent-migrations/'+name,index+1)));
    await client.query('BEGIN');connected();
    for(const namespace of ['camery_script:migrations','camery_outline:migrations','camery_projects:migrations']){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[namespace]);connected();}
    const installed=await client.query<{projects:boolean;identities:boolean}>("SELECT to_regclass('camery_projects.migrations') IS NOT NULL AS projects,to_regclass('camery_outline.identity_migrations') IS NOT NULL AS identities");connected();
    if(installed.rows.length!==1||installed.rows[0]!.projects!==true||installed.rows[0]!.identities!==true)throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','outline intent prerequisite schemas');
    const previous=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_projects.migrations ORDER BY version');connected();prerequisites(previous.rows,projects);
    const prepared=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_outline.identity_migrations ORDER BY version');connected();prerequisites(prepared.rows,[identities]);
    await client.query('CREATE TABLE IF NOT EXISTS camery_projects.outline_migrations(version integer PRIMARY KEY,checksum text NOT NULL)');connected();
    const applied=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_projects.outline_migrations ORDER BY version');connected();
    if(applied.rows.length>extensions.length||applied.rows.some((row,index)=>row.version!==extensions[index]!.version||row.checksum!==extensions[index]!.checksum))throw new ProjectApplicationError('CONFLICT','outline intent migration checksum');
    for(const extension of extensions.slice(applied.rows.length)){await client.query(extension.sql);connected();await client.query('INSERT INTO camery_projects.outline_migrations(version,checksum) VALUES($1,$2)',[extension.version,extension.checksum]);connected();}
    await client.query('COMMIT');connected();
  }catch(error){try{await client.query('ROLLBACK');}catch{destroy=true;return failed('outline migration rollback');}connected();if(knownOutlineIntentError(error))throw error;return failed('outline migration transaction');}
  // Unknown driver release messages must be redacted.
  finally{try{client.release(destroy);}catch{failed('outline migration release');}finally{client.off('error',onError);}}
}

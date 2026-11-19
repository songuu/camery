import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {ScreenplayError} from '../contracts.js';
/** Explicit domain installation; existing migrations and runtime authentication grants stay independently versioned. */
export async function migrateScreenplay(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ScreenplayError('STORAGE_FAILED','migration connection','migration');}
  let broken=false,destroy=false,listening=false,known:ScreenplayError|undefined;const onError=()=>{broken=true;};
  const fail=(code:'INCOMPLETE'|'CONFLICT'|'STORAGE_FAILED',path:string):never=>{known=new ScreenplayError(code,'screenplay migration',path);throw known;};
  const healthy=()=>{if(broken)fail('STORAGE_FAILED','connection');};
  try{
    client.on('error',onError);listening=true;
    const sql=await readFile(new URL('./migrations/0001-screenplay.sql',import.meta.url),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');if(sql.includes('\r'))fail('CONFLICT','migration bytes');
    await client.query('BEGIN');await client.query('SET LOCAL search_path = pg_catalog');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_screenplay:migrations',0))");
    const ready=await client.query("SELECT to_regclass('camery_versioning.snapshots') IS NOT NULL AND to_regclass('camery_versioning.changes') IS NOT NULL AND to_regclass('camery_versioning.object_revisions') IS NOT NULL AND to_regclass('camery_versioning.adoptions') IS NOT NULL AS native_ready");
    if(ready.rows.length!==1||ready.rows[0]?.native_ready!==true)fail('INCOMPLETE','native prerequisites');
    await client.query('CREATE SCHEMA IF NOT EXISTS camery_screenplay');await client.query('CREATE TABLE IF NOT EXISTS camery_screenplay.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const prior=await client.query('SELECT version,checksum FROM camery_screenplay.migrations ORDER BY version');
    if(prior.rows.length>1||prior.rows.some(row=>row.version!==1||row.checksum!==checksum))fail('CONFLICT','migration checksum');
    if(!prior.rows.length){await client.query(sql);await client.query('INSERT INTO camery_screenplay.migrations(version,checksum) VALUES($1,$2)',[1,checksum]);}
    healthy();await client.query('COMMIT');healthy();
  }catch{if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;throw new ScreenplayError('STORAGE_FAILED','migration rollback','migration');}throw known??new ScreenplayError('STORAGE_FAILED','migration','migration');}
  finally{let failed=false;try{client.removeListener('error',onError);}catch{destroy=true;failed=true;}try{client.release(destroy||broken);}catch{failed=true;}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Cleanup must release before reporting a safe failure.
    if(failed)throw new ScreenplayError('STORAGE_FAILED','migration release','migration');}
}

import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {ScreenplayError} from '../contracts.js';
/** Separate ledger: installing generation never rewrites the released manual/finalization migration. */
export async function migrateScreenplayGeneration(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ScreenplayError('STORAGE_FAILED','generation migration connection','migration');}
  let broken=false,destroy=false,listening=false,known:ScreenplayError|undefined;const onError=()=>{broken=true;};
  const fail=(code:'INCOMPLETE'|'CONFLICT'|'STORAGE_FAILED',path:string):never=>{known=new ScreenplayError(code,'screenplay generation migration',path);throw known;};
  try{
    client.on('error',onError);listening=true;
    const sql=await readFile(new URL('./generation-migrations/0001-generation.sql',import.meta.url),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');if(sql.includes('\r'))fail('CONFLICT','migration bytes');
    await client.query('BEGIN');await client.query('SET LOCAL search_path = pg_catalog');
    await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('camery_screenplay:generation-migrations',0::pg_catalog.int8))");
    const ready=await client.query("SELECT pg_catalog.to_regclass('camery_screenplay.candidates') IS NOT NULL AS ready");if(ready.rows.length!==1||ready.rows[0]?.ready!==true)fail('INCOMPLETE','screenplay prerequisites');
    await client.query('CREATE TABLE IF NOT EXISTS camery_screenplay.generation_migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const prior=await client.query('SELECT version,checksum FROM camery_screenplay.generation_migrations ORDER BY version');if(prior.rows.length>1||prior.rows.some(row=>row.version!==1||row.checksum!==checksum))fail('CONFLICT','migration checksum');
    if(!prior.rows.length){await client.query(sql);await client.query('INSERT INTO camery_screenplay.generation_migrations(version,checksum) VALUES($1,$2)',[1,checksum]);}
    await client.query('REVOKE ALL ON camery_screenplay.generation_migrations FROM PUBLIC');if(broken)fail('STORAGE_FAILED','connection');await client.query('COMMIT');if(broken)fail('STORAGE_FAILED','connection');
  }catch{if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;throw new ScreenplayError('STORAGE_FAILED','generation migration rollback','migration');}throw known??new ScreenplayError('STORAGE_FAILED','generation migration','migration');}
  finally{let failed=false;try{client.removeListener('error',onError);}catch{destroy=true;failed=true;}try{client.release(destroy||broken);}catch{failed=true;}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Release is always attempted before a safe cleanup error.
    if(failed)throw new ScreenplayError('STORAGE_FAILED','generation migration release','migration');}
}

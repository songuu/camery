import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {Pool,PoolClient} from 'pg';
import {ContinuityError} from '../contracts.js';

/** Separate explicit installation keeps the released continuity v1 installer and checksum unchanged. */
export async function migrateContinuityNative(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ContinuityError('STORAGE_FAILED','native migration connection','migration');}
  let destroy=false,broken=false,listening=false,known:ContinuityError|undefined;const onError=()=>{broken=true;};
  const refuse=(code:'INCOMPLETE'|'CONFLICT',operation:string):never=>{known=new ContinuityError(code,operation,'migration');throw known;};
  const healthy=()=>{if(broken){known=new ContinuityError('STORAGE_FAILED','native migration connection','migration');throw known;}};
  try{
    client.on('error',onError);listening=true;
    const sql=await readFile(new URL('./native-migrations/0001-native-proof.sql',import.meta.url),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
    if(sql.includes('\r'))refuse('CONFLICT','native migration bytes');
    await client.query('BEGIN');await client.query('SET LOCAL search_path = pg_catalog');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('camery_continuity:migrations',0))");
    const ready=await client.query<{native_ready:boolean}>("SELECT to_regclass('camery_versioning.object_revisions') IS NOT NULL AND to_regclass('camery_versioning.adoptions') IS NOT NULL AND to_regclass('camery_continuity.candidates') IS NOT NULL AND to_regclass('camery_continuity.reviews') IS NOT NULL AS native_ready");
    if(ready.rows.length!==1||ready.rows[0]?.native_ready!==true)refuse('INCOMPLETE','native proof prerequisites');
    await client.query('CREATE TABLE IF NOT EXISTS camery_continuity.native_migrations(version integer PRIMARY KEY,checksum text NOT NULL)');
    const prior=await client.query<{version:number;checksum:string}>('SELECT version,checksum FROM camery_continuity.native_migrations ORDER BY version');
    if(prior.rows.length>1||prior.rows.some(row=>row.version!==1||row.checksum!==checksum))refuse('CONFLICT','native migration checksum');
    if(prior.rows.length===0){await client.query(sql);await client.query('INSERT INTO camery_continuity.native_migrations(version,checksum) VALUES($1,$2)',[1,checksum]);}
    healthy();await client.query('COMMIT');healthy();
  }catch{
    if(!listening)destroy=true;
    try{await client.query('ROLLBACK');}catch{destroy=true;throw new ContinuityError('STORAGE_FAILED','native migration rollback','migration');}
    throw known??new ContinuityError('STORAGE_FAILED','native migration','migration');
  }
  finally{
    let cleanupFailed=false;try{client.removeListener('error',onError);}catch{destroy=true;cleanupFailed=true;}
    try{client.release(destroy||broken);}catch{cleanupFailed=true;}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Cleanup failures must be explicit after release is attempted, without driver diagnostics.
    if(cleanupFailed)throw new ContinuityError('STORAGE_FAILED','native migration release','migration');
  }
}

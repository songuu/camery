import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ComplianceError} from '../contracts.js';
/** Explicit owner installation only; constructors never install schemas, create logins or activate legal rules. */
export async function migrateCompliance(pool:Pool):Promise<void>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ComplianceError('STORAGE_FAILED','precheck migration connection','migration');}
  let broken=false,destroy=false,listening=false,known:ComplianceError|undefined;const onError=()=>{broken=true;},fail=(code:ComplianceError['code'],path:string):never=>{known=new ComplianceError(code,'precheck migration',path);throw known;};
  try{client.on('error',onError);listening=true;const sql=await readFile(new URL('./migrations/0001-precheck.sql',import.meta.url),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');if(sql.includes('\r'))fail('CONFLICT','migration bytes');await client.query('BEGIN');await client.query('SET LOCAL search_path = pg_catalog');await client.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('camery_compliance:migrations',0::pg_catalog.int8))");const ready=await client.query("SELECT pg_catalog.to_regclass('camery_screenplay.candidates') IS NOT NULL AND pg_catalog.to_regclass('camery_screenplay.reviews') IS NOT NULL AND pg_catalog.to_regclass('camery_screenplay.native_adoptions') IS NOT NULL AS ready");if(ready.rows.length!==1||ready.rows[0]?.ready!==true)fail('INCOMPLETE','screenplay prerequisites');
    const exists=await client.query("SELECT pg_catalog.to_regclass('camery_compliance.migrations') IS NOT NULL AS installed");if(exists.rows.length!==1)fail('STORAGE_FAILED','migration ledger');
    if(exists.rows[0]?.installed===true){const prior=await client.query('SELECT version,checksum FROM camery_compliance.migrations ORDER BY version');if(prior.rows.length!==1||prior.rows[0]?.version!==1||prior.rows[0]?.checksum!==checksum)fail('CONFLICT','migration checksum');}
    else{await client.query(sql);await client.query('CREATE TABLE camery_compliance.migrations(version integer PRIMARY KEY,checksum text NOT NULL)');await client.query('INSERT INTO camery_compliance.migrations(version,checksum) VALUES($1,$2)',[1,checksum]);await client.query('REVOKE ALL ON camery_compliance.migrations FROM PUBLIC');}
    if(broken)fail('STORAGE_FAILED','connection');await client.query('COMMIT');if(broken)fail('STORAGE_FAILED','connection');
  }catch{if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;throw new ComplianceError('STORAGE_FAILED','precheck migration rollback','migration');}throw known??new ComplianceError('STORAGE_FAILED','precheck migration','migration');}
  finally{let failed=false;try{client.removeListener('error',onError);}catch{destroy=true;failed=true;}try{client.release(destroy||broken);}catch{failed=true;}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Release must be attempted before a safe cleanup failure.
    if(failed)throw new ComplianceError('STORAGE_FAILED','precheck migration release','migration');}
}

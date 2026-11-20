import type {Pool,PoolClient} from 'pg';
import {QualityError} from '../contracts.js';
export function storageFailure(path:string):never{throw new QualityError('STORAGE_FAILED','quality persistence',path);}
export function safeStorage(error:unknown):never{let known=false;try{known=error instanceof QualityError;}catch{/* Database and prototype diagnostics remain private. */}if(known)throw error;return storageFailure('storage');}
/** All owned operations use a fresh RC snapshot and never hold a connection during provider requests. */
export async function transaction<T>(pool:Pool,action:(client:PoolClient)=>Promise<T>):Promise<T>{
  let client:PoolClient;try{client=await pool.connect();}catch{return storageFailure('connection');}
  let broken=false,destroy=false,listening=false;const onError=()=>{broken=true;},healthy=()=>{if(broken)storageFailure('connection');};
  try{client.on('error',onError);listening=true;await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query('SET LOCAL search_path = pg_catalog');healthy();const result=await action(client);healthy();await client.query('COMMIT');healthy();return result;}
  catch(error){if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;return storageFailure('rollback');}return safeStorage(error);}
  finally{let failed=false;try{client.removeListener('error',onError);}catch{destroy=true;failed=true;}try{client.release(destroy||broken);}catch{failed=true;}if(failed)storageFailure('release');}
}

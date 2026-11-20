import type {Pool,PoolClient} from 'pg';
import {ScreenplayError} from '@camery/script/screenplay';
import {ProjectApplicationError} from './intent-contracts.js';

function known(error:unknown):boolean{try{return error instanceof ProjectApplicationError||error instanceof ScreenplayError;}catch{return false;}}
function databaseCode(error:unknown):unknown{try{if(error&&typeof error==='object'){const descriptor=Object.getOwnPropertyDescriptor(error,'code');if(descriptor&&'value' in descriptor)return descriptor.value;}}catch{/* Driver proxies never provide public diagnostics. */}return undefined;}
/** One caller-owned RC transaction for source reads and append-only journals, with explicit connection cleanup. */
export async function projectCommandTransaction<T>(pool:Pool,operation:string,action:(client:PoolClient)=>Promise<T>):Promise<T>{
  let client:PoolClient;try{client=await pool.connect();}catch{throw new ProjectApplicationError('STORAGE_FAILED',operation+' connection');}
  let broken=false,destroy=false,listening=false;const onError=()=>{broken=true;destroy=true;},healthy=()=>{if(broken)throw new ProjectApplicationError('STORAGE_FAILED',operation+' connection');};
  try{
    client.on('error',onError);listening=true;await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');await client.query('SET LOCAL search_path = pg_catalog');healthy();
    const result=await action(client);healthy();await client.query('COMMIT');healthy();return result;
  }catch(error){if(!listening)destroy=true;try{await client.query('ROLLBACK');}catch{destroy=true;throw new ProjectApplicationError('STORAGE_FAILED',operation+' rollback');}healthy();if(known(error))throw error;const code=databaseCode(error);throw new ProjectApplicationError(code==='23503'||code==='23505'?'CONFLICT':'STORAGE_FAILED',operation+' transaction');}
  finally{
    let cleanupFailed=false;try{if(listening)client.off('error',onError);}catch{destroy=true;cleanupFailed=true;}try{client.release(destroy);}catch{cleanupFailed=true;}
    // oxlint-disable-next-line eslint/no-unsafe-finally -- Both cleanup steps run before reporting a safe error.
    if(cleanupFailed)throw new ProjectApplicationError('STORAGE_FAILED',operation+' release');
  }
}

import {JsonBoundaryError,snapshotJson} from '@camery/methods/json';
import type {z} from 'zod';
import {ScreenplayError} from './contracts.js';
export function captureScreenplay<S extends z.ZodType>(schema:S,input:unknown,operation:string,maxBytes:number):z.infer<S>{
  let own:ScreenplayError|undefined;
  try{
    const value=snapshotJson(input,maxBytes,65536),result=schema.safeParse(value);if(result.success)return result.data;
    own=new ScreenplayError('INVALID_INPUT',operation,result.error.issues[0]!.path.join('.')||'$');throw own;
  }catch(error){
    if(own&&error===own)throw own;let limited=false;try{limited=error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT';}catch{/* Opaque input exceptions cannot supply public diagnostics. */}
    throw new ScreenplayError(limited?'INPUT_LIMIT':'INVALID_INPUT',operation,'$');
  }
}
export function freezeScreenplay<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeScreenplay(child);Object.freeze(value);}return value;}

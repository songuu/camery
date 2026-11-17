import { JsonBoundaryError,snapshotJson } from '@camery/methods/json';
import type { z } from 'zod';
import { OUTLINE_BYTES,OutlineError } from './contracts.js';

export function capture<S extends z.ZodType>(schema:S,input:unknown,operation:string,maxBytes=OUTLINE_BYTES):z.infer<S>{
  let snapshot:unknown;
  try{snapshot=snapshotJson(input,maxBytes);}
  catch(error){throw new OutlineError(error instanceof JsonBoundaryError?error.code:'INVALID_INPUT',operation,'$');}
  const result=schema.safeParse(snapshot);
  if(!result.success)throw new OutlineError('INVALID_INPUT',operation,result.error.issues[0]!.path.join('.')||'$');
  return result.data;
}
export function deepFreeze<T>(value:T):T{
  if(value&&typeof value==='object'){
    for(const child of Object.values(value))deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

import {JsonBoundaryError,snapshotJson} from '@camery/methods/json';
import type {z} from 'zod';
import {ContinuityError} from './contracts.js';
export function captureContinuity<S extends z.ZodType>(schema:S,input:unknown,operation:string,maxBytes:number):z.infer<S>{
  try{const value=snapshotJson(input,maxBytes,65536),parsed=schema.safeParse(value);if(parsed.success)return parsed.data;throw new ContinuityError('INVALID_INPUT',operation,parsed.error.issues[0]!.path.join('.')||'$');}
  catch(error){if(error instanceof ContinuityError)throw error;throw new ContinuityError(error instanceof JsonBoundaryError?error.code:'INVALID_INPUT',operation,'$');}
}
export function freezeContinuity<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeContinuity(child);Object.freeze(value);}return value;}

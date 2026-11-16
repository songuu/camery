import { createHash } from 'node:crypto';
import { canonical as canonicalMethod,freeze } from '@camery/methods';
import { snapshotJson as snapshot,JsonBoundaryError } from '@camery/methods/json';
import { z } from 'zod';
import { DevelopmentError,ENVELOPE_BYTES } from './contracts.js';
export {freeze};
export function copy<T>(input:T,maxBytes=ENVELOPE_BYTES):T {
  try{return snapshot(input,maxBytes);}
  catch(error){throw new DevelopmentError(error instanceof JsonBoundaryError?error.code:'INVALID_INPUT','data snapshot');}
}
export function parse<S extends z.ZodType>(schema:S,input:unknown,operation:string):z.infer<S>{
  try{const result=schema.safeParse(input);if(result.success)return result.data;}catch{/* Arbitrary accessor/schema exceptions never cross the domain boundary. */}
  throw new DevelopmentError('INVALID_INPUT',operation);
}
export function canonical(input:unknown):string{return canonicalMethod(copy(input));}
export function hash(input:unknown):string{return createHash('sha256').update(canonical(input)).digest('hex');}

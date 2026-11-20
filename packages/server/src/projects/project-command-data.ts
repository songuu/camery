import {createHash} from 'node:crypto';
import type {z} from 'zod';
import {freeze} from '@camery/methods';
import {JsonBoundaryError,snapshotJson} from '@camery/methods/json';
import {ProjectApplicationError} from './intent-contracts.js';

export function captureProjectCommand<S extends z.ZodType>(schema:S,input:unknown,operation:string,bytes:number):Readonly<z.infer<S>>{
  try{const result=schema.safeParse(snapshotJson(input,bytes,131072));if(result.success)return freeze(result.data);}
  catch(error){if(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT')throw new ProjectApplicationError('INPUT_LIMIT',operation);}
  throw new ProjectApplicationError('INVALID_INPUT',operation);
}
/** Source journals have different limits; capture before sorting so accessors cannot reach serialization. */
export function projectCommandJson(input:unknown,bytes:number,operation='project command digest'):string{
  try{
    const value=snapshotJson(input,bytes,131072);
    const sorted=(item:unknown):unknown=>Array.isArray(item)?item.map(sorted):item!==null&&typeof item==='object'?Object.fromEntries(Object.keys(item).sort().map(key=>[key,sorted((item as Record<string,unknown>)[key])])):item;
    return JSON.stringify(sorted(value));
  }catch(error){throw new ProjectApplicationError(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT'?'INPUT_LIMIT':'INVALID_INPUT',operation);}
}
export function projectCommandDigest(input:unknown,bytes:number,operation='project command digest'):string{return createHash('sha256').update(projectCommandJson(input,bytes,operation)).digest('hex');}

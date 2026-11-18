import {createHash} from 'node:crypto';
import {freeze} from '@camery/methods';
import {JsonBoundaryError,snapshotJson} from '@camery/methods/json';
import type {z} from 'zod';
import {OUTLINE_MAPPING_MAX_IDS} from '@camery/script/outline/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {OUTLINE_INTENT_BYTES,OUTLINE_INTENT_ENVELOPE_BYTES} from './outline-intent-contracts.js';

export function captureOutlineIntent<S extends z.ZodType>(schema:S,input:unknown,operation:string,maximum=OUTLINE_INTENT_BYTES):Readonly<z.infer<S>>{
  try{const value=snapshotJson(input,maximum,OUTLINE_MAPPING_MAX_IDS),result=schema.safeParse(value);if(result.success)return freeze(result.data);}
  catch(error){if(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT')throw new ProjectApplicationError('INPUT_LIMIT',operation);}
  throw new ProjectApplicationError('INVALID_INPUT',operation);
}
/** Internal bounded JSON digest. Neither a digest nor a serialized intent grants adoption authority. */
export function outlineIntentDigest(input:unknown):string{
  return createHash('sha256').update(outlineIntentJson(input)).digest('hex');
}
/** Snapshot first: sorted serialization must never consult caller accessors or the legacy 2MiB Method boundary. */
export function outlineIntentJson(input:unknown):string{
  try{
    const captured=snapshotJson(input,OUTLINE_INTENT_ENVELOPE_BYTES,OUTLINE_MAPPING_MAX_IDS);
    const sorted=(value:unknown):unknown=>Array.isArray(value)?value.map(sorted):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted((value as Record<string,unknown>)[key])])):value;
    return JSON.stringify(sorted(captured));
  }
  catch(error){throw new ProjectApplicationError(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT'?'INPUT_LIMIT':'INVALID_INPUT','outline intent digest');}
}
export function knownOutlineIntentError(error:unknown):error is ProjectApplicationError{try{return error instanceof ProjectApplicationError;}catch{return false;}}
export function outlineIntentDatabaseCode(error:unknown):unknown{try{if(error&&typeof error==='object'){const descriptor=Object.getOwnPropertyDescriptor(error,'code');if(descriptor&&'value' in descriptor)return descriptor.value;}}catch{/* Driver proxies never supply public context. */}return undefined;}
export async function safeOutlineIntent<T>(operation:string,action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){if(knownOutlineIntentError(error))throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}}
export function outlineIntentOne<T>(rows:T[]):T|null{if(rows.length>1)throw new ProjectApplicationError('STORAGE_FAILED','outline intent cardinality');return rows[0]??null;}
export const omitOutlineIntent=(value:object,keys:readonly string[]):Record<string,unknown>=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));

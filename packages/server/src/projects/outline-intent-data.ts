import type {z} from 'zod';
import {ProjectApplicationError} from './intent-contracts.js';
import {OUTLINE_INTENT_BYTES,OUTLINE_INTENT_ENVELOPE_BYTES} from './outline-intent-contracts.js';
import {captureProjectCommand,projectCommandDigest,projectCommandJson} from './project-command-data.js';

export function captureOutlineIntent<S extends z.ZodType>(schema:S,input:unknown,operation:string,maximum=OUTLINE_INTENT_BYTES):Readonly<z.infer<S>>{
  return captureProjectCommand(schema,input,operation,maximum);
}
/** Internal bounded JSON digest. Neither a digest nor a serialized intent grants adoption authority. */
export function outlineIntentDigest(input:unknown):string{
  return projectCommandDigest(input,OUTLINE_INTENT_ENVELOPE_BYTES,'outline intent digest');
}
/** Snapshot first: sorted serialization must never consult caller accessors or the legacy 2MiB Method boundary. */
export function outlineIntentJson(input:unknown):string{
  return projectCommandJson(input,OUTLINE_INTENT_ENVELOPE_BYTES,'outline intent digest');
}
export function knownOutlineIntentError(error:unknown):error is ProjectApplicationError{try{return error instanceof ProjectApplicationError;}catch{return false;}}
export function outlineIntentDatabaseCode(error:unknown):unknown{try{if(error&&typeof error==='object'){const descriptor=Object.getOwnPropertyDescriptor(error,'code');if(descriptor&&'value' in descriptor)return descriptor.value;}}catch{/* Driver proxies never supply public context. */}return undefined;}
export async function safeOutlineIntent<T>(operation:string,action:()=>Promise<T>):Promise<T>{try{return await action();}catch(error){if(knownOutlineIntentError(error))throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}}
export function outlineIntentOne<T>(rows:T[]):T|null{if(rows.length>1)throw new ProjectApplicationError('STORAGE_FAILED','outline intent cardinality');return rows[0]??null;}
export const omitOutlineIntent=(value:object,keys:readonly string[]):Record<string,unknown>=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));

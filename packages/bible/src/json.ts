import { JsonBoundaryError,snapshotJson as snapshot } from '@camery/methods/json';
import { BibleError } from './contracts.js';
/** Preserve the Bible error contract while sharing the browser-safe data boundary with other method consumers. */
export function snapshotJson<T>(input:T,maxBytes=2_097_152,maxArrayLength=8192):T {
  try{return snapshot(input,maxBytes,maxArrayLength);}
  catch(error){
    if(error instanceof JsonBoundaryError)throw new BibleError(error.code,error.operation);
    throw new BibleError('INVALID_INPUT','data properties');
  }
}
export function guardJson(input:unknown,maxBytes=2_097_152,maxArrayLength=8192):void{snapshotJson(input,maxBytes,maxArrayLength);}

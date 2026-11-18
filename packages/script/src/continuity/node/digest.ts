import {createHash} from 'node:crypto';
import {JsonBoundaryError,snapshotJson} from '@camery/methods/json';
import {ContinuityError,CONTINUITY_CONTEXT_BYTES} from '../contracts.js';
/** The domain's byte limit applies before copying or key collection; the shared Method canonicalizer keeps its original 2MiB contract. */
export function canonicalContinuity(input:unknown,maxBytes:number):string{
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>CONTINUITY_CONTEXT_BYTES)throw new ContinuityError('INVALID_INPUT','canonical budget','$');
  try{
    const value=snapshotJson(input,maxBytes,65536),keys=new Set<string>(),queue:unknown[]=[value];
    for(let i=0;i<queue.length;i++){const item=queue[i];if(Array.isArray(item)){for(const child of item)queue.push(child);}else if(item!==null&&typeof item==='object'){for(const [key,child] of Object.entries(item)){keys.add(key);queue.push(child);}}}
    return JSON.stringify(value,[...keys].sort());
  }catch(error){throw new ContinuityError(error instanceof JsonBoundaryError?error.code:'INVALID_INPUT','canonical data','$');}
}
export function continuityDigest(input:unknown,maxBytes:number):string{return createHash('sha256').update(canonicalContinuity(input,maxBytes)).digest('hex');}

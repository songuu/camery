import {createHash} from 'node:crypto';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import {ComplianceError} from '../contracts.js';
/** Large stored records keep their own byte limit; Methods' 2MiB canonical contract is unchanged. */
export function canonical(input:unknown,maxBytes=67108864):string{
  try{if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>67108864)throw new Error();const value=snapshotJson(input,maxBytes,65536),keys=new Set<string>(),queue:unknown[]=[value];for(let i=0;i<queue.length;i++){const item=queue[i];if(Array.isArray(item)){for(const child of item)queue.push(child);}else if(item!==null&&typeof item==='object')for(const [key,child]of Object.entries(item)){keys.add(key);queue.push(child);}}return JSON.stringify(value,[...keys].sort());}
  catch(error){let limit=false;try{limit=error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT';}catch{/* Opaque dependency exceptions cannot be public diagnostics. */}throw new ComplianceError(limit?'INPUT_LIMIT':'INVALID_INPUT','canonical precheck data','$');}
}
export function hash(input:unknown,maxBytes=67108864):string{return createHash('sha256').update(canonical(input,maxBytes)).digest('hex');}
export function equal(left:unknown,right:unknown):boolean{return canonical(left)===canonical(right);}

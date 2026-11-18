import {canonical,digest} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import type {z} from 'zod';
import {OutlineError} from '../contracts.js';
import {OUTLINE_MAPPING_INPUT_BYTES,OUTLINE_MAPPING_MAX_IDS} from './formal-contracts.js';
export function copyOutlineFormal<T>(input:T,maximum=OUTLINE_MAPPING_INPUT_BYTES):T{
  try{return snapshotJson(input,maximum,OUTLINE_MAPPING_MAX_IDS);}
  catch(error){throw new OutlineError(error instanceof JsonBoundaryError?error.code:'INVALID_INPUT','formal snapshot','$');}
}
export function captureOutlineFormal<T>(schema:z.ZodType<T>,input:unknown,operation:string,maximum=OUTLINE_MAPPING_INPUT_BYTES):T{
  const data=copyOutlineFormal(input,maximum);try{const parsed=schema.safeParse(data);if(parsed.success)return parsed.data;}catch{/* Only safe domain context crosses this boundary. */}
  throw new OutlineError('INVALID_INPUT',operation,'formal');
}
/** Only for already bounded immutable data; never route a formal graph through the small outline-envelope hash helper. */
export const equalOutlineFormal=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
export const digestOutlineFormal=(input:unknown)=>digest(copyOutlineFormal(input));

import { digest } from '@camery/methods';
import { snapshotJson,JsonBoundaryError } from '@camery/methods/json';
import { OutlineError } from '../contracts.js';
import { OUTLINE_ENVELOPE_BYTES } from '../generation-contracts.js';
export function copy<T>(input:T,maximum=OUTLINE_ENVELOPE_BYTES):T{
  try{return snapshotJson(input,maximum);}
  catch(error){throw new OutlineError(error instanceof JsonBoundaryError?error.code:'INVALID_INPUT','snapshot','$');}
}
export function hash(input:unknown):string{return digest(copy(input));}

import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import {ContinuityError} from '../../continuity/contracts.js';
import {QualityError,QUALITY_MATERIAL_BYTES} from '../contracts.js';
function failure(error:unknown):never{let limit=false;try{limit=error instanceof ContinuityError&&error.code==='INPUT_LIMIT';}catch{/* Opaque dependency errors cannot supply public diagnostics. */}throw new QualityError(limit?'INPUT_LIMIT':'INVALID_INPUT','quality canonical data','$');}
/** Shares the established 64MiB storage canonicalizer without enlarging Methods' original 2MiB request contract. */
export function canonicalQualityData(input:unknown,maxBytes=QUALITY_MATERIAL_BYTES):string{try{return canonicalContinuity(input,maxBytes);}catch(error){return failure(error);}}
export function qualityDigest(input:unknown,maxBytes=QUALITY_MATERIAL_BYTES):string{try{return continuityDigest(input,maxBytes);}catch(error){return failure(error);}}
export function equalQualityData(a:unknown,b:unknown):boolean{return canonicalQualityData(a)===canonicalQualityData(b);}

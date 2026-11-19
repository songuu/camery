import {JsonBoundaryError,snapshotJson} from '@camery/methods/json';
import type {z} from 'zod';
import {ComplianceError,CorpusSchema,CORPUS_BYTES} from './contracts.js';
import type {Segment} from './contracts.js';
export function capture<S extends z.ZodType>(schema:S,input:unknown,operation:string,maxBytes:number):z.infer<S>{
  let own:ComplianceError|undefined;try{const result=schema.safeParse(snapshotJson(input,maxBytes,65536));if(result.success)return result.data;own=new ComplianceError('INVALID_INPUT',operation,result.error.issues[0]!.path.join('.')||'$');throw own;}
  catch(error){if(own&&error===own)throw own;let limited=false;try{limited=error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT';}catch{/* Dependency prototype traps never supply diagnostics. */}throw new ComplianceError(limited?'INPUT_LIMIT':'INVALID_INPUT',operation,'$');}
}
export function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export function captureCorpus(input:unknown){
  const corpus=capture(CorpusSchema,input,'precheck corpus',CORPUS_BYTES);validateCapturedSegments(corpus.segments);
  return freeze(corpus);
}
/** Relationship checks for already captured corpus/batch data; never traverse caller objects before capture. */
export function validateCapturedSegments(segments:readonly Segment[]):void{
  const ids=new Set<string>(),paths=new Set<string>();for(const segment of segments){if(ids.has(segment.id)||paths.has(segment.path))throw new ComplianceError('INVALID_REFERENCE','precheck corpus','segments');ids.add(segment.id);paths.add(segment.path);if(segment.field==='line'||segment.field==='delivery'){if(!segment.sceneId||!segment.beatId||!segment.lineId||!segment.voice||!segment.speakerId)throw new ComplianceError('INVALID_REFERENCE','precheck line metadata',segment.path);}else if(segment.field==='speaker_name'){if(!segment.speakerId||segment.voice!==null||segment.sceneId!==null||segment.beatId!==null||segment.lineId!==null)throw new ComplianceError('INVALID_REFERENCE','precheck speaker name metadata',segment.path);}else if(segment.voice!==null||segment.speakerId!==null)throw new ComplianceError('INVALID_REFERENCE','precheck non-line metadata',segment.path);}
}

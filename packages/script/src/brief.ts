import { BriefInputSchema,DevelopmentBriefSchema,DevelopmentError,BRIEF_BYTES } from './contracts.js';
import type { DevelopmentBrief } from './contracts.js';
import { copy,freeze,hash,parse } from './data.js';
/** Host supplies scope/revision; a brief is data, never a request for tools, credentials or approval. */
export function captureBrief(input:unknown):DevelopmentBrief {
  const fields=parse(BriefInputSchema,copy(input,BRIEF_BYTES),'brief');const body={version:1 as const,...fields};
  const snapshot={...body,digest:hash(body)};copy(snapshot,BRIEF_BYTES);return freeze(snapshot);
}
export function validateBrief(input:unknown):DevelopmentBrief {
  const value=parse(DevelopmentBriefSchema,copy(input,BRIEF_BYTES),'brief snapshot');const {version:_version,digest,...fields}=value;
  const actual=captureBrief(fields);if(actual.digest!==digest)throw new DevelopmentError('CONFLICT','brief digest');return actual;
}

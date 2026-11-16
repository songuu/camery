import { z } from 'zod';
import { DevelopmentBriefSchema,DevelopmentError,Hash,Id,Stage,ENVELOPE_BYTES } from './contracts.js';
import type { DevelopmentBrief,ReviewedDevelopment } from './contracts.js';
import { validateBrief } from './brief.js';
import { validateFoundation } from './foundation.js';
import { validateEpisodes } from './episodes.js';
import { copy,freeze,hash,parse } from './data.js';

export const ReviewEnvelope=z.strictObject({version:z.literal(1),status:z.literal('reviewed'),stage:Stage,brief:DevelopmentBriefSchema,candidateDigest:Hash,upstreamDigest:Hash.nullable(),output:z.unknown(),actorId:Id,at:z.string().max(24),digest:Hash});
export function canonicalTime(value:string):boolean{try{return new Date(value).toISOString()===value;}catch{return false;}}
/** Integrity replay only. The caller must read this audit from trusted storage; an unkeyed digest is not authorization. */
export function validateReviewedFoundation(current:DevelopmentBrief,input:unknown):ReviewedDevelopment<'foundation'>{
  const brief=validateBrief(current);const raw=parse(ReviewEnvelope,copy(input,ENVELOPE_BYTES),'foundation review snapshot');
  if(raw.stage!=='foundation'||raw.upstreamDigest!==null||validateBrief(raw.brief).digest!==brief.digest)throw new DevelopmentError('CONFLICT','foundation review binding');
  if(!canonicalTime(raw.at))throw new DevelopmentError('INVALID_INPUT','review timestamp');
  const output=validateFoundation(raw.output);const body={version:1 as const,status:'reviewed' as const,stage:'foundation' as const,brief,candidateDigest:raw.candidateDigest,upstreamDigest:null,output,actorId:raw.actorId,at:raw.at};
  if(hash(body)!==raw.digest)throw new DevelopmentError('CONFLICT','foundation review digest');return freeze({...body,digest:raw.digest});
}
/** Does not create a new approval or resolve the referenced original candidate; the store must verify its foreign identity. */
export function validateReviewedEpisodes(current:DevelopmentBrief,upstream:ReviewedDevelopment<'foundation'>,input:unknown):ReviewedDevelopment<'episodes'>{
  const brief=validateBrief(current);const foundation=validateReviewedFoundation(brief,upstream);const raw=parse(ReviewEnvelope,copy(input,ENVELOPE_BYTES),'episodes review snapshot');
  if(raw.stage!=='episodes'||raw.upstreamDigest!==foundation.digest||validateBrief(raw.brief).digest!==brief.digest)throw new DevelopmentError('CONFLICT','episodes review binding');
  if(!canonicalTime(raw.at))throw new DevelopmentError('INVALID_INPUT','review timestamp');
  const output=validateEpisodes(brief,foundation.output,raw.output);const body={version:1 as const,status:'reviewed' as const,stage:'episodes' as const,brief,candidateDigest:raw.candidateDigest,upstreamDigest:foundation.digest,output,actorId:raw.actorId,at:raw.at};
  if(hash(body)!==raw.digest)throw new DevelopmentError('CONFLICT','episodes review digest');return freeze({...body,digest:raw.digest});
}

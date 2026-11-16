import { z } from 'zod';
import type { MethodPin,ModelReceipt } from '@camery/methods';

export const Id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
export const LocalId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$(?![\s\S])/);
export const Hash=z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
export const Integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Text=(maximum:number)=>z.string().min(1).max(maximum).refine(value=>value.trim().length>0&&value.isWellFormed()&&!value.includes('\0'));
export const Stage=z.enum(['foundation','episodes']);
export type DevelopmentStage=z.infer<typeof Stage>;
export const BriefInputSchema=z.strictObject({tenantId:Id,projectId:Id,briefId:Id,revision:Integer.min(1),idea:Text(2000),episodeCount:Integer.min(1).max(100),targetSeconds:Integer.min(1).max(3600)});
export type BriefInput=z.infer<typeof BriefInputSchema>;
export const DevelopmentBriefSchema=BriefInputSchema.extend({version:z.literal(1),digest:Hash});
export type DevelopmentBrief=z.infer<typeof DevelopmentBriefSchema>;
export const CharacterFunction=z.enum(['protagonist','antagonist','supporting']);
export const FoundationOutputSchema=z.strictObject({title:Text(120),
  world:z.strictObject({setting:Text(1000),era:Text(200),rules:z.array(z.strictObject({id:LocalId,text:Text(1000)})).max(32)}),
  characters:z.array(z.strictObject({id:LocalId,name:Text(120),function:CharacterFunction,desire:Text(500),obstacle:Text(500),arc:Text(1000)})).min(1).max(32),
  relationships:z.array(z.strictObject({id:LocalId,from:LocalId,to:LocalId,text:Text(500)})).max(64),
  mainline:z.strictObject({premise:Text(1000),centralConflict:Text(1000),stakes:Text(1000),progression:Text(2000),resolution:Text(1000),characterIds:z.array(LocalId).min(1).max(32),ruleIds:z.array(LocalId).max(32)}),
  openQuestions:z.array(z.strictObject({id:LocalId,text:Text(500)})).max(16),
});
export type FoundationOutput=z.infer<typeof FoundationOutputSchema>;
export const EpisodeOutputSchema=z.strictObject({episodes:z.array(z.strictObject({number:Integer.min(1).max(100),title:Text(120),summary:Text(1200),goal:Text(500),conflict:Text(500),turn:Text(500),ending:Text(500),characterIds:z.array(LocalId).min(1).max(32),ruleIds:z.array(LocalId).max(32)})).min(1).max(100)});
export type EpisodeOutput=z.infer<typeof EpisodeOutputSchema>;
export const FOUNDATION_BYTES=32768;export const EPISODE_BYTES=65536;export const BRIEF_BYTES=8192;export const ENVELOPE_BYTES=262144;
export interface OutputByStage {foundation:FoundationOutput;episodes:EpisodeOutput}
export interface DevelopmentCandidate<S extends DevelopmentStage=DevelopmentStage> {
  readonly version:1;readonly status:'candidate';readonly stage:S;readonly brief:DevelopmentBrief;
  readonly upstreamDigest:string|null;readonly method:MethodPin;readonly output:OutputByStage[S];readonly model:ModelReceipt;readonly digest:string;
}
export interface DevelopmentReviewHost {
  readonly tenantId:string;readonly projectId:string;readonly actor:{readonly kind:'human';readonly id:string};readonly at:string;
  readonly authorize:(input:{readonly actorId:string;readonly brief:DevelopmentBrief;readonly stage:DevelopmentStage;readonly action:'development:review'})=>boolean;
}
export interface ReviewedDevelopment<S extends DevelopmentStage=DevelopmentStage> {
  readonly version:1;readonly status:'reviewed';readonly stage:S;readonly brief:DevelopmentBrief;
  readonly candidateDigest:string;readonly upstreamDigest:string|null;readonly output:OutputByStage[S];readonly actorId:string;readonly at:string;readonly digest:string;
}
export interface RejectedDevelopment {
  readonly version:1;readonly status:'rejected';readonly stage:DevelopmentStage;readonly brief:DevelopmentBrief;
  readonly candidateDigest:string;readonly actorId:string;readonly at:string;readonly reason:string;readonly digest:string;
}
export class DevelopmentError extends Error {
  override readonly name='DevelopmentError';
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT'|'INVALID_REFERENCE'|'CONFLICT'|'FORBIDDEN'|'INVALID_EVIDENCE'|'INCOMPLETE'|'NOT_FOUND'|'STORAGE_FAILED',readonly operation:string){super(`Original development ${operation} failed (${code})`);}
}

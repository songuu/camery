import { z } from 'zod';
import { Id,Integer,LocalId,Text } from '../contracts.js';

export const OpeningHookType=z.enum(['conflict','mystery','danger','identity','contrast']);
export const CliffhangerType=z.enum(['life_or_death','partial_reveal','first_counterattack','escalation','identity_near','choice']);
export const GenreId=z.enum(['rebirth-revenge','sweet-romance','suspense']);
export type GenreId=z.infer<typeof GenreId>;
export const RuleThresholdsSchema=z.strictObject({
  repeatedCliffhangerWindow:Integer.min(2).max(100),lowEmotionWindow:Integer.min(2).max(100),
  lowEmotionBelow:z.number().min(0).max(10),openingHookBySecond:Integer.min(1).max(60),stakesBySecond:Integer.min(1).max(120),
});
export type RuleThresholds=z.infer<typeof RuleThresholdsSchema>;
export const OutlineContextSchema=z.strictObject({
  episodeCount:Integer.min(1).max(100),targetSeconds:Integer.min(1).max(3600),
  paidEpisodeNumbers:z.array(Integer.min(1).max(100)).max(100),mainGenre:GenreId,auxiliaryGenres:z.array(GenreId).max(2),
  sourceRefIds:z.array(Id).min(1).max(2048),
});
export type OutlineContext=z.infer<typeof OutlineContextSchema>;
const SourceRefs=z.array(Id).max(64);
const LocalRefs=z.array(LocalId).min(1).max(500);
const EpisodeNumber=Integer.min(1).max(100);
const Origin=z.strictObject({kind:z.enum(['adapted','invented']),sourceRefIds:SourceRefs});
export const OutlineOutputSchema=z.strictObject({
  adaptation:z.strictObject({title:Text(120),logline:Text(1000),audience:Text(500),promise:Text(1000),centralConflict:Text(1000),
    decisions:z.array(z.strictObject({id:LocalId,action:z.enum(['keep','merge','cut','invent']),reason:Text(1000),sourceRefIds:SourceRefs})).min(1).max(128)}),
  recipe:z.strictObject({mainGenre:GenreId,auxiliaryGenres:z.array(GenreId).max(2),collision:Text(1000),
    signatureScenes:z.array(z.strictObject({id:LocalId,description:Text(1000),beatIds:LocalRefs})).min(1).max(32),failureModes:z.array(Text(500)).min(1).max(16),
    ablations:z.array(z.strictObject({genre:GenreId,affectedBeatIds:LocalRefs,removalEffect:Text(1000),mainlineSurvives:z.boolean(),reason:Text(1000)})).max(2)}),
  characters:z.array(z.strictObject({id:LocalId,name:Text(120),function:z.enum(['protagonist','antagonist','supporting']),
    desire:Text(500),obstacle:Text(500),arc:Text(1000),origin:Origin})).min(1).max(64),
  beats:z.array(z.strictObject({id:LocalId,episodeNumber:EpisodeNumber,order:Integer.min(1).max(500),characterIds:LocalRefs,
    goal:Text(500),conflict:Text(500),turn:Text(500),consequence:Text(500),origin:Origin})).min(1).max(500),
  episodes:z.array(z.strictObject({number:EpisodeNumber,title:Text(120),synopsis:Text(2000),beatIds:LocalRefs,
    openingHook:z.strictObject({type:OpeningHookType,text:Text(500),beatId:LocalId,estimatedSecond:Integer.max(3600)}),
    stakes:z.strictObject({text:Text(500),beatId:LocalId,estimatedSecond:Integer.max(3600)}),
    cliffhanger:z.strictObject({type:CliffhangerType,text:Text(500),beatId:LocalId}),
    emotionIntensity:z.number().min(0).max(10),paidBreakpoint:z.boolean(),
  })).min(1).max(100),
  assets:z.array(z.strictObject({id:LocalId,kind:z.enum(['character','location','prop','appearance','sfx','music','vfx']),
    name:Text(120),description:Text(1000),narrativeRole:Text(1000),characterId:LocalId.nullable(),beatIds:LocalRefs,origin:Origin,
    propStates:z.array(z.strictObject({beatId:LocalId,before:Text(500),after:Text(500),reason:Text(500)})).max(100),
  })).min(1).max(256),
  plotUnits:z.array(z.strictObject({id:LocalId,episodeNumbers:z.array(EpisodeNumber).min(1).max(100),beatIds:LocalRefs,
    pressure:Text(1000),escalation:Text(1000),reversal:Text(1000),release:Text(1000),nextCrisis:Text(1000)})).min(1).max(100),
  seasonEngine:z.strictObject({centralQuestion:Text(1000),protagonistGoal:Text(1000),opposition:Text(1000),
    repeatablePressure:Text(1000),escalation:Text(1000),endState:Text(1000),characterIds:LocalRefs,plotUnitIds:LocalRefs}),
});
export type OutlineOutput=z.infer<typeof OutlineOutputSchema>;
export const OUTLINE_BYTES=524288;
export type OutlineIssueCode='REPEATED_CLIFFHANGER'|'LOW_EMOTION'|'LATE_OPENING_HOOK'|'LATE_STAKES'|'ABLATION_REVIEW';
export interface OutlineIssue {readonly id:string;readonly code:OutlineIssueCode;readonly path:string;readonly episodeNumbers:readonly number[];readonly detail:string}
export class OutlineError extends Error {
  override readonly name='OutlineError';
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT'|'INVALID_REFERENCE'|'INCOMPLETE'|'CONFLICT'|'FORBIDDEN'|'INVALID_EVIDENCE'|'NOT_FOUND'|'STORAGE_FAILED',readonly operation:string,readonly path:string){
    super(`Outline ${operation} failed (${code}) at ${path}`);
  }
}

import {z} from 'zod';
import {StableId,RevisionRef,ContinuityLedgerSchema,ContinuityEventSchema,EventRefSchema} from '@camery/ir';
import {ContinuityContextSchema} from '../continuity/contracts.js';
import {Hash,Id,Integer,LocalId,Text} from '../contracts.js';
import {OpeningHookType,CliffhangerType} from '../outline/contracts.js';

export const SCREENPLAY_CONTEXT_BYTES=67_108_864;
export const SCREENPLAY_DRAFT_BYTES=1_048_576;
export const SCREENPLAY_OUTPUT_BYTES=4_194_304;
export const SCREENPLAY_CANDIDATE_BYTES=8_388_608;
export const ScreenplayVoiceKindSchema=z.enum(['on_screen','inner_monologue','off_screen','narration']);
export type ScreenplayVoiceKind=z.infer<typeof ScreenplayVoiceKindSchema>;
export const ScreenplayBeatKindSchema=z.enum(['action','dialogue','narration']);
const range=z.strictObject({minMs:Integer,maxMs:Integer});
export const ScreenplayRateSchema=z.strictObject({minCharactersPerSecond:z.number().finite().positive(),maxCharactersPerSecond:z.number().finite().positive()});
export const ScreenplaySpeechProfileSchema=z.strictObject({id:Id,version:Integer.min(1),rates:z.strictObject({on_screen:ScreenplayRateSchema,inner_monologue:ScreenplayRateSchema,off_screen:ScreenplayRateSchema,narration:ScreenplayRateSchema})});
export const ScreenplayFirstEpisodeProfileSchema=z.strictObject({id:Id,version:Integer.min(1),modules:z.array(z.strictObject({id:LocalId,label:Text(120),purpose:Text(1000),minBeats:Integer.min(1).max(2048),requiredKinds:z.array(ScreenplayBeatKindSchema).max(3)})).length(5)});
export const ScreenplayRulesSchema=z.strictObject({version:z.literal(1),speech:ScreenplaySpeechProfileSchema,firstEpisode:ScreenplayFirstEpisodeProfileSchema.nullable()});
export type ScreenplayRules=z.infer<typeof ScreenplayRulesSchema>;
export const ScreenplayCitationSchema=z.strictObject({referenceId:Id,relationship:z.enum(['adapted','quoted','inspired']),quote:Text(2000).nullable()});
export const ScreenplayLineSchema=z.strictObject({id:LocalId,speakerId:StableId,kind:ScreenplayVoiceKindSchema,text:Text(8000),delivery:Text(1000)});
export const ScreenplayBeatSchema=z.strictObject({id:LocalId,kind:ScreenplayBeatKindSchema,summary:Text(4000),outlineBeatIds:z.array(StableId).max(500),
  origin:z.strictObject({kind:z.enum(['adapted','invented']),reason:Text(1000).nullable(),citations:z.array(ScreenplayCitationSchema).max(64)}),plannedPause:range,lines:z.array(ScreenplayLineSchema).max(8192)});
export const ScreenplaySceneSchema=z.strictObject({id:LocalId,title:Text(120),locationId:StableId.nullable(),characterIds:z.array(StableId).max(16384),startState:Text(4000),endState:Text(4000),beats:z.array(ScreenplayBeatSchema).min(1).max(2048)});
const localEvidence=z.strictObject({event:z.strictObject({kind:z.enum(['beat','line']),id:LocalId}),quote:Text(2000)});
export const ScreenplayContinuityEventSchema=z.discriminatedUnion('op',[
  ContinuityEventSchema.options[0].extend({evidence:localEvidence}),
  ...ContinuityEventSchema.options.slice(1).map(option=>option.extend({evidence:localEvidence})),
]);
export const ScreenplayDraftSchema=z.strictObject({version:z.literal(1),episodeId:StableId,title:Text(120),scenes:z.array(ScreenplaySceneSchema).min(1).max(128),
  openingHook:z.strictObject({beatId:LocalId,type:OpeningHookType,reason:Text(1000)}).nullable(),
  closingHook:z.strictObject({beatId:LocalId,type:CliffhangerType,reason:Text(1000)}).nullable(),
  modules:z.array(z.strictObject({moduleId:LocalId,beatIds:z.array(LocalId).min(1).max(2048)})).max(5),continuity:z.array(ScreenplayContinuityEventSchema).max(2048)});
export type ScreenplayDraft=z.infer<typeof ScreenplayDraftSchema>;
export const ScreenplayReferenceSchema=z.strictObject({id:Id,path:Text(256),kind:z.enum(['reviewed_bible','original_development']),text:Text(524288),quotes:z.array(Text(2000)).max(65536)});
export type ScreenplayReference=z.infer<typeof ScreenplayReferenceSchema>;
/** Read-only projected writing data. A trusted Node source reader must establish actual adoption and freshness. */
export const ScreenplayContextSchema=z.strictObject({version:z.literal(1),schemaVersion:z.enum(['0.7.0-draft','0.8.0-draft']),projectId:StableId,packageId:StableId,snapshotRevision:Integer.min(1),
  episode:z.strictObject({id:StableId,version:Integer.min(1),number:Integer.min(1).max(100),title:Text(120),targetSeconds:z.number().finite().positive()}),
  outline:z.strictObject({plan:RevisionRef,episodePlan:RevisionRef,sourceDigest:Hash,synopsis:Text(2000),
    openingHook:z.strictObject({type:OpeningHookType,text:Text(500),beat:RevisionRef}),cliffhanger:z.strictObject({type:CliffhangerType,text:Text(500),beat:RevisionRef}),
    beats:z.array(z.strictObject({ref:RevisionRef,order:Integer.min(1).max(500),characters:z.array(RevisionRef).max(500),goal:Text(500),conflict:Text(500),turn:Text(500),consequence:Text(500),referenceIds:z.array(Id).max(64)})).min(1).max(500)}),
  characters:z.array(z.strictObject({id:StableId,version:Integer.min(1),name:Text(120),role:Text(1000)})).max(16384),
  locations:z.array(z.strictObject({id:StableId,version:Integer.min(1),name:Text(120),description:Text(4000)})).max(65536),references:z.array(ScreenplayReferenceSchema).max(2048),
  previous:z.strictObject({episode:z.strictObject({id:StableId,version:Integer.min(1),number:Integer.min(1).max(100)}),snapshot:RevisionRef,adoptedRevision:Integer.min(1),proofDigest:Hash,ledger:ContinuityLedgerSchema}).nullable(),nativeContext:ContinuityContextSchema,rules:ScreenplayRulesSchema});
export type ScreenplayContext=z.infer<typeof ScreenplayContextSchema>;
export const ScreenplayIssueCodeSchema=z.enum(['DUPLICATE_ID','UNKNOWN_CHARACTER','SCENE_SPEAKER','UNKNOWN_LOCATION','UNKNOWN_OUTLINE_BEAT','OUTLINE_COVERAGE','UNKNOWN_SOURCE','SOURCE_QUOTE','ORIGIN_REQUIRED','VOICE_SEMANTICS','PLANNED_RANGE','FIRST_EPISODE_CONFIG','FIRST_EPISODE_MODULE','MODULE_REVIEW','MISSING_OPENING_HOOK','LATE_OPENING_HOOK','HOOK_TYPE_CHANGED','HOOK_REVIEW','CLOSING_HOOK','ACTION_TIMING','TIMING_BUDGET','NO_SPOKEN_UNITS','CONTINUITY_REFERENCE','CONTINUITY_RULE','CONTINUITY_REVIEW']);
export type ScreenplayIssueCode=z.infer<typeof ScreenplayIssueCodeSchema>;
export const ScreenplayIssueSchema=z.strictObject({id:Text(3000),code:ScreenplayIssueCodeSchema,severity:z.enum(['error','warning']),path:Text(2048),detail:Text(2000),audienceImpact:Text(1000),remedy:Text(1000),collateralImpact:z.array(Text(1000)).max(16)});
export type ScreenplayIssue=z.infer<typeof ScreenplayIssueSchema>;
export const ScreenplayReportSchema=z.strictObject({version:z.literal(1),kind:z.literal('screenplay_check'),ruleVersion:z.literal('screenplay-v1'),episodeId:StableId,issues:z.array(ScreenplayIssueSchema).max(65536)});
export type ScreenplayReport=z.infer<typeof ScreenplayReportSchema>;
/** A candidate projection uses provisional event refs and can never establish native adoption authority. */
export const ScreenplayContinuityPreviewSchema=z.strictObject({version:z.literal(1),kind:z.literal('candidate_projection'),episodeId:StableId,
  references:z.array(z.strictObject({localId:LocalId,kind:z.enum(['beat','line']),ref:EventRefSchema})).max(10240),ledger:ContinuityLedgerSchema.nullable(),issues:z.array(ScreenplayIssueSchema).max(65536)});
export type ScreenplayContinuityPreview=z.infer<typeof ScreenplayContinuityPreviewSchema>;
export const ScreenplayTimingSchema=z.strictObject({version:z.literal(1),kind:z.literal('estimated'),basis:z.literal('configured_unicode_letter_or_number_rate'),profile:z.strictObject({id:Id,version:Integer.min(1)}),episodeId:StableId,total:range,
  scenes:z.array(z.strictObject({sceneId:LocalId,total:range,beats:z.array(z.strictObject({beatId:LocalId,plannedPause:range,total:range,lines:z.array(z.strictObject({lineId:LocalId,kind:ScreenplayVoiceKindSchema,units:Integer,duration:range})).max(8192)})).max(2048)})).max(128)});
export type ScreenplayTiming=z.infer<typeof ScreenplayTimingSchema>;
const bookLine=z.strictObject({id:LocalId,sceneId:LocalId,beatId:LocalId,sequence:Integer.min(1),kind:ScreenplayVoiceKindSchema,text:Text(8000),delivery:Text(1000),lipSync:z.enum(['eligible_if_visible','never'])});
export const ScreenplayLineBookSchema=z.strictObject({version:z.literal(1),episodeId:StableId,title:Text(120),lineCount:Integer,order:z.array(LocalId).max(8192),speakers:z.array(z.strictObject({character:RevisionRef,name:Text(120),lines:z.array(bookLine).min(1).max(8192)})).max(16384)});
export type ScreenplayLineBook=z.infer<typeof ScreenplayLineBookSchema>;
export class ScreenplayError extends Error{
  override readonly name='ScreenplayError';
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT'|'INVALID_REFERENCE'|'INCOMPLETE'|'CONFLICT'|'FORBIDDEN'|'NOT_FOUND'|'STORAGE_FAILED',readonly operation:string,readonly path:string){super(`Screenplay ${operation} failed (${code}) at ${path}`);}
}

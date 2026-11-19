import {z} from 'zod';
import {StableId,RevisionRef} from '@camery/ir';
import {Id,Integer,LocalId,Text} from '../../contracts.js';
import {ScreenplayDraftSchema,ScreenplaySceneSchema} from '../contracts.js';

export const SCREENPLAY_MODEL_INPUT_BYTES=2_097_152;
// A complete decision and receipt must also fit the existing 1MiB Durable journal; never widen that boundary implicitly.
export const SCREENPLAY_MODEL_OUTPUT_BYTES=524_288;
export const SCREENPLAY_GENERATED_BYTES=16_777_216;
const evidence=z.strictObject({event:z.strictObject({kind:z.enum(['beat','line']),id:LocalId}),quote:Text(2000)});
const event={id:LocalId,order:Integer.min(1).max(2048),evidence};
const nullableId=StableId.nullable();
const facts=z.array(z.strictObject({...event,factId:LocalId,kind:z.enum(['fact','world_rule','timeline']),text:Text(1000)})).max(2048);
/** Provider DTO uses only strict objects, arrays and nullable strings supported by the existing Method contract. */
export const ScreenplayModelContinuitySchema=z.strictObject({
  assertFacts:facts,
  retireFacts:z.array(z.strictObject({...event,factId:LocalId})).max(2048),
  learnFacts:z.array(z.strictObject({...event,characterId:StableId,factId:LocalId,source:z.strictObject({kind:z.enum(['witness','told','deduced']),fromCharacterId:nullableId,factIds:z.array(LocalId).max(32)})})).max(2048),
  useFacts:z.array(z.strictObject({...event,characterId:StableId,factId:LocalId})).max(2048),
  setCharacters:z.array(z.strictObject({...event,characterId:StableId,summary:Text(1000),appearance:z.strictObject({id:nullableId,version:Integer}),spot:z.strictObject({id:nullableId,locationId:nullableId,locationVersion:Integer}),holding:z.array(RevisionRef).max(64)})).max(2048),
  plantThreads:z.array(z.strictObject({...event,threadId:LocalId,summary:Text(1000),payoffEpisodeId:nullableId})).max(2048),
  payoffThreads:z.array(z.strictObject({...event,threadId:LocalId})).max(2048),
});
export const ScreenplayModelOutputSchema=z.strictObject({version:z.literal(1),episodeId:StableId,title:Text(120),scenes:z.array(ScreenplaySceneSchema).min(1).max(128),
  openingHook:ScreenplayDraftSchema.shape.openingHook.unwrap(),closingHook:ScreenplayDraftSchema.shape.closingHook.unwrap(),modules:ScreenplayDraftSchema.shape.modules,continuity:ScreenplayModelContinuitySchema});
export type ScreenplayModelOutput=z.infer<typeof ScreenplayModelOutputSchema>;
export const ScreenplayGenerationNotesSchema=Text(2000);
export const ScreenplayGenerationScopeSchema=z.strictObject({tenantId:Id,projectId:Id});

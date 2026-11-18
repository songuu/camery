import {z} from 'zod';
import {StableId,OUTLINE_FORMAL_BYTES} from '@camery/ir';
import {Id,LocalId,Hash,Integer,Text} from '../../contracts.js';
import {OutlineKeySchema} from './persistence-contracts.js';

export const OUTLINE_MAPPING_INPUT_BYTES=67108864;
export const OUTLINE_MAPPING_CHANGE_BYTES=OUTLINE_FORMAL_BYTES;
export const OUTLINE_MAPPING_MAX_OPERATIONS=4096;
export const OUTLINE_MAPPING_MAX_IDS=131072;

const stable=StableId.refine(value=>value.length===26);
const revision=Integer.min(1);

/** These addresses identify stored evidence; neither a digest nor an identity binding grants authority. */
export const OutlineAdoptionSourceSchema=OutlineKeySchema.extend({runDigest:Hash,briefDigest:Hash,candidateDigest:Hash,reviewDigest:Hash,sourceDigest:Hash});
export type OutlineAdoptionSource=z.infer<typeof OutlineAdoptionSourceSchema>;
export const OutlineVersionKeySchema=z.strictObject({tenantId:stable,projectId:stable});
export type OutlineVersionKey=z.infer<typeof OutlineVersionKeySchema>;
export const OutlineIdentityPreparationSchema=z.strictObject({source:OutlineAdoptionSourceSchema,target:OutlineVersionKeySchema});
export type OutlineIdentityPreparation=z.infer<typeof OutlineIdentityPreparationSchema>;
export const OutlineLocalBindingSchema=z.strictObject({localId:LocalId,id:stable});
export type OutlineLocalBinding=z.infer<typeof OutlineLocalBindingSchema>;
export const OutlineFormalIdentitiesSchema=z.strictObject({
  tenantId:Id,projectId:Id,target:OutlineVersionKeySchema,owner:z.strictObject({runId:Id,runDigest:Hash}),planId:stable,
  characters:z.array(OutlineLocalBindingSchema).min(1).max(64),beats:z.array(OutlineLocalBindingSchema).min(1).max(500),
  episodes:z.array(z.strictObject({number:Integer.min(1).max(100),episodeId:stable,planId:stable})).min(1).max(100),
  assets:z.array(OutlineLocalBindingSchema).min(1).max(256),plotUnits:z.array(OutlineLocalBindingSchema).min(1).max(100),
  decisions:z.array(OutlineLocalBindingSchema).min(1).max(128),
});
export type OutlineFormalIdentities=z.infer<typeof OutlineFormalIdentitiesSchema>;
export const OutlineReviewerBindingSchema=z.strictObject({key:Id,id:stable});
export type OutlineReviewerBinding=z.infer<typeof OutlineReviewerBindingSchema>;

export const OutlineMappingCollectionSchema=z.enum(['characters','episodes','adaptation_plans','outline_beats','outline_episode_plans','asset_plans','outline_plot_units','outline_adaptation_decisions']);
export type OutlineMappingCollection=z.infer<typeof OutlineMappingCollectionSchema>;
const value=z.record(z.string(),z.unknown());
export const OutlineMappingOperationSchema=z.discriminatedUnion('op',[
  z.strictObject({op:z.literal('add'),collection:OutlineMappingCollectionSchema,value}),
  z.strictObject({op:z.literal('replace'),collection:OutlineMappingCollectionSchema,target:stable,value}),
  z.strictObject({op:z.literal('remove'),collection:OutlineMappingCollectionSchema,target:stable}),
]);
export type OutlineMappingOperation=z.infer<typeof OutlineMappingOperationSchema>;
// The host snapshots JSON before parsing and separately verifies complete mappings and immutable evidence.
export const OutlineMappingDraftSchema=z.strictObject({
  version:z.literal(1),target:OutlineVersionKeySchema,source:OutlineAdoptionSourceSchema,baseRevision:revision,
  baseRevisions:z.array(z.strictObject({id:stable,version:revision})).max(OUTLINE_MAPPING_MAX_IDS),
  operations:z.array(z.strictObject({slot:Text(160),op:OutlineMappingOperationSchema})).max(OUTLINE_MAPPING_MAX_OPERATIONS),
  reservedIds:z.array(stable).max(OUTLINE_MAPPING_MAX_IDS),
});
export type OutlineMappingDraft=z.infer<typeof OutlineMappingDraftSchema>;

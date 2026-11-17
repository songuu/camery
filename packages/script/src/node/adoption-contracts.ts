import {z} from 'zod';
import {StableId} from '@camery/ir';
import {Id,LocalId,Hash,Integer} from '../contracts.js';
import {DevelopmentAdoptionSourceSchema} from './contracts.js';

export const FormalStableId=StableId.refine(value=>value.length===26);
export const DevelopmentVersionKeySchema=z.strictObject({tenantId:FormalStableId,projectId:FormalStableId});
export const DevelopmentIdentityPreparationSchema=z.strictObject({source:DevelopmentAdoptionSourceSchema,target:DevelopmentVersionKeySchema});
const localBinding=z.strictObject({localId:LocalId,id:FormalStableId});
export const DevelopmentFormalIdentitiesSchema=z.strictObject({tenantId:Id,projectId:Id,target:DevelopmentVersionKeySchema,
  foundationOwner:z.strictObject({runId:Id,runDigest:Hash}),planId:FormalStableId,worldId:FormalStableId,
  characters:z.array(localBinding).min(1).max(32),relationships:z.array(localBinding).max(64),
  episodes:z.array(z.strictObject({number:Integer.min(1).max(100),episodeId:FormalStableId,planId:FormalStableId})).min(1).max(100),
});
export type DevelopmentFormalIdentities=z.infer<typeof DevelopmentFormalIdentitiesSchema>;
export const DevelopmentReviewerBindingsSchema=z.strictObject({foundation:z.strictObject({key:Id,id:FormalStableId}),episodes:z.strictObject({key:Id,id:FormalStableId})});
export type DevelopmentReviewerBindings=z.infer<typeof DevelopmentReviewerBindingsSchema>;

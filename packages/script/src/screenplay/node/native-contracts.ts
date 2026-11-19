import {z} from 'zod';
import {StableId} from '@camery/ir';
import {Hash,Integer,Text} from '../../contracts.js';
import {ContinuityTargetSchema} from '../../continuity/node/persistence-contracts.js';
import {ScreenplayKeySchema} from './contracts.js';
import {ScreenplayNativeMappingSchema} from './native-mapping.js';
export const ScreenplayNativeIdentitySchema=z.strictObject({slot:Text(160),id:StableId.refine(value=>value.length===26)});
export const ScreenplayNativeBindingSchema=z.strictObject({version:z.literal(1),key:ScreenplayKeySchema,mapping:ScreenplayNativeMappingSchema,ids:z.array(ScreenplayNativeIdentitySchema).max(40000),digest:Hash});
export type ScreenplayNativeBinding=z.infer<typeof ScreenplayNativeBindingSchema>;
export const ScreenplayNativeReceiptSchema=z.strictObject({version:z.literal(1),key:ScreenplayKeySchema,target:ContinuityTargetSchema,changeId:StableId,reviewDigest:Hash,bindingDigest:Hash,
  fromRevision:Integer.min(1),toRevision:Integer.min(1),actor:z.strictObject({kind:z.literal('user'),id:StableId}),scope:z.strictObject({kind:z.literal('episode'),id:StableId}),at:z.iso.datetime({precision:3}),digest:Hash});
export type ScreenplayNativeReceipt=z.infer<typeof ScreenplayNativeReceiptSchema>;
export const ScreenplayExpectationSchema=z.strictObject({expectedSnapshotRevision:Integer.min(1),expectedWriteVersion:Integer.min(1)});

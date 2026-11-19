import {z} from 'zod';
import {ChangeSetV08,ContinuitySnapshotSchema,StableId} from '@camery/ir';
import {Hash,Integer} from '../../contracts.js';
import {ContinuityKeySchema,ContinuityTargetSchema} from './persistence-contracts.js';

const stable=StableId.refine(value=>value.length===26);
const snapshot=z.strictObject({id:stable,version:Integer.min(1)});
const author=z.strictObject({kind:z.literal('user'),id:stable});
export const CONTINUITY_NATIVE_RECORD_BYTES=8_388_608;
/** Provenance of one exact native request; it is not an adoption decision. */
export const ContinuityNativeBindingSchema=z.strictObject({version:z.literal(1),key:ContinuityKeySchema,target:ContinuityTargetSchema,
  candidateDigest:Hash,reviewDigest:Hash,sourceRevision:Integer.min(1),packageDigest:Hash,episodeId:stable,
  changeId:stable,snapshot,operationId:stable,author,requestDigest:Hash,digest:Hash});
export type ContinuityNativeBinding=z.infer<typeof ContinuityNativeBindingSchema>;
export const ContinuityNativeMappingSchema=z.strictObject({binding:ContinuityNativeBindingSchema,request:ChangeSetV08,snapshot:ContinuitySnapshotSchema});
export type ContinuityNativeMapping=z.infer<typeof ContinuityNativeMappingSchema>;
/** Written only by the native transaction callback after the actual object and human adoption exist. */
export const ContinuityNativeReceiptSchema=z.strictObject({version:z.literal(1),key:ContinuityKeySchema,target:ContinuityTargetSchema,
  bindingDigest:Hash,reviewDigest:Hash,changeId:stable,snapshot,ledgerDigest:Hash,fromRevision:Integer.min(1),toRevision:Integer.min(1),
  actor:author,scope:z.strictObject({kind:z.literal('episode'),id:stable}),at:z.iso.datetime({precision:3}),digest:Hash});
export type ContinuityNativeReceipt=z.infer<typeof ContinuityNativeReceiptSchema>;

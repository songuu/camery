import { z } from 'zod';
import { Pin } from '@camery/methods';
import type { MethodPin } from '@camery/methods';
import { Name } from '@camery/agents';
import { BibleError, Hash, Id, Integer } from '../contracts.js';
import type { BibleCandidate, ChunkPlan, ChunkRecord, ConfirmedBible, RejectedBible, ReviewHost, SourceSnapshot } from '../contracts.js';
import { copy, freeze, hash, parse } from '../data.js';

const ModelName=Name.refine(value=>value.isWellFormed());
export const ExecutionSchema=z.strictObject({
  connectionId:ModelName,modeDigest:Hash,modelIdentity:ModelName,evidence:z.enum(['live_model','synthetic_replay']),modelTier:z.enum(['economy','balanced','quality']),
  currency:z.string().regex(/^[A-Z]{3}$(?![\s\S])/),reservation:z.strictObject({tokens:Integer.min(1),costMicros:Integer}),
  pricing:z.strictObject({inputMicrosPerMillionTokens:Integer,outputMicrosPerMillionTokens:Integer}).optional(),
  limits:z.strictObject({steps:Integer.min(1),tokens:Integer,costMicros:Integer}),
});
export type BibleExecution=z.infer<typeof ExecutionSchema>;
export const RunKeySchema=z.strictObject({tenantId:Id,projectId:Id,runId:Id});
export type BibleRunKey=z.infer<typeof RunKeySchema>;
export const BibleReviewedSourceSchema=RunKeySchema.extend({runDigest:Hash,documentId:Id,revision:Integer.min(1),sourceDigest:Hash,reviewDigest:Hash});
export type BibleReviewedSource=z.infer<typeof BibleReviewedSourceSchema>;
export const StartRunSchema=RunKeySchema.extend({documentId:Id,kind:z.enum(['novel','script']),expectedRevision:Integer.min(1),expectedSourceDigest:Hash,
  method:Pin,execution:ExecutionSchema,chunkLimits:z.strictObject({maxCharacters:Integer.min(2).max(20000).optional(),maxBytes:Integer.min(4).max(60000).optional()}).optional()});
export type StartBibleRun=z.infer<typeof StartRunSchema>;
export interface BibleRun extends BibleRunKey {
  readonly source:SourceSnapshot;readonly plan:ChunkPlan;readonly method:MethodPin;readonly execution:BibleExecution;readonly digest:string;readonly createdAt:string;
}
export interface BibleProgress {
  readonly run:BibleRun;readonly records:readonly ChunkRecord[];readonly candidate:BibleCandidate|null;readonly review:ConfirmedBible|RejectedBible|null;
}
/** Internal trusted-host API. Authentication, durable leases and model credentials are not supplied by request JSON. */
export interface BibleStore {
  start(input:unknown):Promise<BibleRun>;
  read(key:BibleRunKey):Promise<BibleProgress>;
  saveChunk(key:BibleRunKey,record:ChunkRecord):Promise<ChunkRecord>;
  materialize(key:BibleRunKey):Promise<BibleCandidate>;
  isCurrent(key:BibleRunKey):Promise<boolean>;
  confirm(key:BibleRunKey,decision:unknown,host:ReviewHost):Promise<ConfirmedBible>;
  reject(key:BibleRunKey,reason:unknown,host:ReviewHost):Promise<RejectedBible>;
}
export function executionForChunks(input:unknown,chunks:number):BibleExecution {
  const execution=parse(ExecutionSchema,copy(input),'execution');
  if(!Number.isInteger(chunks)||chunks<1||chunks>4096)throw new BibleError('INVALID_INPUT','chunk budget count');
  if(execution.evidence==='live_model'&&(!execution.pricing||execution.pricing.inputMicrosPerMillionTokens>0||execution.pricing.outputMicrosPerMillionTokens>0)&&execution.reservation.costMicros===0)
    throw new BibleError('INVALID_INPUT','model cost reservation');
  const count=BigInt(chunks);const {reservation,limits}=execution;
  if(count<1n||count>4096n||count>BigInt(limits.steps)||count*BigInt(reservation.tokens)>BigInt(limits.tokens)||count*BigInt(reservation.costMicros)>BigInt(limits.costMicros))
    throw new BibleError('INPUT_LIMIT','run budget shares');
  return freeze(execution);
}
/** Full text is pinned separately; its validated identity and plan bind the bounded run digest. */
export function bibleRunDigest(plan:ChunkPlan,method:MethodPin,execution:BibleExecution):string{return hash({version:1,plan,method,execution});}

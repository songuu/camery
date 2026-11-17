import { z } from 'zod';
import { MethodRegistry,Pin } from '@camery/methods';
import { stepIdempotencyKey } from '@camery/durable';
import { DevelopmentError,Hash,Id,Integer } from '../../contracts.js';
import { EpisodeExecutionSchema,executionForEpisodes } from '../../node/contracts.js';
import type { DevelopmentExecution } from '../../node/contracts.js';
import { canonicalTime } from '../../reviewed.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OutlineBriefInputSchema,OutlineSourceDescriptorSchema,OUTLINE_ENVELOPE_BYTES } from '../generation-contracts.js';
import type { OutlineBrief,OutlineCandidate,OutlineReviewHost,OutlineSourceSnapshot,ReviewedOutline,RejectedOutline } from '../generation-contracts.js';
import { validateOutlineBrief } from './brief.js';
import { hash } from './data.js';
import { createOutlineMethodPack } from './method-assets.js';
import { validateOutlineSourceSnapshot } from './source.js';

export const OutlineKeySchema=z.strictObject({tenantId:Id,projectId:Id,runId:Id});
export type OutlineRunKey=z.infer<typeof OutlineKeySchema>;
export const OutlineBriefKeySchema=OutlineKeySchema.omit({runId:true}).extend({briefId:Id});
export type OutlineBriefKey=z.infer<typeof OutlineBriefKeySchema>;
export const PutOutlineBriefSchema=OutlineBriefInputSchema.omit({revision:true}).extend({expectedRevision:Integer.max(Number.MAX_SAFE_INTEGER-1),actorId:Id});
export const GetOutlineBriefSchema=OutlineBriefKeySchema.extend({revision:Integer.min(1).optional()});
export const StartOutlineSchema=OutlineKeySchema.extend({briefId:Id,expectedRevision:Integer.min(1),expectedBriefDigest:Hash,source:OutlineSourceDescriptorSchema,execution:EpisodeExecutionSchema});
export type OutlineExecution=DevelopmentExecution;
export interface OutlineRun extends OutlineRunKey {
  readonly version:1;readonly brief:OutlineBrief;readonly source:OutlineSourceSnapshot;readonly method:z.infer<typeof Pin>;
  readonly execution:OutlineExecution;readonly digest:string;readonly createdAt:string;
}
export interface StoredOutlineBrief {readonly brief:OutlineBrief;readonly actorId:string;readonly createdAt:string}
export interface OutlineProgress {readonly run:OutlineRun;readonly candidate:OutlineCandidate|null;readonly review:ReviewedOutline|RejectedOutline|null}
export interface OutlineStore {
  putBrief(input:unknown):Promise<StoredOutlineBrief>;
  getBrief(input:z.infer<typeof GetOutlineBriefSchema>):Promise<StoredOutlineBrief>;
  start(input:unknown):Promise<OutlineRun>;
  read(key:OutlineRunKey):Promise<OutlineProgress>;
  isCurrent(key:OutlineRunKey):Promise<boolean>;
  saveCandidate(key:OutlineRunKey,candidate:OutlineCandidate):Promise<OutlineCandidate>;
  review(key:OutlineRunKey,decision:unknown,host:OutlineReviewHost):Promise<ReviewedOutline>;
  reject(key:OutlineRunKey,reason:unknown,host:OutlineReviewHost):Promise<RejectedOutline>;
}
export function outlineExecution(input:unknown):OutlineExecution{
  try{return executionForEpisodes(input);}
  catch(error){throw new OutlineError(error instanceof DevelopmentError&&error.code==='INPUT_LIMIT'?'INPUT_LIMIT':'INVALID_INPUT','execution','execution');}
}
const RunRecord=OutlineKeySchema.extend({version:z.literal(1),brief:z.unknown(),source:z.unknown(),method:Pin,execution:EpisodeExecutionSchema});
export const OutlineRunEnvelope=RunRecord.extend({digest:Hash,createdAt:z.string().max(24)});
export function outlineRunDigest(input:unknown):string{return hash(capture(RunRecord,input,'run identity',OUTLINE_ENVELOPE_BYTES));}
export function validateOutlineRun(keyInput:unknown,input:unknown):OutlineRun{
  const key=capture(OutlineKeySchema,keyInput,'run key',2048);const raw=capture(OutlineRunEnvelope,input,'run',OUTLINE_ENVELOPE_BYTES);
  const brief=validateOutlineBrief(raw.brief),source=validateOutlineSourceSnapshot(raw.source),execution=outlineExecution(raw.execution);
  const method=new MethodRegistry().register(createOutlineMethodPack());
  const body={version:1 as const,...key,brief,source,method,execution};
  if(raw.tenantId!==key.tenantId||raw.projectId!==key.projectId||raw.runId!==key.runId||brief.tenantId!==key.tenantId||brief.projectId!==key.projectId||source.descriptor.tenantId!==key.tenantId||source.descriptor.projectId!==key.projectId
    ||hash(raw.method)!==hash(method)||!canonicalTime(raw.createdAt)||outlineRunDigest(body)!==raw.digest)throw new OutlineError('CONFLICT','run binding','run');
  return deepFreeze({...body,digest:raw.digest,createdAt:raw.createdAt});
}
export const OUTLINE_WORKFLOW='adaptation.outline-stage';
export const OUTLINE_WORKFLOW_VERSION=1;
export function outlineTaskId(input:unknown):string{return 'outline-'+hash(capture(OutlineKeySchema,input,'task key',2048));}
export function outlineCallId(input:unknown):string{
  const key=capture(OutlineKeySchema,input,'call key',2048);return stepIdempotencyKey({tenantId:key.tenantId,taskId:outlineTaskId(key)},'agent.0.decision');
}

import {z} from 'zod';
import {Pin,ModelReceiptSchema} from '@camery/methods';
import {Id,Hash,Integer} from '../../contracts.js';
import {EpisodeExecutionSchema} from '../../node/contracts.js';
import {ScreenplayContextSchema,ScreenplayRulesSchema} from '../contracts.js';
import {ContinuityPreviousSchema,ContinuityTargetSchema} from '../../continuity/node/persistence-contracts.js';
import {ScreenplayScopeSchema,ScreenplayKeySchema,ScreenplayCandidateSchema} from './contracts.js';
import {ScreenplayModelOutputSchema,ScreenplayGenerationNotesSchema} from './model-contracts.js';
import {ScreenplaySourceSchema} from './source.js';
export const ScreenplayGenerationKeySchema=ScreenplayScopeSchema.extend({runId:Id});
export type ScreenplayGenerationKey=z.infer<typeof ScreenplayGenerationKeySchema>;
export const StartScreenplayGenerationSchema=z.strictObject({key:ScreenplayGenerationKeySchema,candidateId:Id,target:ContinuityTargetSchema,episodeId:ScreenplayContextSchema.shape.episode.shape.id,
  expectedSnapshotRevision:Integer.min(1),expectedPackageDigest:Hash,rules:ScreenplayRulesSchema,notes:ScreenplayGenerationNotesSchema,execution:EpisodeExecutionSchema});
export const ScreenplayGenerationRunSchema=ScreenplayGenerationKeySchema.extend({version:z.literal(1),candidateId:Id,source:ScreenplaySourceSchema,context:ScreenplayContextSchema,previous:ContinuityPreviousSchema.nullable(),
  notes:ScreenplayGenerationNotesSchema,method:Pin,execution:EpisodeExecutionSchema,authorId:Id,createdAt:z.iso.datetime({precision:3}),requestDigest:Hash,digest:Hash});
export type ScreenplayGenerationRun=z.infer<typeof ScreenplayGenerationRunSchema>;
export const ScreenplayGeneratedCandidateSchema=z.strictObject({version:z.literal(1),status:z.literal('candidate'),scope:ScreenplayScopeSchema,contextDigest:Hash,method:Pin,output:ScreenplayModelOutputSchema,model:ModelReceiptSchema,candidate:ScreenplayCandidateSchema,digest:Hash});
export type ScreenplayGeneratedCandidate=z.infer<typeof ScreenplayGeneratedCandidateSchema>;
export const ScreenplayGenerationDeliverySchema=z.strictObject({version:z.literal(1),key:ScreenplayGenerationKeySchema,runDigest:Hash,generatedDigest:Hash,candidateKey:ScreenplayKeySchema,preparationDigest:Hash,authorId:Id,at:z.iso.datetime({precision:3}),digest:Hash});
export type ScreenplayGenerationDelivery=z.infer<typeof ScreenplayGenerationDeliverySchema>;
export const ScreenplayGenerationProgressSchema=z.strictObject({run:ScreenplayGenerationRunSchema,candidate:ScreenplayGeneratedCandidateSchema.nullable(),delivery:ScreenplayGenerationDeliverySchema.nullable()});
export type ScreenplayGenerationProgress=z.infer<typeof ScreenplayGenerationProgressSchema>;
export const ScreenplayGenerationTaskReferenceSchema=z.strictObject({projectId:Id,runId:Id,runDigest:Hash});
export const SCREENPLAY_GENERATION_WORKFLOW='screenplay.write-stage';
export const SCREENPLAY_GENERATION_WORKFLOW_VERSION=1;

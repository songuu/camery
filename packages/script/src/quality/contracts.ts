import {z} from 'zod';
import {AgentIssueSchema} from '@camery/agents';
import {Id,Hash,Integer,Text} from '../contracts.js';
import {OutlineContextSchema,OutlineOutputSchema,RuleThresholdsSchema} from '../outline/contracts.js';
import {ScreenplayContextSchema,ScreenplayDraftSchema} from '../screenplay/contracts.js';
export const QUALITY_MATERIAL_BYTES=67108864,QUALITY_POLICY_BYTES=262144,QUALITY_REPORT_BYTES=16777216;
export const ANTIPATTERN_IDS=['slow-opening','unrealized-reward','repeated-plot','unearned-rescue','unearned-advantage','weakened-opponent','costless-protagonist','closed-episode','decorative-genre','unfilmable-prose','empty-dialogue','overlong-scene','repeated-cliffhanger'] as const;
export const QualityPhaseSchema=z.enum(['story','continuity','production']);
export type QualityPhase=z.infer<typeof QualityPhaseSchema>;
export const QualityScopeSchema=z.strictObject({tenantId:Id,projectId:Id,taskId:Id,objectId:Id,sourceDigest:Hash});
export type QualityScope=z.infer<typeof QualityScopeSchema>;
export const QualitySubjectSchema=z.discriminatedUnion('kind',[
  z.strictObject({kind:z.literal('outline'),context:OutlineContextSchema,output:OutlineOutputSchema}),
  z.strictObject({kind:z.literal('screenplay'),context:ScreenplayContextSchema,draft:ScreenplayDraftSchema,outline:z.strictObject({context:OutlineContextSchema,output:OutlineOutputSchema})}),
]);
export type QualitySubject=z.infer<typeof QualitySubjectSchema>;
export const AntiPatternSchema=z.strictObject({id:z.enum(ANTIPATTERN_IDS),label:Text(120),enabled:z.boolean(),recognition:Text(1500),remedy:Text(1500),severity:z.enum(['minor','major'])});
export type AntiPattern=z.infer<typeof AntiPatternSchema>;
export const QualityPolicySchema=z.strictObject({version:z.literal(1),id:Id,revision:Integer.min(1),label:Text(120),source:z.literal('camery-original'),guidanceStatus:z.literal('unvalidated'),thresholds:RuleThresholdsSchema,
  cliches:z.array(z.strictObject({id:Id,tier:z.union([z.literal(1),z.literal(2),z.literal(3)]),label:Text(120),literal:Text(200),mode:z.enum(['exact','ascii_insensitive']),recognition:Text(1500),remedy:Text(1500)})).max(256),
  scoring:z.strictObject({base:Integer.max(100),tier1Penalty:Integer.max(100),tier2Penalty:Integer.max(100),tier3PerEpisodeLimit:Integer.max(100)}),
  naming:z.strictObject({blacklistedNames:z.array(Text(120)).max(1024),blacklistedSurnames:z.array(Text(20)).max(1024),blacklistedCharacters:z.array(Text(4)).max(1024),surnamePrefixes:z.array(Text(20)).max(1024),distinctPrincipalSurnames:z.boolean()}),
  antipatterns:z.array(AntiPatternSchema).length(13),
});
export type QualityPolicy=z.infer<typeof QualityPolicySchema>;
export const QualityTextSchema=z.strictObject({id:Id,path:Text(1000),text:Text(524288),episodeNumber:Integer.min(1).max(100).nullable()});
export const QualityNameSchema=z.strictObject({id:Id,path:Text(1000),name:Text(120),principal:z.boolean(),episodeNumber:Integer.min(1).max(100).nullable()});
export const QualityCatalogInputSchema=z.strictObject({scope:QualityScopeSchema,texts:z.array(QualityTextSchema).max(65536),names:z.array(QualityNameSchema).max(16384)});
export type QualityCatalogInput=z.infer<typeof QualityCatalogInputSchema>;
export const QualityEvidenceSchema=z.strictObject({path:Text(1000),start:Integer.nullable(),end:Integer.nullable(),quote:Text(8000).nullable()});
export const QualityFindingDetailSchema=z.strictObject({code:Id,origin:z.enum(['structural','configured','model']),phase:QualityPhaseSchema,waivable:z.boolean(),path:AgentIssueSchema.shape.path,severity:AgentIssueSchema.shape.severity,problem:Text(8000),audienceImpact:Text(8000),suggestion:Text(8000),ripple:z.array(Text(8000)).max(100),evidence:z.array(QualityEvidenceSchema).min(1).max(256)});
export const QualityFindingSchema=z.strictObject({id:Id,sourceDigest:Hash,code:Id,origin:QualityFindingDetailSchema.shape.origin,phase:QualityPhaseSchema,waivable:z.boolean(),issue:AgentIssueSchema,evidence:QualityFindingDetailSchema.shape.evidence});
export type QualityFinding=z.infer<typeof QualityFindingSchema>;
export const QualityGateReportSchema=z.strictObject({version:z.literal(1),kind:z.literal('deterministic_quality'),scope:QualityScopeSchema,policy:z.strictObject({id:Id,revision:Integer.min(1)}),findings:z.array(QualityFindingSchema).max(65536),verdict:z.enum(['blocked','needs_review','clear']),evidenceScope:z.literal('text'),mediaQualityVerified:z.literal(false)});
export type QualityGateReport=z.infer<typeof QualityGateReportSchema>;
export const QualityCatalogReportSchema=z.strictObject({version:z.literal(1),kind:z.literal('configured_quality'),scope:QualityScopeSchema,policy:z.strictObject({id:Id,revision:Integer.min(1)}),guidanceStatus:z.literal('unvalidated'),findings:z.array(QualityFindingSchema).max(65536),scores:z.array(z.strictObject({episodeNumber:Integer.min(1).max(100).nullable(),raw:z.number().finite(),bounded:z.number().finite().min(0),tier1:Integer,tier2:Integer,tier3:Integer})).max(101),requiresHumanReview:z.literal(true),mediaQualityVerified:z.literal(false)});
export type QualityCatalogReport=z.infer<typeof QualityCatalogReportSchema>;
export class QualityError extends Error{
  override readonly name='QualityError';
  constructor(readonly code:'INVALID_INPUT'|'INPUT_LIMIT'|'INVALID_REFERENCE'|'INCOMPLETE'|'CONFLICT'|'FORBIDDEN'|'NOT_FOUND'|'STORAGE_FAILED',readonly operation:string,readonly path:string){super(`Quality ${operation} failed (${code}) at ${path}`);}
}

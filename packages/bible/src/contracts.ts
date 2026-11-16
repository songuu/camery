import { z } from 'zod';
import type { ImportedDocument } from '@camery/ingest';
import type { MethodPin, ModelReceipt } from '@camery/methods';

export const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
export const LocalId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$(?![\s\S])/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
export const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && value.isWellFormed() && !value.includes('\0'));
export const EntityKind = z.enum(['character','place','prop','organization','concept']);
export const ClaimKind = z.enum(['fact','world_rule','timeline','foreshadowing','reveal']);
export const SourceIdentitySchema = z.strictObject({ tenantId: Id, projectId: Id, documentId: Id,
  kind: z.enum(['novel','script']), format: z.enum(['novel','fountain','csv','tsv','docx']), revision: Integer.min(1),
  sourceDigest: Hash, originalDigest: Hash, totalCharacters: Integer.min(1).max(16_000_000) });
export type SourceIdentity = z.infer<typeof SourceIdentitySchema>;
export interface SourceInput { readonly tenantId: string; readonly projectId: string; readonly documentId: string; readonly kind: 'novel'|'script'; readonly revision: number; readonly document: ImportedDocument }
export interface SourceSnapshot { readonly source: SourceIdentity; readonly document: ImportedDocument }
export const ChunkSchema = z.strictObject({ id: Id, ordinal: Integer, start: Integer, end: Integer.min(1), textDigest: Hash });
export type Chunk = z.infer<typeof ChunkSchema>;
export const ChunkPlanSchema = z.strictObject({ version: z.literal(1), source: SourceIdentitySchema,
  maxCharacters: Integer.min(2).max(20000), maxBytes: Integer.min(4).max(60000), chunks: z.array(ChunkSchema).min(1).max(4096), digest: Hash });
export type ChunkPlan = z.infer<typeof ChunkPlanSchema>;
// Model positions are relative UTF-16 ranges within exactly one supplied chunk.
export const EvidenceSchema = z.strictObject({ start: Integer, end: Integer.min(1), quote: Text(500) });
const Evidence = z.array(EvidenceSchema).min(1).max(6);
export const ChunkOutputSchema = z.strictObject({
  entities: z.array(z.strictObject({ id: LocalId, kind: EntityKind, name: Text(120), aliases: z.array(Text(120)).max(12), description: Text(1000), evidence: Evidence })).max(32),
  relations: z.array(z.strictObject({ id: LocalId, from: LocalId, to: LocalId, label: Text(300), evidence: Evidence })).max(64),
  claims: z.array(z.strictObject({ id: LocalId, kind: ClaimKind, text: Text(1000), entityIds: z.array(LocalId).max(32), evidence: Evidence })).max(64),
});
export type ChunkOutput = z.infer<typeof ChunkOutputSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export interface ChunkRecord { readonly version: 1; readonly planDigest: string; readonly chunkId: string; readonly method: MethodPin; readonly output: ChunkOutput; readonly model: ModelReceipt; readonly digest: string }
export type LocatedEntity = ChunkOutput['entities'][number] & { readonly chunkId: string };
export type LocatedRelation = ChunkOutput['relations'][number] & { readonly chunkId: string };
export type LocatedClaim = ChunkOutput['claims'][number] & { readonly chunkId: string };
export interface MergeSuggestion { readonly entityIds: readonly string[]; readonly reason: 'name_or_alias_overlap' }
export interface BibleCandidate {
  readonly version: 1; readonly status: 'candidate'; readonly plan: ChunkPlan; readonly method: MethodPin; readonly records: readonly ChunkRecord[];
  readonly entities: readonly LocatedEntity[]; readonly relations: readonly LocatedRelation[]; readonly claims: readonly LocatedClaim[];
  readonly mergeSuggestions: readonly MergeSuggestion[]; readonly digest: string;
}
export const ReviewDecisionSchema = z.strictObject({ candidateDigest: Hash,
  groups: z.array(z.strictObject({ id: Id, memberIds: z.array(Id).min(1).max(4096), name: Text(120) })).max(4096),
  rejectedEntityIds: z.array(Id).max(4096), selectedRelationIds: z.array(Id).max(8192), selectedClaimIds: z.array(Id).max(8192) });
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export interface ReviewHost {
  readonly actor: { readonly kind: 'human'; readonly id: string }; readonly tenantId: string; readonly projectId: string; readonly at: string;
  readonly authorize: (request: { readonly actorId: string; readonly source: SourceIdentity; readonly action: 'bible:confirm'|'bible:reject' }) => boolean;
}
export interface ConfirmedEntity {
  readonly id: string; readonly kind: z.infer<typeof EntityKind>; readonly name: string; readonly aliases: readonly string[]; readonly memberIds: readonly string[];
  readonly descriptions: readonly { readonly text: string; readonly evidence: readonly Evidence[] }[];
}
export interface ConfirmedBible {
  readonly version: 1; readonly status: 'confirmed'; readonly source: SourceIdentity; readonly candidateDigest: string; readonly decision: ReviewDecision;
  readonly actorId: string; readonly at: string; readonly entities: readonly ConfirmedEntity[];
  readonly relations: readonly LocatedRelation[]; readonly claims: readonly LocatedClaim[]; readonly digest: string;
}
export interface RejectedBible {
  readonly version: 1; readonly status: 'rejected'; readonly source: SourceIdentity; readonly candidateDigest: string;
  readonly actorId: string; readonly at: string; readonly reason: string; readonly digest: string;
}
export class BibleError extends Error {
  override readonly name = 'BibleError';
  constructor(readonly code: 'INVALID_INPUT'|'INPUT_LIMIT'|'INVALID_EVIDENCE'|'CONFLICT'|'FORBIDDEN'|'INCOMPLETE'|'MODEL_FAILED'|'NOT_FOUND'|'STORAGE_FAILED', readonly operation: string) {
    super(`StoryBible ${operation} failed (${code})`);
  }
}

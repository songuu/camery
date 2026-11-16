import { z } from 'zod';
import { Pin } from '@camery/methods';
import type { MethodPin } from '@camery/methods';
import { BibleError, Hash } from './contracts.js';
import type { BibleCandidate, ChunkPlan, ChunkRecord, Evidence, LocatedClaim, LocatedEntity, LocatedRelation, MergeSuggestion, SourceInput, SourceSnapshot } from './contracts.js';
import { asSourceInput, canonical, captureSource, copy, ensureSource, freeze, hash, parse } from './data.js';
import { validateChunkPlan } from './chunks.js';
import { validateChunkRecord } from './extraction.js';

const RecordInputs = z.array(z.unknown()).max(4096);
const CandidateInput = z.strictObject({ version: z.literal(1), status: z.literal('candidate'), plan: z.unknown(), method: Pin,
  records: RecordInputs, entities: z.array(z.unknown()).max(4096), relations: z.array(z.unknown()).max(8192), claims: z.array(z.unknown()).max(8192),
  mergeSuggestions: z.array(z.unknown()).max(4096), digest: Hash });
const MAX_INPUT_BYTES = 2_097_152;

/** Matching labels propose a review group only; even identical names may denote different people. */
function suggestMerges(entities: readonly LocatedEntity[]): MergeSuggestion[] {
  const parents = entities.map((_, index) => index); const labels = new Map<string, number>();
  const root = (initial: number): number => {
    let index = initial;
    while (parents[index] !== index) index = parents[index]!;
    let child = initial;
    while (child !== index) { const parent = parents[child]!; parents[child] = index; child = parent; }
    return index;
  };
  for (const [index, entity] of entities.entries()) {
    for (const label of [entity.name, ...entity.aliases]) {
      const normalized = label.normalize('NFC').trim().replace(/\s+/gu, ' ');
      const key = JSON.stringify([entity.kind, normalized]); const previous = labels.get(key);
      if (previous === undefined) labels.set(key, index);
      else {
        const left = root(previous); const right = root(index);
        // The earlier entity stays the representative so suggestion ordering follows the source, not hash insertion order.
        if (left !== right) parents[Math.max(left, right)] = Math.min(left, right);
      }
    }
  }
  const groups = new Map<number, string[]>();
  for (const [index, entity] of entities.entries()) {
    const representative = root(index); const group = groups.get(representative);
    if (group) group.push(entity.id); else groups.set(representative, [entity.id]);
  }
  return [...groups.values()].filter(entityIds => entityIds.length > 1).map(entityIds => ({ entityIds, reason: 'name_or_alias_overlap' as const }));
}

/** Assemble only a complete, explicitly pinned extraction set. No inferred entity is adopted here. */
export function assembleBibleCandidate(input: SourceInput, suppliedPlan: ChunkPlan, suppliedRecords: readonly ChunkRecord[], suppliedMethod: MethodPin): BibleCandidate {
  const source = captureSource(input); const plan = validateChunkPlan(source, suppliedPlan); const method = parse(Pin, suppliedMethod, 'candidate method');
  const inputs = parse(RecordInputs, suppliedRecords, 'candidate records');
  if (inputs.length !== plan.chunks.length) throw new BibleError('INCOMPLETE', 'candidate chunks');
  const byChunk = new Map<string, ChunkRecord>(); let inputBytes = 2; let entityCount = 0; let relationCount = 0; let claimCount = 0;
  for (const [index, value] of inputs.entries()) {
    // Bound the aggregate before copying or retaining the next record; a legal per-chunk size is not a total memory bound.
    let encoded: string;
    try { encoded = canonical(value); } catch { throw new BibleError('INPUT_LIMIT', 'candidate input bytes'); }
    inputBytes += Buffer.byteLength(encoded, 'utf8') + (index === 0 ? 0 : 1);
    if (inputBytes > MAX_INPUT_BYTES) throw new BibleError('INPUT_LIMIT', 'candidate input bytes');
    const record = validateChunkRecord(source, plan, JSON.parse(encoded) as unknown, method);
    if (byChunk.has(record.chunkId)) throw new BibleError('CONFLICT', 'duplicate candidate chunk');
    entityCount += record.output.entities.length; relationCount += record.output.relations.length; claimCount += record.output.claims.length;
    if (entityCount > 4096 || relationCount > 8192 || claimCount > 8192) throw new BibleError('INPUT_LIMIT', 'candidate projection');
    byChunk.set(record.chunkId, record);
  }
  const entities: LocatedEntity[] = []; const relations: LocatedRelation[] = []; const claims: LocatedClaim[] = []; const records: ChunkRecord[] = [];
  for (const chunk of plan.chunks) {
    // All records belong to this plan; equal counts and unique chunk identities prove every planned chunk is present.
    const record = byChunk.get(chunk.id)!;
    records.push(record);
    const entityId = (id: string) => `${chunk.id}:e:${id}`;
    const locate = (evidence: readonly Evidence[]) => evidence.map(item => ({ ...item, start: item.start + chunk.start, end: item.end + chunk.start }));
    for (const entity of record.output.entities) entities.push({ ...entity, id: entityId(entity.id), chunkId: chunk.id, evidence: locate(entity.evidence) });
    for (const relation of record.output.relations) relations.push({ ...relation, id: `${chunk.id}:r:${relation.id}`, chunkId: chunk.id,
      from: entityId(relation.from), to: entityId(relation.to), evidence: locate(relation.evidence) });
    for (const claim of record.output.claims) claims.push({ ...claim, id: `${chunk.id}:f:${claim.id}`, chunkId: chunk.id,
      entityIds: claim.entityIds.map(entityId), evidence: locate(claim.evidence) });
  }
  const body = { version: 1 as const, status: 'candidate' as const, plan, method, records, entities, relations, claims, mergeSuggestions: suggestMerges(entities) };
  // Include the final digest field in the bound; raw records and projections are both logical JSON payloads.
  return freeze(copy({ ...body, digest: hash(body) }));
}

/** Rebuild all projections and suggestions; a self-reported digest is not a trusted candidate. */
export function validateBibleCandidate(suppliedSource: SourceSnapshot, input: unknown): BibleCandidate {
  const source = ensureSource(suppliedSource);
  const candidate = parse(CandidateInput, copy(input), 'candidate');
  const rebuilt = assembleBibleCandidate(asSourceInput(source), candidate.plan as ChunkPlan, candidate.records as ChunkRecord[], candidate.method);
  if (canonical(candidate) !== canonical(rebuilt)) throw new BibleError('CONFLICT', 'candidate projection');
  return rebuilt;
}

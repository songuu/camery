import { BibleError, ChunkOutputSchema } from './contracts.js';
import type { ChunkOutput, ChunkPlan, SourceSnapshot } from './contracts.js';
import { boundary, freeze, parse, snapshotJson } from './data.js';
import { readChunk } from './chunks.js';

/** Structural and exact-text validation, not a claim that a model's interpretation is true. */
export function validateChunkOutput(source: SourceSnapshot, plan: ChunkPlan, chunkId: string, input: unknown): ChunkOutput {
  const {text} = readChunk(source,plan,chunkId);
  const output = parse(ChunkOutputSchema,snapshotJson(input,131_072),'chunk output');
  const entities = new Set<string>(); const relations = new Set<string>(); const claims = new Set<string>();
  const unique = (set: Set<string>, id: string) => {
    if (set.has(id)) throw new BibleError('INVALID_EVIDENCE','duplicate local identity'); set.add(id);
  };
  for (const entity of output.entities) unique(entities,entity.id);
  for (const relation of output.relations) {
    unique(relations,relation.id);
    if (!entities.has(relation.from) || !entities.has(relation.to)) throw new BibleError('INVALID_EVIDENCE','relation entity');
  }
  for (const claim of output.claims) {
    unique(claims,claim.id);
    if (new Set(claim.entityIds).size!==claim.entityIds.length || claim.entityIds.some(id=>!entities.has(id))) throw new BibleError('INVALID_EVIDENCE','claim entity');
  }
  for (const item of [...output.entities,...output.relations,...output.claims]) {
    for (const evidence of item.evidence) {
      if (evidence.end<=evidence.start || evidence.end>text.length || !boundary(text,evidence.start) || !boundary(text,evidence.end)
        || evidence.quote!==text.slice(evidence.start,evidence.end)) throw new BibleError('INVALID_EVIDENCE','source quotation');
    }
  }
  return freeze(output);
}

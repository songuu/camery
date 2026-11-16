import type { ImportFormat, ImportUnit } from './types.js';
import { z } from 'zod';
export type SourceKind = 'novel' | 'script';
export interface SourceSummary {
  readonly documentId: string; readonly title: string; readonly kind: SourceKind;
  readonly format: ImportFormat; readonly revision: number;
}
export interface SourcePage extends SourceSummary {
  readonly sourceDigest: string; readonly originalDigest: string; readonly totalCharacters: number; readonly unitCount: number;
  readonly warnings: readonly string[];
  readonly excerpt: { readonly start: number; readonly end: number; readonly text: string };
  readonly units: readonly Omit<ImportUnit, 'fields'>[];
  readonly checkpoint: { readonly offset: number; readonly version: number } | null;
}
export interface SourceList { readonly items: readonly SourceSummary[]; readonly nextCursor: string | null }
export interface AppendReceipt extends SourceSummary {
  readonly sourceDigest: string; readonly duplicate: boolean; readonly batchRevision: number;
}
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$(?![\s\S])/);
const Integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/);
const SummaryShape = { documentId: Id, title: z.string().max(200), kind: z.enum(['novel','script']), format: z.enum(['novel','fountain','csv','tsv','docx']), revision: Integer.min(1) };
export const SourceSummarySchema: z.ZodType<SourceSummary> = z.strictObject(SummaryShape);
export const SourceListSchema: z.ZodType<SourceList> = z.strictObject({ items: z.array(SourceSummarySchema).max(50), nextCursor: z.string().max(136).nullable() });
export const SourcePageSchema: z.ZodType<SourcePage> = z.strictObject({ ...SummaryShape, sourceDigest: Digest, originalDigest: Digest,
  totalCharacters: Integer.max(16_000_000), unitCount: Integer.max(100_001), warnings: z.array(z.string().max(128)).max(64),
  excerpt: z.strictObject({ start: Integer, end: Integer, text: z.string().max(20000) }).refine(value => value.end - value.start === value.text.length),
  units: z.array(z.strictObject({ ordinal: Integer, kind: z.enum(['frontmatter','chapter','scene','action','character','dialogue','parenthetical','transition','note','lyric','section','synopsis','title','unknown']),
    title: z.string().max(120), start: Integer, end: Integer, speaker: z.string().max(120).nullable() })).max(200),
  checkpoint: z.strictObject({ offset: Integer, version: Integer.min(1) }).nullable(),
});
export const AppendReceiptSchema: z.ZodType<AppendReceipt> = z.strictObject({ ...SummaryShape, sourceDigest: Digest, duplicate: z.boolean(), batchRevision: Integer.min(1) }).refine(value => value.batchRevision <= value.revision);
export const ScriptReceiptSchema = z.strictObject({ ...SummaryShape, sourceDigest: Digest, duplicate: z.boolean() });

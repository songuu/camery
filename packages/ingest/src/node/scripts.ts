import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { DocumentIdentity, DocumentTitle, documentScope } from '../session.js';
import type { DocumentScope } from '../session.js';
import { textDigest, freeze } from '../data.js';
import { ImportError } from '../types.js';
import { validateImportedDocument } from '../document.js';
import { importFountain, importScriptTable } from '../screenplay.js';
import { importDocx } from './docx.js';
import { documentKeys, documentTransaction } from './transaction.js';
import type { SourceSummary, SourceList } from '../contracts.js';

const Format = z.enum(['fountain','csv','tsv','docx']);
const Command = DocumentIdentity.extend({ title: DocumentTitle, format: Format, bytes: z.instanceof(Uint8Array) });
const Listing = DocumentIdentity.omit({ documentId: true }).extend({ cursor: z.string().max(136).optional() });
interface StoredScript { format: unknown; title: unknown; original: Buffer; original_digest: unknown; document: unknown }
function scopeOf(input: DocumentScope) { return documentScope({ tenantId: input.tenantId, projectId: input.projectId, documentId: input.documentId }); }
function decode(row: StoredScript, scope: DocumentScope) {
  try {
    const format = Format.parse(row.format); const title = DocumentTitle.parse(row.title);
    const document = validateImportedDocument(row.document);
    if (!(row.original instanceof Uint8Array) || row.original.length === 0 || row.original.length > 8_000_000
      || row.original_digest !== textDigest(row.original) || document.originalDigest !== row.original_digest || document.format !== format
      || format !== 'docx' && document.sourceDigest !== row.original_digest)
      throw new ImportError('STORAGE_FAILED', 'stored script');
    return freeze({ summary: { documentId: scope.documentId, title, kind: 'script' as const, format, revision: 1 }, document });
  } catch { throw new ImportError('STORAGE_FAILED', 'stored script'); }
}
async function load(client: PoolClient, scope: DocumentScope) {
  const result = await client.query<StoredScript>('SELECT format,title,original,original_digest,document FROM camery_ingest.scripts WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3', documentKeys(scope));
  return result.rows[0];
}
function summary(input: unknown): SourceSummary {
  const parsed = z.strictObject({ documentId: DocumentIdentity.shape.documentId, title: DocumentTitle, kind: z.enum(['novel','script']),
    format: z.enum(['novel','fountain','csv','tsv','docx']), revision: z.number().int().positive().max(1024) }).safeParse(input);
  if (!parsed.success || (parsed.data.kind === 'novel') !== (parsed.data.format === 'novel')) throw new ImportError('STORAGE_FAILED', 'catalog');
  return parsed.data;
}

/** All identities must come from an authorized application service; original bytes never leave this repository. */
export class PostgresScriptStore {
  constructor(private readonly pool: Pool) {}
  async import(input: unknown) {
    const parsed = Command.safeParse(input);
    if (!parsed.success || !parsed.data.bytes.length) throw new ImportError('INVALID_INPUT', 'script import');
    if (parsed.data.bytes.length > 8_000_000) throw new ImportError('INPUT_LIMIT', 'script bytes');
    const command = Object.freeze({ ...parsed.data, bytes: Uint8Array.from(parsed.data.bytes) });
    const scope = scopeOf(command); const digest = textDigest(command.bytes);
    return documentTransaction(this.pool, scope, async client => {
      const existing = await load(client, scope);
      if (existing) {
        const result = decode(existing, scope);
        if (result.document.originalDigest !== digest || result.summary.format !== command.format || result.summary.title !== command.title)
          throw new ImportError('CONFLICT', 'script identity');
        return { ...result, duplicate: true };
      }
      let document;
      if (command.format === 'docx') document = await importDocx(command.bytes);
      else {
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(command.bytes); } catch { throw new ImportError('MALFORMED_DOCUMENT', 'script encoding'); }
        document = command.format === 'fountain' ? importFountain(text) : importScriptTable(text, command.format === 'tsv' ? '\t' : ',');
      }
      const validated = validateImportedDocument(document);
      await client.query('INSERT INTO camery_ingest.scripts(tenant_id,project_id,document_id,format,title,original,original_digest,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
        [...documentKeys(scope), command.format, command.title, Buffer.from(command.bytes), digest, JSON.stringify(validated)]);
      return { summary: { documentId: scope.documentId, title: command.title, kind: 'script' as const, format: command.format, revision: 1 }, document: validated, duplicate: false };
    });
  }
  async read(input: unknown) {
    const scope = documentScope(input);
    return documentTransaction(this.pool, scope, async client => {
      const row = await load(client, scope); if (!row) throw new ImportError('NOT_FOUND', 'script');
      return decode(row, scope);
    });
  }
  async list(input: unknown): Promise<SourceList> {
    const parsed = Listing.safeParse(input);
    if (!parsed.success) throw new ImportError('INVALID_INPUT', 'catalog');
    const { tenantId, projectId, cursor } = parsed.data;
    let afterKind = ''; let afterId = '';
    if (cursor !== undefined) {
      const separator = cursor.indexOf(':'); if(separator<1)throw new ImportError('INVALID_INPUT','catalog cursor');
      afterKind = cursor.slice(0,separator); afterId = cursor.slice(separator+1);
      if (!['novel','script'].includes(afterKind) || !DocumentIdentity.shape.documentId.safeParse(afterId).success) throw new ImportError('INVALID_INPUT', 'catalog cursor');
    }
    try {
      const result = await this.pool.query<{ document_id: string; title: string; kind: string; format: string; revision: number }>(`
        SELECT * FROM (
          SELECT document_id, COALESCE(snapshot->>'title',document_id) AS title,'novel' AS kind,'novel' AS format,revision::integer AS revision
          FROM camery_ingest.documents WHERE tenant_id=$1 AND project_id=$2
          UNION ALL
          SELECT document_id,title,'script' AS kind,format,1 AS revision FROM camery_ingest.scripts WHERE tenant_id=$1 AND project_id=$2
        ) sources WHERE (kind COLLATE "C",document_id COLLATE "C")>($3::text COLLATE "C",$4::text COLLATE "C") ORDER BY kind COLLATE "C",document_id COLLATE "C" LIMIT 51`, [tenantId, projectId, afterKind, afterId]);
      const items = result.rows.slice(0,50).map(row => summary({ documentId: row.document_id, title: row.title, kind: row.kind, format: row.format, revision: row.revision }));
      const last = items.at(-1);
      return freeze({ items, nextCursor: result.rows.length > 50 && last ? `${last.kind}:${last.documentId}` : null });
    } catch (error) { if (error instanceof ImportError) throw error; throw new ImportError('STORAGE_FAILED', 'catalog'); }
  }
}

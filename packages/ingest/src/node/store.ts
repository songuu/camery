import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { importNovel } from '../novel.js';
import { ImportError } from '../types.js';
import { advanceReading, appendNovelBatch, captureNovelBatch, captureReadingProgress, documentScope, DocumentIdentity, validateNovelSnapshot, validateReadingCheckpoint } from '../session.js';
import type { DocumentScope, NovelSnapshot } from '../session.js';

const Reader = DocumentIdentity.extend({ readerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) });
function keys(scope: DocumentScope) { return [scope.tenantId, scope.projectId, scope.documentId]; }
function scopeFrom(input: unknown): DocumentScope {
  if (!input || typeof input !== 'object') throw new ImportError('INVALID_INPUT', 'scope');
  const source = input as Record<string, unknown>;
  return documentScope({ tenantId: source['tenantId'], projectId: source['projectId'], documentId: source['documentId'] });
}
function storedCheckpoint(snapshot: NovelSnapshot, input: unknown, readerId: string) {
  try {
    const checkpoint = validateReadingCheckpoint(snapshot, input);
    if (checkpoint.readerId !== readerId) throw new ImportError('STORAGE_FAILED', 'stored reader');
    return checkpoint;
  } catch { throw new ImportError('STORAGE_FAILED', 'stored checkpoint'); }
}
/** Trusted application service only: supplied identities are not authentication or project grants. */
export class PostgresDocumentStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(scope: DocumentScope, action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => { throw new ImportError('STORAGE_FAILED', 'connection'); });
    try {
      await client.query('BEGIN');
      // Serializes first insertion too; row locks alone do not protect a document that does not exist yet.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['camery_ingest', ...keys(scope)])]);
      const result = await action(client);
      await client.query('COMMIT'); return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { throw new ImportError('STORAGE_FAILED', 'rollback'); }
      if (error instanceof ImportError) throw error;
      throw new ImportError('STORAGE_FAILED', 'transaction');
    } finally { client.release(); }
  }

  private async load(client: PoolClient, scope: DocumentScope): Promise<NovelSnapshot | undefined> {
    const result = await client.query<{ snapshot: unknown; revision: string }>('SELECT snapshot,revision::text FROM camery_ingest.documents WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3 FOR UPDATE', keys(scope));
    const row = result.rows[0];
    if (!row) return undefined;
    let state: NovelSnapshot;
    try { state = validateNovelSnapshot(row.snapshot); } catch { throw new ImportError('STORAGE_FAILED', 'stored document'); }
    if (state.tenantId !== scope.tenantId || state.projectId !== scope.projectId || state.documentId !== scope.documentId || String(state.revision) !== row.revision)
      throw new ImportError('STORAGE_FAILED', 'stored scope');
    return state;
  }

  async append(input: unknown) {
    const command = captureNovelBatch(input);
    const scope = scopeFrom(command);
    return this.transaction(scope, async client => {
      const previous = await this.load(client, scope);
      const result = appendNovelBatch(previous, command);
      if (!result.duplicate) await client.query('INSERT INTO camery_ingest.documents(tenant_id,project_id,document_id,revision,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,project_id,document_id) DO UPDATE SET revision=EXCLUDED.revision,snapshot=EXCLUDED.snapshot', [...keys(scope), result.snapshot.revision, JSON.stringify(result.snapshot)]);
      return result;
    });
  }

  async read(input: unknown) {
    const parsed = Reader.safeParse(input);
    if (!parsed.success) throw new ImportError('INVALID_INPUT', 'read');
    const scope = scopeFrom(parsed.data);
    return this.transaction(scope, async client => {
      const snapshot = await this.load(client, scope);
      if (!snapshot) throw new ImportError('NOT_FOUND', 'document');
      const row = await client.query<{ checkpoint: unknown }>('SELECT checkpoint FROM camery_ingest.reading_checkpoints WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3 AND reader_id=$4', [...keys(scope), parsed.data.readerId]);
      const saved = row.rows[0];
      const checkpoint = saved ? storedCheckpoint(snapshot, saved.checkpoint, parsed.data.readerId) : null;
      return { snapshot, document: importNovel(snapshot.text), checkpoint };
    });
  }

  async checkpoint(input: unknown) {
    const command = captureReadingProgress(input);
    const scope = scopeFrom(command);
    return this.transaction(scope, async client => {
      const snapshot = await this.load(client, scope);
      if (!snapshot) throw new ImportError('NOT_FOUND', 'document');
      const saved = await client.query<{ checkpoint: unknown }>('SELECT checkpoint FROM camery_ingest.reading_checkpoints WHERE tenant_id=$1 AND project_id=$2 AND document_id=$3 AND reader_id=$4 FOR UPDATE', [...keys(scope), command.readerId]);
      const existing = saved.rows[0];
      const checkpoint = advanceReading(snapshot, existing ? storedCheckpoint(snapshot, existing.checkpoint, command.readerId) : undefined, command);
      await client.query('INSERT INTO camery_ingest.reading_checkpoints(tenant_id,project_id,document_id,reader_id,checkpoint) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(tenant_id,project_id,document_id,reader_id) DO UPDATE SET checkpoint=EXCLUDED.checkpoint', [...keys(scope), command.readerId, JSON.stringify(checkpoint)]);
      return checkpoint;
    });
  }
}

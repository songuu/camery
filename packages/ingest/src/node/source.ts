import type { PoolClient } from 'pg';
import { z } from 'zod';
import { jsonCopy } from '@camery/methods';
import { DocumentIdentity } from '../session.js';
import { ImportError } from '../types.js';
import type { ImportedDocument } from '../types.js';
import { freeze } from '../data.js';
import { importNovel } from '../novel.js';
import { readNovelSnapshotInTransaction } from './store.js';
import { readScriptInTransaction } from './scripts.js';

const Source = DocumentIdentity.extend({kind:z.enum(['novel','script'])});
/**
 * Trusted-host source codec only. The caller already holds the source advisory lock on this transaction/client.
 * Do not use another Pool here: Bible confirmation must compare the current source while holding that same lock.
 */
export async function readSourceDocument(client: PoolClient, input: unknown): Promise<{document:ImportedDocument;revision:number}> {
  let command: z.infer<typeof Source>;
  try { const result=Source.safeParse(jsonCopy(input));if(!result.success)throw new Error();command=freeze(result.data); }
  catch { throw new ImportError('INVALID_INPUT','source identity'); }
  const {tenantId,projectId,documentId,kind}=command;const scope={tenantId,projectId,documentId};
  try {
    if(kind==='novel') {
      const snapshot=await readNovelSnapshotInTransaction(client,scope);
      if(!snapshot)throw new ImportError('NOT_FOUND','document');
      return freeze({document:importNovel(snapshot.text),revision:snapshot.revision});
    }
    const result=await readScriptInTransaction(client,scope);
    return freeze({document:result.document,revision:result.summary.revision});
  } catch(error) {
    if(error instanceof ImportError)throw error;
    throw new ImportError('STORAGE_FAILED','source document');
  }
}

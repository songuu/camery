import type { Pool } from 'pg';
import { z } from 'zod';
import { BibleError, Id, SourceIdentitySchema } from '../contracts.js';
import { BibleRunListSchema, BibleRunSummarySchema } from '../http.js';
import type { BibleRunList, BibleRunSummary } from '../http.js';
import { copy, freeze, hash, parse } from '../data.js';
import { RunKeySchema } from './contracts.js';
import type { BibleRunKey } from './contracts.js';

const Query=z.strictObject({tenantId:Id,projectId:Id,cursor:z.string().min(1).max(512).optional(),documentId:Id.optional(),kind:z.enum(['novel','script']).optional(),pendingOnly:z.boolean().optional()});
export type BibleCatalogQuery=z.infer<typeof Query>;
export interface BibleRunMetadata {readonly summary:BibleRunSummary;readonly nextChunkId:string|null}
export interface BibleCatalogReader {
  list(input:BibleCatalogQuery):Promise<BibleRunList>;
  summary(key:BibleRunKey):Promise<BibleRunMetadata>;
}
const Stamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$(?![\s\S])/).refine(value=>{
  try{return new Date(value).toISOString()===value.slice(0,23)+'Z';}catch{return false;}
});
const Cursor=z.strictObject({version:z.literal(1),scope:z.string().regex(/^[a-f0-9]{64}$/),at:Stamp,runId:Id});
type MetadataRow={tenant_id:string;project_id:string;run_id:string;document_id:string;source_kind:string;created_at:string;source:unknown;completed_chunks:number;total_chunks:number;candidate_digest:string|null;review_status:string|null;source_changed:boolean;next_chunk_id?:string|null};
const pageSize=20;
// Only compact metadata crosses this boundary. Full integrity/freshness remains the store's authority.
const projection=`r.tenant_id,r.project_id,r.run_id,r.document_id,r.source_kind,
 to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 r.plan->'source' AS source,jsonb_array_length(r.plan->'chunks') AS total_chunks,
 (SELECT count(*)::int FROM camery_bible.chunks b WHERE b.tenant_id=r.tenant_id AND b.project_id=r.project_id AND b.run_id=r.run_id) AS completed_chunks,
 c.digest AS candidate_digest,v.status AS review_status,
 CASE WHEN r.source_kind='novel' THEN d.document_id IS NULL OR d.revision::text IS DISTINCT FROM r.plan->'source'->>'revision'
 ELSE s.document_id IS NULL OR s.format IS DISTINCT FROM r.plan->'source'->>'format' OR s.original_digest IS DISTINCT FROM r.plan->'source'->>'originalDigest' END AS source_changed`;
const joins=`FROM camery_bible.runs r
 LEFT JOIN camery_bible.candidates c USING(tenant_id,project_id,run_id)
 LEFT JOIN camery_bible.reviews v USING(tenant_id,project_id,run_id)
 LEFT JOIN camery_ingest.documents d ON r.source_kind='novel' AND d.tenant_id=r.tenant_id AND d.project_id=r.project_id AND d.document_id=r.document_id
 LEFT JOIN camery_ingest.scripts s ON r.source_kind='script' AND s.tenant_id=r.tenant_id AND s.project_id=r.project_id AND s.document_id=r.document_id`;
function decode(row:MetadataRow,key:Pick<BibleRunKey,'tenantId'|'projectId'>):BibleRunSummary {
  const source=parse(SourceIdentitySchema,row.source,'catalog source');
  if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||source.tenantId!==key.tenantId||source.projectId!==key.projectId||row.document_id!==source.documentId||row.source_kind!==source.kind
    ||row.review_status!==null&&row.candidate_digest===null||row.candidate_digest!==null&&row.completed_chunks!==row.total_chunks)throw new Error();
  const {tenantId:_tenant,projectId:_project,...publicSource}=source;
  const at=parse(Stamp,row.created_at,'catalog timestamp');
  return BibleRunSummarySchema.parse({runId:row.run_id,createdAt:at.slice(0,23)+'Z',source:publicSource,completedChunks:row.completed_chunks,totalChunks:row.total_chunks,
    candidateDigest:row.candidate_digest,reviewStatus:row.review_status,sourceChanged:row.source_changed});
}
function cursorScope(input:BibleCatalogQuery):string {
  return hash({tenantId:input.tenantId,projectId:input.projectId,documentId:input.documentId??null,kind:input.kind??null,pendingOnly:input.pendingOnly??false});
}
function decodeCursor(value:string,scope:string):z.infer<typeof Cursor> {
  try {
    if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw new Error();
    const cursor=Cursor.parse(JSON.parse(bytes.toString('utf8')));if(cursor.scope!==scope)throw new Error();return cursor;
  }catch{throw new BibleError('INVALID_INPUT','catalog cursor');}
}
/** Bounded keyset read model. This never loads a source body or rebuilds a candidate during polling. */
export class PostgresBibleCatalog implements BibleCatalogReader {
  constructor(private readonly pool:Pool){}
  async list(input:BibleCatalogQuery):Promise<BibleRunList> {
    const command=freeze(parse(Query,copy(input),'catalog query'));const scope=cursorScope(command);const cursor=command.cursor?decodeCursor(command.cursor,scope):null;
    const values:unknown[]=[command.tenantId,command.projectId];const where=['r.tenant_id=$1','r.project_id=$2'];
    if(command.documentId){values.push(command.documentId);where.push(`r.document_id=$${values.length}`);}
    if(command.kind){values.push(command.kind);where.push(`r.source_kind=$${values.length}`);}
    if(command.pendingOnly)where.push('c.run_id IS NULL AND v.run_id IS NULL');
    if(cursor){values.push(cursor.at,cursor.runId);where.push(`(r.created_at,r.run_id COLLATE "C") < ($${values.length-1}::timestamptz,$${values.length}::text COLLATE "C")`);}
    try {
      const rows=await this.pool.query<MetadataRow>(`SELECT ${projection} ${joins} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC,r.run_id COLLATE "C" DESC LIMIT ${pageSize+1}`,values);
      if(rows.rows.length>pageSize+1)throw new Error();const items=rows.rows.slice(0,pageSize).map(row=>decode(row,command));const last=rows.rows[pageSize-1];
      const nextCursor=rows.rows.length>pageSize&&last?Buffer.from(JSON.stringify({version:1,scope,at:last.created_at,runId:last.run_id})).toString('base64url'):null;
      return freeze(BibleRunListSchema.parse({items,nextCursor}));
    }catch{throw new BibleError('STORAGE_FAILED','catalog list');}
  }
  async summary(input:BibleRunKey):Promise<BibleRunMetadata> {
    const key=freeze(parse(RunKeySchema,copy(input),'catalog identity'));
    try {
      const rows=await this.pool.query<MetadataRow>(`SELECT ${projection},
        (SELECT part->>'id' FROM jsonb_array_elements(r.plan->'chunks') WITH ORDINALITY AS p(part,ordinal)
         WHERE NOT EXISTS(SELECT 1 FROM camery_bible.chunks b WHERE b.tenant_id=r.tenant_id AND b.project_id=r.project_id AND b.run_id=r.run_id AND b.chunk_id=part->>'id') ORDER BY ordinal LIMIT 1) AS next_chunk_id
        ${joins} WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.run_id=$3`,[key.tenantId,key.projectId,key.runId]);
      const row=rows.rows[0];if(!row)throw new BibleError('NOT_FOUND','catalog run');if(rows.rows.length!==1||row.run_id!==key.runId)throw new Error();
      const summary=decode(row,key);const nextChunkId=z.union([Id,z.null()]).parse(row.next_chunk_id);
      if((summary.completedChunks===summary.totalChunks)!==(nextChunkId===null))throw new Error();
      return freeze({summary,nextChunkId});
    }catch(error){if(error instanceof BibleError&&error.code==='NOT_FOUND')throw error;throw new BibleError('STORAGE_FAILED','catalog summary');}
  }
}

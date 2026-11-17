import type { Pool } from 'pg';
import { z } from 'zod';
import { Hash,Id,Integer } from '../../contracts.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OutlineRunSummarySchema,OutlineRunListSchema } from '../http.js';
import { hash } from './data.js';
import { OutlineKeySchema } from './persistence-contracts.js';
import type { OutlineRunKey } from './persistence-contracts.js';

const Query=z.strictObject({tenantId:Id,projectId:Id,cursor:z.string().min(1).max(512).optional(),briefId:Id.optional()});
export type OutlineCatalogQuery=z.infer<typeof Query>;
export interface OutlineCatalogReader {
  list(input:OutlineCatalogQuery):Promise<z.infer<typeof OutlineRunListSchema>>;
  summary(input:OutlineRunKey):Promise<z.infer<typeof OutlineRunSummarySchema>>;
}
const Stamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$(?![\s\S])/).refine(value=>{
  try{return new Date(value).toISOString()===value.slice(0,23)+'Z';}catch{return false;}
});
const Cursor=z.strictObject({version:z.literal(1),scope:Hash,at:Stamp,runId:Id});
const Revision=z.union([Integer.min(1),z.string().regex(/^[1-9]\d*$(?![\s\S])/).transform(Number).pipe(Integer.min(1))]);
const Row=z.strictObject({tenant_id:Id,project_id:Id,run_id:Id,run_digest:Hash,brief_id:Id,brief_revision:Revision,created_at:Stamp,
  candidate_digest:Hash.nullable(),review_status:z.enum(['reviewed','rejected']).nullable()});

// Metadata is discovery only: actual source freshness and audit reconstruction remain the store's authority.
const projection=`r.tenant_id,r.project_id,r.run_id,r.digest AS run_digest,r.brief_id,r.brief_revision,
 to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 c.digest AS candidate_digest,v.status AS review_status`;
const joins=`FROM camery_outline.runs r
 LEFT JOIN camery_outline.candidates c ON c.tenant_id=r.tenant_id AND c.project_id=r.project_id AND c.run_id=r.run_id
 LEFT JOIN camery_outline.reviews v ON v.tenant_id=r.tenant_id AND v.project_id=r.project_id AND v.run_id=r.run_id`;
function decode(input:unknown,key:Pick<OutlineRunKey,'tenantId'|'projectId'>){
  const row=capture(Row,input,'catalog metadata',65536);
  if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId||row.review_status!==null&&row.candidate_digest===null)throw new Error();
  return OutlineRunSummarySchema.parse({runId:row.run_id,runDigest:row.run_digest,briefId:row.brief_id,briefRevision:row.brief_revision,
    createdAt:row.created_at.slice(0,23)+'Z',candidateDigest:row.candidate_digest,reviewStatus:row.review_status});
}
function scopeOf(input:OutlineCatalogQuery):string{return hash({kind:'outline-runs',tenantId:input.tenantId,projectId:input.projectId,briefId:input.briefId??null});}
function decodeCursor(value:string,scope:string):z.infer<typeof Cursor>{
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw new Error();
    const cursor=capture(Cursor,JSON.parse(bytes.toString('utf8')),'catalog cursor',4096);if(cursor.scope!==scope)throw new Error();return cursor;
  }catch{throw new OutlineError('INVALID_INPUT','catalog cursor','cursor');}
}
/** Bounded run headers. This does not fetch writing material, model configuration or raw receipts. */
export class PostgresOutlineCatalog implements OutlineCatalogReader {
  constructor(private readonly pool:Pool){}
  async list(input:OutlineCatalogQuery):Promise<z.infer<typeof OutlineRunListSchema>>{
    const command=deepFreeze(capture(Query,input,'catalog query',4096)),scope=scopeOf(command),cursor=command.cursor?decodeCursor(command.cursor,scope):null;
    const values:unknown[]=[command.tenantId,command.projectId],where=['r.tenant_id=$1','r.project_id=$2'];
    if(command.briefId){values.push(command.briefId);where.push(`r.brief_id=$${values.length}`);}
    if(cursor){values.push(cursor.at,cursor.runId);where.push(`(r.created_at,r.run_id COLLATE "C") < ($${values.length-1}::timestamptz,$${values.length}::text COLLATE "C")`);}
    try{
      const result=await this.pool.query<z.input<typeof Row>>(`SELECT ${projection} ${joins} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC,r.run_id COLLATE "C" DESC LIMIT 21`,values);
      if(result.rows.length>21)throw new Error();const items=result.rows.slice(0,20).map(row=>{
        const summary=decode(row,command);if(command.briefId&&summary.briefId!==command.briefId)throw new Error();return summary;
      }),last=result.rows[19];
      const nextCursor=result.rows.length>20&&last?Buffer.from(JSON.stringify({version:1,scope,at:last.created_at,runId:last.run_id})).toString('base64url'):null;
      return deepFreeze(OutlineRunListSchema.parse({items,nextCursor}));
    }catch{throw new OutlineError('STORAGE_FAILED','catalog list','storage');}
  }
  async summary(input:OutlineRunKey):Promise<z.infer<typeof OutlineRunSummarySchema>>{
    const key=deepFreeze(capture(OutlineKeySchema,input,'catalog identity',2048));
    try{
      const result=await this.pool.query<z.input<typeof Row>>(`SELECT ${projection} ${joins} WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.run_id=$3`,[key.tenantId,key.projectId,key.runId]);
      if(result.rows.length===0)throw new OutlineError('NOT_FOUND','catalog run','runId');if(result.rows.length!==1)throw new Error();
      const summary=decode(result.rows[0],key);if(summary.runId!==key.runId)throw new Error();return deepFreeze(summary);
    }catch(error){if(error instanceof OutlineError&&error.code==='NOT_FOUND')throw error;throw new OutlineError('STORAGE_FAILED','catalog summary','storage');}
  }
}

import type { Pool } from 'pg';
import { z } from 'zod';
import { DevelopmentError,Hash,Id,Integer } from '../contracts.js';
import { copy,freeze,hash,parse } from '../data.js';
import { RunKeySchema } from './contracts.js';
import type { DevelopmentRunKey } from './contracts.js';

const Query=z.strictObject({tenantId:Id,projectId:Id,cursor:z.string().min(1).max(512).optional(),briefId:Id.optional(),pendingOnly:z.boolean().optional()});
export type DevelopmentCatalogQuery=z.infer<typeof Query>;
const ReviewState=z.enum(['reviewed','rejected']);
const Summary=z.strictObject({runId:Id,briefId:Id,briefRevision:Integer.min(1),createdAt:z.iso.datetime({precision:3}),sourceChanged:z.boolean(),
  foundationCandidateDigest:Hash.nullable(),foundationReviewStatus:ReviewState.nullable(),episodesCandidateDigest:Hash.nullable(),episodesReviewStatus:ReviewState.nullable()});
export type DevelopmentRunSummary=z.infer<typeof Summary>;
export interface DevelopmentRunList {readonly items:readonly DevelopmentRunSummary[];readonly nextCursor:string|null}
export interface DevelopmentCatalogReader {list(input:DevelopmentCatalogQuery):Promise<DevelopmentRunList>;summary(key:DevelopmentRunKey):Promise<DevelopmentRunSummary>}
const Stamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$(?![\s\S])/).refine(value=>{
  try{return new Date(value).toISOString()===value.slice(0,23)+'Z';}catch{return false;}
});
const Cursor=z.strictObject({version:z.literal(1),scope:Hash,at:Stamp,runId:Id});
const Revision=z.union([Integer.min(1),z.string().regex(/^[1-9]\d*$(?![\s\S])/).transform(Number).pipe(Integer.min(1))]);
type Row={tenant_id:string;project_id:string;run_id:string;brief_id:string;brief_revision:string|number;created_at:string;source_changed:boolean;
  foundation_candidate_digest:string|null;foundation_review_status:string|null;episodes_candidate_digest:string|null;episodes_review_status:string|null};
const pageSize=20;
// These columns are hints for a list/poll. Full candidate integrity and first-write freshness remain the store's authority.
const projection=`r.tenant_id,r.project_id,r.run_id,r.brief_id,r.brief_revision,
 to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
 latest.revision IS DISTINCT FROM r.brief_revision OR latest.digest IS DISTINCT FROM r.brief_digest AS source_changed,
 fc.digest AS foundation_candidate_digest,fv.status AS foundation_review_status,ec.digest AS episodes_candidate_digest,ev.status AS episodes_review_status`;
const joins=`FROM camery_script.runs r
 LEFT JOIN camery_script.run_origins origin ON origin.tenant_id=r.tenant_id AND origin.project_id=r.project_id AND origin.run_id=r.run_id
 LEFT JOIN camery_script.candidates fc ON fc.tenant_id=r.tenant_id AND fc.project_id=r.project_id AND fc.run_id=COALESCE(origin.foundation_run_id,r.run_id) AND fc.stage='foundation'
 LEFT JOIN camery_script.reviews fv ON fv.tenant_id=r.tenant_id AND fv.project_id=r.project_id AND fv.run_id=COALESCE(origin.foundation_run_id,r.run_id) AND fv.stage='foundation'
 LEFT JOIN camery_script.candidates ec ON ec.tenant_id=r.tenant_id AND ec.project_id=r.project_id AND ec.run_id=r.run_id AND ec.stage='episodes'
 LEFT JOIN camery_script.reviews ev ON ev.tenant_id=r.tenant_id AND ev.project_id=r.project_id AND ev.run_id=r.run_id AND ev.stage='episodes'
 LEFT JOIN LATERAL (SELECT b.revision,b.digest FROM camery_script.briefs b
   WHERE b.tenant_id=r.tenant_id AND b.project_id=r.project_id AND b.brief_id=r.brief_id ORDER BY b.revision DESC LIMIT 1) latest ON true`;
function decode(row:Row,key:Pick<DevelopmentRunKey,'tenantId'|'projectId'>):DevelopmentRunSummary{
  if(row.tenant_id!==key.tenantId||row.project_id!==key.projectId)throw new Error();const at=parse(Stamp,row.created_at,'catalog timestamp');
  const summary=Summary.parse({runId:row.run_id,briefId:row.brief_id,briefRevision:Revision.parse(row.brief_revision),createdAt:at.slice(0,23)+'Z',sourceChanged:row.source_changed,
    foundationCandidateDigest:row.foundation_candidate_digest,foundationReviewStatus:row.foundation_review_status,episodesCandidateDigest:row.episodes_candidate_digest,episodesReviewStatus:row.episodes_review_status});
  if(summary.foundationReviewStatus!==null&&summary.foundationCandidateDigest===null||summary.episodesCandidateDigest!==null&&summary.foundationReviewStatus!=='reviewed'||summary.episodesReviewStatus!==null&&summary.episodesCandidateDigest===null)throw new Error();
  return summary;
}
function scopeOf(input:DevelopmentCatalogQuery):string{return hash({tenantId:input.tenantId,projectId:input.projectId,briefId:input.briefId??null,pendingOnly:input.pendingOnly??false});}
function decodeCursor(value:string,scope:string):z.infer<typeof Cursor>{
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw new Error();
    const cursor=Cursor.parse(JSON.parse(bytes.toString('utf8')));if(cursor.scope!==scope)throw new Error();return cursor;
  }catch{throw new DevelopmentError('INVALID_INPUT','catalog cursor');}
}
/** Bounded metadata keyset; this never fetches story text, raw model receipts or the execution profile. */
export class PostgresDevelopmentCatalog implements DevelopmentCatalogReader{
  constructor(private readonly pool:Pool){}
  async list(input:DevelopmentCatalogQuery):Promise<DevelopmentRunList>{
    const command=freeze(parse(Query,copy(input),'catalog query'));const scope=scopeOf(command);const cursor=command.cursor?decodeCursor(command.cursor,scope):null;
    const values:unknown[]=[command.tenantId,command.projectId];const where=['r.tenant_id=$1','r.project_id=$2'];
    if(command.briefId){values.push(command.briefId);where.push(`r.brief_id=$${values.length}`);}
    if(command.pendingOnly)where.push("fv.status IS DISTINCT FROM 'rejected' AND ev.run_id IS NULL");
    if(cursor){values.push(cursor.at,cursor.runId);where.push(`(r.created_at,r.run_id COLLATE "C") < ($${values.length-1}::timestamptz,$${values.length}::text COLLATE "C")`);}
    try{
      const result=await this.pool.query<Row>(`SELECT ${projection} ${joins} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC,r.run_id COLLATE "C" DESC LIMIT ${pageSize+1}`,values);
      if(result.rows.length>pageSize+1)throw new Error();const items=result.rows.slice(0,pageSize).map(row=>decode(row,command));const last=result.rows[pageSize-1];
      const nextCursor=result.rows.length>pageSize&&last?Buffer.from(JSON.stringify({version:1,scope,at:last.created_at,runId:last.run_id})).toString('base64url'):null;
      return freeze({items,nextCursor});
    }catch{throw new DevelopmentError('STORAGE_FAILED','catalog list');}
  }
  async summary(input:DevelopmentRunKey):Promise<DevelopmentRunSummary>{
    const key=freeze(parse(RunKeySchema,copy(input),'catalog identity'));
    try{
      const result=await this.pool.query<Row>(`SELECT ${projection} ${joins} WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.run_id=$3`,[key.tenantId,key.projectId,key.runId]);
      const row=result.rows[0];if(!row)throw new DevelopmentError('NOT_FOUND','catalog run');if(result.rows.length!==1||row.run_id!==key.runId)throw new Error();return freeze(decode(row,key));
    }catch(error){if(error instanceof DevelopmentError&&error.code==='NOT_FOUND')throw error;throw new DevelopmentError('STORAGE_FAILED','catalog summary');}
  }
}

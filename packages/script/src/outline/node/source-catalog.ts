import type { Pool } from 'pg';
import { z } from 'zod';
import { Hash,Id,Integer } from '../../contracts.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OutlineSourceListSchema,OutlineSourceSummarySchema } from '../http.js';
import type { OutlineSourceList } from '../http.js';
import { hash } from './data.js';

const Kind=z.enum(['development','bible']);
const Query=z.strictObject({tenantId:Id,projectId:Id,kind:Kind,cursor:z.string().min(1).max(512).optional()});
export type OutlineSourceCatalogQuery=z.infer<typeof Query>;
export interface OutlineSourceCatalogReader {list(input:OutlineSourceCatalogQuery):Promise<OutlineSourceList>}
const Stamp=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$(?![\s\S])/).refine(value=>{
  try{return new Date(value).toISOString()===value.slice(0,23)+'Z';}catch{return false;}
});
const Cursor=z.strictObject({version:z.literal(1),scope:Hash,at:Stamp,runId:Id});
const Revision=z.union([Integer.min(1),z.string().regex(/^[1-9]\d*$(?![\s\S])/).transform(Number).pipe(Integer.min(1))]);
const common={tenant_id:Id,project_id:Id,run_id:Id,run_digest:Hash,created_at:Stamp};
const Row=z.discriminatedUnion('kind',[
  z.strictObject({...common,kind:z.literal('development'),brief_digest:Hash,foundation_candidate_digest:Hash,foundation_review_status:z.literal('reviewed'),foundation_review_digest:Hash,
    episodes_candidate_digest:Hash,episodes_review_status:z.literal('reviewed'),episodes_review_digest:Hash}),
  z.strictObject({...common,kind:z.literal('bible'),document_id:Id,source_tenant_id:Id,source_project_id:Id,source_document_id:Id,source_kind:z.enum(['novel','script']),plan_source_kind:z.enum(['novel','script']),
    revision:Revision,source_digest:Hash,candidate_digest:Hash,review_status:z.literal('confirmed'),review_digest:Hash}),
]);
const stampSql=`to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;
const development=`SELECT 'development' AS kind,r.tenant_id,r.project_id,r.run_id,r.digest AS run_digest,r.brief_digest,${stampSql},
 fc.digest AS foundation_candidate_digest,fv.status AS foundation_review_status,fv.digest AS foundation_review_digest,
 ec.digest AS episodes_candidate_digest,ev.status AS episodes_review_status,ev.digest AS episodes_review_digest
 FROM camery_script.runs r
 LEFT JOIN camery_script.run_origins origin ON origin.tenant_id=r.tenant_id AND origin.project_id=r.project_id AND origin.run_id=r.run_id
 JOIN camery_script.candidates fc ON fc.tenant_id=r.tenant_id AND fc.project_id=r.project_id AND fc.run_id=COALESCE(origin.foundation_run_id,r.run_id) AND fc.stage='foundation'
 JOIN camery_script.reviews fv ON fv.tenant_id=r.tenant_id AND fv.project_id=r.project_id AND fv.run_id=COALESCE(origin.foundation_run_id,r.run_id) AND fv.stage='foundation' AND fv.status='reviewed'
 JOIN camery_script.candidates ec ON ec.tenant_id=r.tenant_id AND ec.project_id=r.project_id AND ec.run_id=r.run_id AND ec.stage='episodes'
 JOIN camery_script.reviews ev ON ev.tenant_id=r.tenant_id AND ev.project_id=r.project_id AND ev.run_id=r.run_id AND ev.stage='episodes' AND ev.status='reviewed'`;
const bible=`SELECT 'bible' AS kind,r.tenant_id,r.project_id,r.run_id,r.digest AS run_digest,r.document_id,r.source_kind,${stampSql},
 r.plan->'source'->>'tenantId' AS source_tenant_id,r.plan->'source'->>'projectId' AS source_project_id,r.plan->'source'->>'documentId' AS source_document_id,
 r.plan->'source'->>'kind' AS plan_source_kind,r.plan->'source'->>'revision' AS revision,r.plan->'source'->>'sourceDigest' AS source_digest,
 c.digest AS candidate_digest,v.status AS review_status,v.digest AS review_digest
 FROM camery_bible.runs r
 JOIN camery_bible.candidates c ON c.tenant_id=r.tenant_id AND c.project_id=r.project_id AND c.run_id=r.run_id
 JOIN camery_bible.reviews v ON v.tenant_id=r.tenant_id AND v.project_id=r.project_id AND v.run_id=r.run_id AND v.status='confirmed'`;
function decodeCursor(value:string,scope:string):z.infer<typeof Cursor>{
  try{
    if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error();const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw new Error();
    const cursor=capture(Cursor,JSON.parse(bytes.toString('utf8')),'source catalog cursor',1024);if(cursor.scope!==scope)throw new Error();return cursor;
  }catch{throw new OutlineError('INVALID_INPUT','source catalog cursor','cursor');}
}
function earlier(at:string,id:string,previousAt:string,previousId:string):boolean{return at<previousAt||at===previousAt&&id<previousId;}

/** Discovery metadata only. Stored review flags cannot authorize a caller or prove present-day source freshness. */
export class PostgresOutlineSourceCatalog implements OutlineSourceCatalogReader {
  constructor(private readonly pool:Pool){}
  async list(input:OutlineSourceCatalogQuery):Promise<OutlineSourceList>{
    const command=deepFreeze(capture(Query,input,'source catalog query',8192)),scope=hash({kind:'outline-source-catalog',tenantId:command.tenantId,projectId:command.projectId,sourceKind:command.kind});
    const cursor=command.cursor?decodeCursor(command.cursor,scope):null;
    const values:unknown[]=[command.tenantId,command.projectId];let where='r.tenant_id=$1 AND r.project_id=$2';
    if(cursor){values.push(cursor.at,cursor.runId);where+=' AND (r.created_at,r.run_id COLLATE "C") < ($3::timestamptz,$4::text COLLATE "C")';}
    try{
      const query=this.pool.query.bind(this.pool);
      const result=await query(`${command.kind==='development'?development:bible} WHERE ${where} ORDER BY r.created_at DESC,r.run_id COLLATE "C" DESC LIMIT 21`,values);
      const property=Object.getOwnPropertyDescriptor(result,'rows');if(!property||!('value' in property))throw new Error();
      const rows=capture(z.array(Row).max(21),property.value,'source catalog rows',65536),ids=new Set<string>();
      let previous=cursor?{at:cursor.at,id:cursor.runId}:null;
      for(const row of rows){
        if(row.kind!==command.kind||row.tenant_id!==command.tenantId||row.project_id!==command.projectId||ids.has(row.run_id)||previous&&!earlier(row.created_at,row.run_id,previous.at,previous.id))throw new Error();
        if(row.kind==='bible'&&(row.source_tenant_id!==command.tenantId||row.source_project_id!==command.projectId||row.source_document_id!==row.document_id||row.plan_source_kind!==row.source_kind))throw new Error();
        ids.add(row.run_id);previous={at:row.created_at,id:row.run_id};
      }
      const items=rows.slice(0,20).map(row=>OutlineSourceSummarySchema.parse({createdAt:row.created_at.slice(0,23)+'Z',source:row.kind==='development'?
        {kind:row.kind,runId:row.run_id,runDigest:row.run_digest,briefDigest:row.brief_digest,foundationReviewDigest:row.foundation_review_digest,episodesReviewDigest:row.episodes_review_digest}:
        {kind:row.kind,runId:row.run_id,runDigest:row.run_digest,documentId:row.document_id,revision:row.revision,sourceDigest:row.source_digest,reviewDigest:row.review_digest}}));
      const last=rows[19],nextCursor=rows.length>20&&last?Buffer.from(JSON.stringify({version:1,scope,at:last.created_at,runId:last.run_id})).toString('base64url'):null;
      return deepFreeze(OutlineSourceListSchema.parse({items,nextCursor}));
    }catch{throw new OutlineError('STORAGE_FAILED','source catalog list','storage');}
  }
}

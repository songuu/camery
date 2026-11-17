import type { Pool } from 'pg';
import { z } from 'zod';
import { Hash,Id,Integer } from '../../contracts.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineError } from '../contracts.js';
import { OutlineBriefSummarySchema,OutlineBriefListSchema } from '../http.js';
import { hash } from './data.js';

const Query=z.strictObject({tenantId:Id,projectId:Id,cursor:z.string().min(1).max(512).optional()});
export type OutlineBriefCatalogQuery=z.infer<typeof Query>;
export interface OutlineBriefCatalogReader {list(input:OutlineBriefCatalogQuery):Promise<z.infer<typeof OutlineBriefListSchema>>}
const Cursor=z.strictObject({version:z.literal(1),scope:Hash,briefId:Id});
const Revision=z.union([Integer.min(1),z.string().regex(/^[1-9]\d*$(?![\s\S])/).transform(Number).pipe(Integer.min(1))]);
const Row=z.strictObject({tenant_id:Id,project_id:Id,brief_id:Id,revision:Revision,notes_preview:z.string(),actor_id:Id,created_at:z.string()});

/** Latest saved brief headers include briefs with no run. Stable ID ordering is independent of mutable revision times. */
export class PostgresOutlineBriefCatalog implements OutlineBriefCatalogReader {
  constructor(private readonly pool:Pool){}
  async list(input:OutlineBriefCatalogQuery):Promise<z.infer<typeof OutlineBriefListSchema>>{
    const command=deepFreeze(capture(Query,input,'brief catalog query',4096)),scope=hash({kind:'outline-briefs',tenantId:command.tenantId,projectId:command.projectId});let after:string|null=null;
    if(command.cursor){
      try{
        if(!/^[A-Za-z0-9_-]+$/.test(command.cursor))throw new Error();const bytes=Buffer.from(command.cursor,'base64url');if(bytes.toString('base64url')!==command.cursor)throw new Error();
        const cursor=capture(Cursor,JSON.parse(bytes.toString('utf8')),'brief catalog cursor',4096);if(cursor.scope!==scope)throw new Error();after=cursor.briefId;
      }catch{throw new OutlineError('INVALID_INPUT','brief catalog cursor','cursor');}
    }
    try{
      const result=await this.pool.query<z.input<typeof Row>>(`SELECT DISTINCT ON (brief_id COLLATE "C") tenant_id,project_id,brief_id,revision,actor_id,
        left(record->>'notes',120) AS notes_preview,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        FROM camery_outline.briefs WHERE tenant_id=$1 AND project_id=$2 AND ($3::text IS NULL OR brief_id COLLATE "C">$3::text COLLATE "C")
        ORDER BY brief_id COLLATE "C",revision DESC LIMIT 21`,[command.tenantId,command.projectId,after]);
      if(result.rows.length>21)throw new Error();
      const items=result.rows.slice(0,20).map(input=>{
        const row=capture(Row,input,'brief catalog metadata',65536);if(row.tenant_id!==command.tenantId||row.project_id!==command.projectId)throw new Error();
        return OutlineBriefSummarySchema.parse({briefId:row.brief_id,revision:row.revision,notesPreview:row.notes_preview,actorId:row.actor_id,createdAt:row.created_at});
      });
      const last=items.at(-1),nextCursor=result.rows.length>20&&last?Buffer.from(JSON.stringify({version:1,scope,briefId:last.briefId})).toString('base64url'):null;
      return deepFreeze(OutlineBriefListSchema.parse({items,nextCursor}));
    }catch{throw new OutlineError('STORAGE_FAILED','brief catalog list','storage');}
  }
}

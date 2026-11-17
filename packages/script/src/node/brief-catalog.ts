import type {Pool} from 'pg';
import {z} from 'zod';
import {DevelopmentError,Id,Integer,Hash} from '../contracts.js';
import {DevelopmentBriefSummarySchema,DevelopmentBriefListSchema} from '../http.js';
import type {DevelopmentBriefList} from '../http.js';
import {copy,freeze,hash,parse} from '../data.js';
const Query=z.strictObject({tenantId:Id,projectId:Id,cursor:z.string().min(1).max(512).optional()});
export type DevelopmentBriefCatalogQuery=z.infer<typeof Query>;
export interface DevelopmentBriefCatalogReader {list(input:DevelopmentBriefCatalogQuery):Promise<DevelopmentBriefList>}
const Cursor=z.strictObject({version:z.literal(1),scope:Hash,briefId:Id});
const Revision=z.union([Integer.min(1),z.string().regex(/^[1-9]\d*$(?![\s\S])/).transform(Number).pipe(Integer.min(1))]);
interface Row {tenant_id:string;project_id:string;brief_id:string;revision:string|number;idea_preview:string;actor_id:string;created_at:string}
/** Lists only latest saved brief metadata, including ideas that have no run yet. Cursor ordering is independent of mutable revision times. */
export class PostgresDevelopmentBriefCatalog implements DevelopmentBriefCatalogReader{
  constructor(private readonly pool:Pool){}
  async list(input:DevelopmentBriefCatalogQuery):Promise<DevelopmentBriefList>{
    const command=freeze(parse(Query,copy(input),'brief catalog query'));const scope=hash({kind:'development-briefs',tenantId:command.tenantId,projectId:command.projectId});let after:string|null=null;
    if(command.cursor){
      try{if(!/^[A-Za-z0-9_-]+$/.test(command.cursor))throw new Error();const bytes=Buffer.from(command.cursor,'base64url');if(bytes.toString('base64url')!==command.cursor)throw new Error();const cursor=Cursor.parse(JSON.parse(bytes.toString('utf8')));if(cursor.scope!==scope)throw new Error();after=cursor.briefId;}
      catch{throw new DevelopmentError('INVALID_INPUT','brief catalog cursor');}
    }
    try{
      const result=await this.pool.query<Row>(`SELECT DISTINCT ON (brief_id COLLATE "C") tenant_id,project_id,brief_id,revision,actor_id,
        left(record->>'idea',120) AS idea_preview,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        FROM camery_script.briefs WHERE tenant_id=$1 AND project_id=$2 AND ($3::text IS NULL OR brief_id COLLATE "C">$3::text COLLATE "C")
        ORDER BY brief_id COLLATE "C",revision DESC LIMIT 21`,[command.tenantId,command.projectId,after]);
      if(result.rows.length>21)throw new Error();
      const items=result.rows.slice(0,20).map(row=>{
        if(row.tenant_id!==command.tenantId||row.project_id!==command.projectId)throw new Error();
        return DevelopmentBriefSummarySchema.parse({briefId:row.brief_id,revision:Revision.parse(row.revision),ideaPreview:row.idea_preview,actorId:row.actor_id,createdAt:row.created_at});
      });
      const last=items.at(-1);const nextCursor=result.rows.length>20&&last?Buffer.from(JSON.stringify({version:1,scope,briefId:last.briefId})).toString('base64url'):null;
      return freeze(DevelopmentBriefListSchema.parse({items,nextCursor}));
    }catch{throw new DevelopmentError('STORAGE_FAILED','brief catalog list');}
  }
}

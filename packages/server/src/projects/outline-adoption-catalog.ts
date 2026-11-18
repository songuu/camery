import type {Pool} from 'pg';
import {z} from 'zod';
import {freeze} from '@camery/methods';
import {StableId} from '@camery/ir';
import {OutlineCandidateHeaderSchema,OutlineCandidatePageSchema,OutlineCandidateListQuerySchema} from '@camery/ir/outline-adoption';
import type {OutlineCandidatePage} from '@camery/ir/outline-adoption';
import {ProjectIdentityScopeSchema} from './contracts.js';
import {OutlineVersionKeySchema} from '@camery/script/outline/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureOutlineIntent,safeOutlineIntent} from './outline-intent-data.js';
import {encodeReadCursor,decodeReadCursor} from './read-cursor.js';
const Query=OutlineCandidateListQuerySchema.extend({scope:ProjectIdentityScopeSchema,target:OutlineVersionKeySchema,subjectId:ProjectIdentityScopeSchema.shape.projectId});
export type OutlineCatalogQuery=z.infer<typeof Query>;
const stable=StableId.refine(value=>value.length===26);
const Row=OutlineCandidateHeaderSchema.extend({tenantId:ProjectIdentityScopeSchema.shape.tenantId,projectKey:ProjectIdentityScopeSchema.shape.projectId,irTenantId:stable,irProjectId:stable});

/** Read-only hints: complete immutable intent and source verification still happens at detail and action boundaries. */
export class PostgresOutlineCandidateCatalog{
  constructor(private readonly pool:Pool){}
  async list(input:OutlineCatalogQuery):Promise<OutlineCandidatePage>{
    const query=captureOutlineIntent(Query,input,'outline catalog query',16384),limit=query.limit??20;
    const binding={kind:'outline-catalog',scope:query.scope,target:query.target,subjectId:query.subjectId,runId:query.runId??null};
    const cursor=query.cursor?decodeReadCursor(binding,query.cursor,z.strictObject({last:stable})):null;
    return safeOutlineIntent('outline candidate catalog',async()=>{
      const result=await this.pool.query(`SELECT c.tenant_id AS "tenantId",c.project_id AS "projectKey",c.ir_tenant_id AS "irTenantId",c.ir_project_id AS "irProjectId",c.change_id AS "candidateId",c.application_id AS "applicationId",c.run_id AS "runId",COALESCE(v.status,r.record->>'status','prepared') AS status,c.ir_actor_id AS "authorId",to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",(c.record#>>'{expectation,expectedSnapshotRevision}')::double precision AS "baseRevision",jsonb_array_length(c.record#>'{draft,operations}') AS "operationCount" FROM camery_projects.outline_candidate_intents c LEFT JOIN camery_versioning.changes v ON v.tenant_id=c.ir_tenant_id AND v.project_id=c.ir_project_id AND v.change_id=c.change_id LEFT JOIN camery_projects.outline_candidate_receipts r ON r.tenant_id=c.tenant_id AND r.project_id=c.project_id AND r.application_id=c.application_id AND r.intent_digest=c.digest WHERE c.tenant_id=$1 AND c.project_id=$2 AND c.ir_tenant_id=$3 AND c.ir_project_id=$4 AND ($5::text IS NULL OR c.run_id=$5) AND ($6::text IS NULL OR c.change_id COLLATE "C" < $6 COLLATE "C") ORDER BY c.change_id COLLATE "C" DESC LIMIT $7`,[query.scope.tenantId,query.scope.projectId,query.target.tenantId,query.target.projectId,query.runId??null,cursor?.last??null,limit+1]);
      if(result.rows.length>limit+1)throw new ProjectApplicationError('STORAGE_FAILED','outline catalog cardinality');let previous=cursor?.last;
      const items=result.rows.map(input=>{const row=Row.parse(input);if(row.tenantId!==query.scope.tenantId||row.projectKey!==query.scope.projectId||row.irTenantId!==query.target.tenantId||row.irProjectId!==query.target.projectId||query.runId!==undefined&&row.runId!==query.runId||previous!==undefined&&row.candidateId>=previous)throw new ProjectApplicationError('STORAGE_FAILED','outline catalog scope or order');previous=row.candidateId;const {tenantId:_,projectKey:__,irTenantId:___,irProjectId:____,...header}=row;return header;});
      const selected=items.slice(0,limit),last=selected.at(-1);return freeze(OutlineCandidatePageSchema.parse({contractVersion:1,items:selected,nextCursor:items.length>limit&&last?encodeReadCursor(binding,{last:last.candidateId}):null}));
    });
  }
}

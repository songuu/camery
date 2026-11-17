import type {Pool} from 'pg';
import {z} from 'zod';
import {StableId,StoryboardPackage,StoryboardPackageV06,validatePackage} from '@camery/ir';
import type {StoryboardPackage as Package} from '@camery/ir';
import {WorkbenchCollectionSchema} from '@camery/ir/workbench';
import {freeze} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import type {ObjectRevision} from '@camery/versioning';
import type {VersionProjectKey} from '@camery/versioning/node';
import {ProjectApplicationError} from './intent-contracts.js';

type Collection=z.infer<typeof WorkbenchCollectionSchema>;
export interface ProjectReadHead {head:Package;writeVersion:number;pendingCount:number}
export interface ProjectReadHistory {snapshotRevision:number;writeVersion:number;items:ObjectRevision[]}
export interface ProjectReadHistoryInput {target:VersionProjectKey;collection:Collection;objectId:string;expectedRevision:number;beforeVersion?:number;limit:number}
export interface ProjectReadStore {head(target:VersionProjectKey):Promise<ProjectReadHead|null>;history(input:ProjectReadHistoryInput):Promise<ProjectReadHistory|null>}
const stable=StableId.refine(value=>value.length===26);
const positive=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nonnegative=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const key=z.strictObject({tenantId:stable,projectId:stable});
const inputSchema=z.strictObject({target:key,collection:WorkbenchCollectionSchema,objectId:stable,expectedRevision:positive,beforeVersion:positive.optional(),limit:positive.max(51)});
const numeric=(zero=false)=>z.union([zero?nonnegative:positive,z.string().regex(zero?/^(?:0|[1-9][0-9]*)$(?![\s\S])/:/^[1-9][0-9]*$(?![\s\S])/).transform(Number).pipe(zero?nonnegative:positive)]);
const header={tenant_id:stable,project_id:stable,head_revision:numeric(),write_version:numeric()};
const headSchema=z.strictObject({...header,package_id:stable,pending_count:numeric(true),package:z.unknown()});
const historySchema=z.strictObject({...header,object_id:stable.nullable(),version:numeric().nullable(),parent_version:numeric().nullable(),snapshot_revision:numeric().nullable(),change_id:stable.nullable(),record:z.unknown()});
const revisionSchema=z.strictObject({collection:WorkbenchCollectionSchema,object_id:stable,version:positive,parent_version:positive.nullable(),snapshot_revision:positive,change_set_id:stable.nullable(),value:z.record(z.string(),z.unknown()).nullable()});
const definitions:Record<string,z.ZodType>=StoryboardPackageV06.shape;
function capture<S extends z.ZodType>(schema:S,input:unknown):z.infer<S>{
  try{return freeze(schema.parse(snapshotJson(input,8192))) as z.infer<S>;}
  catch{throw new ProjectApplicationError('INVALID_INPUT','read store input');}
}
function storedRows(input:unknown):unknown[]{
  try{const rows=snapshotJson(input,67_108_864,65536);if(!Array.isArray(rows))throw new Error();return rows;}
  catch(error){if(error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT')throw new ProjectApplicationError('INPUT_LIMIT','stored read size');throw new ProjectApplicationError('STORAGE_FAILED','stored read boundary');}
}
function knownFailure(error:unknown):error is ProjectApplicationError{try{return error instanceof ProjectApplicationError;}catch{return false;}}
async function read<T>(operation:string,action:()=>Promise<T>):Promise<T>{
  try{return await action();}catch(error){if(knownFailure(error))throw error;throw new ProjectApplicationError('STORAGE_FAILED',operation);}
}
function checkedHeader(row:z.infer<typeof historySchema>|z.infer<typeof headSchema>,target:VersionProjectKey):void{
  if(row.tenant_id!==target.tenantId||row.project_id!==target.projectId)throw new ProjectApplicationError('STORAGE_FAILED','read project binding');
}
function revisionValue(record:z.infer<typeof revisionSchema>):void{
  if(record.parent_version!==null&&record.version!==record.parent_version+1)throw new Error();
  if(record.value===null)return;
  const schema=definitions[record.collection];if(!(schema instanceof z.ZodArray))throw new Error();
  const parsed=z.safeParse(schema.element,record.value);if(!parsed.success||record.value['id']!==record.object_id||record.value['version']!==record.version)throw new Error();
}

/** Reads existing version facts only. Authentication and ordinary identity mapping belong to ProjectApplication. */
export class PostgresProjectReadStore implements ProjectReadStore{
  constructor(private readonly pool:Pool){}
  async head(input:VersionProjectKey):Promise<ProjectReadHead|null>{
    const target=capture(key,input);
    return read('read project head',async()=>{
      // One statement binds the head, package, candidate count and write metadata to the same MVCC snapshot.
      const result=await this.pool.query(`SELECT p.tenant_id,p.project_id,p.package_id,p.head_revision,p.write_version,s.package,
        (SELECT count(*) FROM camery_versioning.changes c WHERE c.tenant_id=p.tenant_id AND c.project_id=p.project_id AND c.status='candidate') AS pending_count
        FROM camery_versioning.projects p LEFT JOIN camery_versioning.snapshots s ON s.tenant_id=p.tenant_id AND s.project_id=p.project_id AND s.revision=p.head_revision
        WHERE p.tenant_id=$1 AND p.project_id=$2`,[target.tenantId,target.projectId]);
      const rows=storedRows(result.rows);if(rows.length===0)return null;if(rows.length!==1)throw new Error();const row=headSchema.parse(rows[0]);checkedHeader(row,target);
      const head=StoryboardPackage.parse(row.package);
      if(head.project.id!==row.project_id||head.package_id!==row.package_id||head.revision.number!==row.head_revision||head.revision.status!=='adopted'||!validatePackage(head).valid)throw new Error();
      return freeze({head,writeVersion:row.write_version,pendingCount:row.pending_count});
    });
  }
  async history(input:ProjectReadHistoryInput):Promise<ProjectReadHistory|null>{
    const command=capture(inputSchema,input);
    return read('read object history',async()=>{
      // A later head cannot be paired with earlier paginated records, even if adoption commits concurrently.
      const result=await this.pool.query(`SELECT p.tenant_id,p.project_id,p.head_revision,p.write_version,h.object_id,h.version,h.parent_version,h.snapshot_revision,h.change_id,h.record
        FROM camery_versioning.projects p LEFT JOIN LATERAL (
          SELECT object_id,version,parent_version,snapshot_revision,change_id,record FROM camery_versioning.object_revisions r
          WHERE r.tenant_id=p.tenant_id AND r.project_id=p.project_id AND r.object_id=$3 AND r.record->>'collection'=$4
            AND r.snapshot_revision<=$5 AND ($6::bigint IS NULL OR r.version<$6::bigint)
          ORDER BY r.version DESC LIMIT $7
        ) h ON true WHERE p.tenant_id=$1 AND p.project_id=$2 ORDER BY h.version DESC NULLS LAST`,
      [command.target.tenantId,command.target.projectId,command.objectId,command.collection,command.expectedRevision,command.beforeVersion??null,command.limit]);
      const rows=storedRows(result.rows);if(rows.length===0)return null;if(rows.length>command.limit)throw new Error();
      const parsed=rows.map(row=>historySchema.parse(row));const first=parsed[0]!;checkedHeader(first,command.target);
      if(first.head_revision!==command.expectedRevision)throw new ProjectApplicationError('SNAPSHOT_STALE','object history base');
      const items:ObjectRevision[]=[];let previousVersion=command.beforeVersion;let previousSnapshot=command.expectedRevision;let expectedParent:number|null|undefined;
      for(const row of parsed){
        checkedHeader(row,command.target);if(row.head_revision!==first.head_revision||row.write_version!==first.write_version)throw new Error();
        if(row.record===null){if(parsed.length!==1||[row.object_id,row.version,row.parent_version,row.snapshot_revision,row.change_id].some(value=>value!==null))throw new Error();continue;}
        const record=revisionSchema.parse(row.record);
        if(row.object_id!==command.objectId||record.object_id!==row.object_id||record.collection!==command.collection||record.version!==row.version||record.parent_version!==row.parent_version||record.snapshot_revision!==row.snapshot_revision||record.change_set_id!==row.change_id
          ||record.snapshot_revision>previousSnapshot||previousVersion!==undefined&&record.version>=previousVersion||items.length>0&&record.version!==expectedParent)throw new Error();
        revisionValue(record);previousVersion=record.version;previousSnapshot=record.snapshot_revision;expectedParent=record.parent_version;items.push(record);
      }
      return freeze({snapshotRevision:first.head_revision,writeVersion:first.write_version,items});
    });
  }
}

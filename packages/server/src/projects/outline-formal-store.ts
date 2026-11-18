import type {Pool} from 'pg';
import {z} from 'zod';
import {StableId,StoryboardPackage,validatePackage} from '@camery/ir';
import type {StoryboardPackageV07} from '@camery/ir';
import {freeze} from '@camery/methods';
import {snapshotJson} from '@camery/methods/json';
import type {VersionProjectKey} from '@camery/versioning/node';
import {ProjectApplicationError} from './intent-contracts.js';
import {captureOutlineIntent,safeOutlineIntent} from './outline-intent-data.js';

const stable=StableId.refine(value=>value.length===26),positive=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
// A package can contain several individually bounded outline graphs and unrelated legacy objects.
const SNAPSHOT_BYTES=67108864;
const Key=z.strictObject({tenantId:stable,projectId:stable});
const Input=z.strictObject({target:Key,revision:positive.optional()});
const Row=z.strictObject({tenant_id:stable,project_id:stable,package_id:stable,head_revision:positive,write_version:positive,snapshot_revision:positive.nullable(),package_digest:z.string().regex(/^[a-f0-9]{64}$(?![\s\S])/).nullable(),package_unchanged:z.boolean(),package:z.unknown()});
export interface OutlineFormalSnapshot{readonly target:Readonly<VersionProjectKey>;readonly packageId:string;readonly headRevision:number;readonly writeVersion:number;readonly revision:number;readonly snapshot:StoryboardPackageV07}
export interface OutlineFormalSnapshotInput{readonly target:VersionProjectKey;readonly revision?:number}
interface ValidatedSnapshot{readonly target:Readonly<VersionProjectKey>;readonly packageId:string;readonly revision:number;readonly digest:string;readonly snapshot:StoryboardPackageV07}

/** One MVCC statement pairs an immutable selected snapshot with its current project header; reads never create or lock projects. */
export class PostgresOutlineFormalReadStore{
  private cached:ValidatedSnapshot|undefined;
  constructor(private readonly pool:Pool){}
  async snapshot(input:OutlineFormalSnapshotInput):Promise<OutlineFormalSnapshot|null>{
    const command=captureOutlineIntent(Input,input,'formal snapshot input',8192);
    // Bind both SQL parameters and validation to this entry, even if a concurrent request replaces it while awaiting PG.
    const entry=this.cached,cached=entry?.target.tenantId===command.target.tenantId&&entry.target.projectId===command.target.projectId?entry:undefined;
    return safeOutlineIntent('formal snapshot read',async()=>{
      const result=await this.pool.query(`WITH selected AS MATERIALIZED (
        SELECT p.tenant_id,p.project_id,p.package_id,p.head_revision::double precision AS head_revision,p.write_version::double precision AS write_version,s.revision::double precision AS snapshot_revision,s.package,
          encode(sha256(convert_to(s.package::text,'UTF8')),'hex') AS package_digest,s.revision=$4::bigint AS revision_cached
        FROM camery_versioning.projects p LEFT JOIN camery_versioning.snapshots s ON s.tenant_id=p.tenant_id AND s.project_id=p.project_id AND s.revision=COALESCE($3::bigint,p.head_revision) WHERE p.tenant_id=$1 AND p.project_id=$2
      ) SELECT tenant_id,project_id,package_id,head_revision,write_version,snapshot_revision,package_digest,
        COALESCE(revision_cached AND package_digest=$5::text,false) AS package_unchanged,
        CASE WHEN revision_cached AND package_digest=$5::text THEN NULL ELSE package END AS package FROM selected`,[command.target.tenantId,command.target.projectId,command.revision??null,cached?.revision??null,cached?.digest??null]);
      const rows=snapshotJson(result.rows,SNAPSHOT_BYTES,131072);if(!Array.isArray(rows))throw new Error();if(rows.length===0)return null;if(rows.length!==1)throw new Error();
      const row=Row.parse(rows[0]);if(row.tenant_id!==command.target.tenantId||row.project_id!==command.target.projectId)throw new Error();
      if(row.snapshot_revision===null){if(row.package_digest!==null||row.package_unchanged||row.package!==null)throw new Error();if(command.revision!==undefined)throw new ProjectApplicationError('NOT_FOUND','formal selected snapshot');throw new Error();}
      if(row.snapshot_revision>row.head_revision||command.revision!==undefined&&row.snapshot_revision!==command.revision||command.revision===undefined&&row.snapshot_revision!==row.head_revision)throw new Error();
      if(row.package_digest===null)throw new Error();
      if(row.package_unchanged){
        if(!cached||cached.revision!==row.snapshot_revision||cached.packageId!==row.package_id||cached.digest!==row.package_digest||row.package!==null)throw new Error();
        return Object.freeze({target:command.target,packageId:row.package_id,headRevision:row.head_revision,writeVersion:row.write_version,revision:row.snapshot_revision,snapshot:cached.snapshot});
      }
      // The entire row was already captured above; do not copy its potentially large package twice.
      const selected=StoryboardPackage.parse(row.package);
      if(selected.package_id!==row.package_id||selected.project.id!==command.target.projectId||selected.revision.number!==row.snapshot_revision||selected.revision.status!=='adopted'||!validatePackage(selected).valid)throw new Error();
      if(selected.schema_version!=='0.7.0-draft')throw new ProjectApplicationError('SCHEMA_UPGRADE_REQUIRED','formal outline schema');
      // One bounded entry avoids unbounded project retention; every reuse still requires a new database fingerprint and header.
      const snapshot=freeze(selected);this.cached=Object.freeze({target:command.target,packageId:row.package_id,revision:row.snapshot_revision,digest:row.package_digest,snapshot});
      return Object.freeze({target:command.target,packageId:row.package_id,headRevision:row.head_revision,writeVersion:row.write_version,revision:row.snapshot_revision,snapshot});
    });
  }
}

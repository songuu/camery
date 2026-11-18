import {z} from 'zod';
import type {PoolClient} from 'pg';
import {DevelopmentError,Hash,Id,Integer} from '../contracts.js';
import {copy,parse} from '../data.js';
import {validateBrief} from '../brief.js';
import {FormalStableId} from './adoption-contracts.js';
import {validateOutlineBrief} from '../outline/node/brief.js';
const Evidence=z.strictObject({owner_run_id:Id,ir_tenant_id:FormalStableId,ir_project_id:FormalStableId,brief_id:Id,brief_revision:Integer.min(1),brief_digest:Hash,tenant_id:Id,project_id:Id,stored_brief_id:Id,stored_revision:Integer.min(1),digest:Hash,record:z.unknown()});
const OutlineEvidence=Evidence.extend({proof_run_digest:Hash,run_digest:Hash,review_digest:Hash,stored_review_digest:Hash,episode_count:Integer.min(1).max(100)});
const developmentSql=`SELECT i.owner_run_id,i.ir_tenant_id,i.ir_project_id,r.brief_id,r.brief_revision::double precision AS brief_revision,r.brief_digest,b.tenant_id,b.project_id,b.brief_id AS stored_brief_id,b.revision::double precision AS stored_revision,b.digest,b.record
  FROM (SELECT DISTINCT owner_run_id,ir_tenant_id,ir_project_id FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 AND kind IN ('world','character','relationship')) i
  LEFT JOIN camery_script.runs r ON r.tenant_id=$1 AND r.project_id=$2 AND r.run_id=i.owner_run_id
  LEFT JOIN camery_script.briefs b ON b.tenant_id=r.tenant_id AND b.project_id=r.project_id AND b.brief_id=r.brief_id AND b.revision=r.brief_revision
  WHERE i.owner_run_id COLLATE "C">$3::text COLLATE "C" ORDER BY i.owner_run_id COLLATE "C" LIMIT 64`;
const outlineSql=`SELECT p.run_id AS owner_run_id,owned.ir_tenant_id,owned.ir_project_id,r.brief_id,r.brief_revision::double precision AS brief_revision,r.brief_digest,b.tenant_id,b.project_id,b.brief_id AS stored_brief_id,b.revision::double precision AS stored_revision,b.digest,b.record,p.run_digest AS proof_run_digest,r.digest AS run_digest,p.review_digest,a.digest AS stored_review_digest,p.episode_count
  FROM (SELECT run_id,ir_tenant_id,ir_project_id FROM camery_outline.identity_preparations WHERE tenant_id=$1 AND project_id=$2
    UNION SELECT outline_owner_run_id AS run_id,ir_tenant_id,ir_project_id FROM camery_script.ir_identities WHERE tenant_id=$1 AND project_id=$2 AND kind IN ('outline_character','outline_beat','outline_asset','outline_plot_unit','outline_decision')) owned
  LEFT JOIN camery_outline.identity_preparations p ON p.tenant_id=$1 AND p.project_id=$2 AND p.run_id=owned.run_id
  LEFT JOIN camery_outline.runs r ON r.tenant_id=$1 AND r.project_id=$2 AND r.run_id=owned.run_id
  LEFT JOIN camery_outline.briefs b ON b.tenant_id=r.tenant_id AND b.project_id=r.project_id AND b.brief_id=r.brief_id AND b.revision=r.brief_revision
  LEFT JOIN camery_outline.reviews a ON a.tenant_id=p.tenant_id AND a.project_id=p.project_id AND a.run_id=p.run_id AND a.status='reviewed'
  WHERE owned.run_id COLLATE "C">$3::text COLLATE "C" ORDER BY owned.run_id COLLATE "C" LIMIT 64`;
function failed():never{throw new DevelopmentError('STORAGE_FAILED','committed IR episode extent');}
/** Called under the shared project registry lock. Historical immutable briefs are read without taking source locks in reverse order. */
export async function readIdentityEpisodeExtents(client:PoolClient,scope:{tenantId:string;projectId:string},target:{tenantId:string;projectId:string}):Promise<{development:number;outline:number}>{
  try{
    const read=async(outline:boolean)=>{let cursor='',maximum=0;for(;;){
      const result=await client.query(outline?outlineSql:developmentSql,[scope.tenantId,scope.projectId,cursor]);
      if(result.rows.length>64)failed();
      for(const raw of result.rows){const row=outline?parse(OutlineEvidence,copy(raw),'IR outline extent evidence'):parse(Evidence,copy(raw),'IR extent evidence'),brief=outline?validateOutlineBrief(row.record):validateBrief(row.record);
        if(row.owner_run_id<=cursor||row.ir_tenant_id!==target.tenantId||row.ir_project_id!==target.projectId||row.tenant_id!==scope.tenantId||row.project_id!==scope.projectId||brief.tenantId!==scope.tenantId||brief.projectId!==scope.projectId
          ||row.brief_id!==row.stored_brief_id||brief.briefId!==row.brief_id||row.brief_revision!==row.stored_revision||brief.revision!==row.brief_revision||row.brief_digest!==row.digest||brief.digest!==row.digest)failed();
        if(outline){const proof=parse(OutlineEvidence,copy(raw),'IR outline extent binding');if(proof.run_digest!==proof.proof_run_digest||proof.review_digest!==proof.stored_review_digest||proof.episode_count!==brief.episodeCount)failed();}
        cursor=row.owner_run_id;maximum=Math.max(maximum,brief.episodeCount);
      }
      if(result.rows.length<64)break;
    }return maximum;};
    const development=await read(false);
    const exists=await client.query("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='camery_outline' AND c.relname='identity_preparations' AND c.relkind IN ('r','p')) AS installed"),installed=parse(z.strictObject({installed:z.boolean()}),copy(exists.rows[0]),'IR extent installation');
    if(exists.rows.length!==1)failed();const outline=installed.installed?await read(true):0;
    return {development,outline};
  }catch{return failed();}
}

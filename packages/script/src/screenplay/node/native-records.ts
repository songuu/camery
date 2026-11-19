import type {PoolClient} from 'pg';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {SCREENPLAY_CANDIDATE_BYTES,ScreenplayError} from '../contracts.js';
import {canonicalContinuity,continuityDigest} from '../../continuity/node/digest.js';
import type {ContinuityTarget} from '../../continuity/node/persistence-contracts.js';
import {ScreenplayNativeBindingSchema,ScreenplayNativeReceiptSchema} from './native-contracts.js';
import type {ScreenplayNativeBinding,ScreenplayNativeReceipt} from './native-contracts.js';
const same=(a:unknown,b:unknown)=>canonicalContinuity(a,SCREENPLAY_CANDIDATE_BYTES)===canonicalContinuity(b,SCREENPLAY_CANDIDATE_BYTES);
function invalid(path:string):never{throw new ScreenplayError('STORAGE_FAILED','native screenplay proof',path);}
const bindingFields='tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,change_id,source_revision,mapping_digest,review_digest,digest,record';
const receiptFields='formal_tenant_id,formal_project_id,change_id,from_revision,to_revision,binding_digest,digest,record';
export async function readScreenplayNativeBinding(client:PoolClient,target:ContinuityTarget,changeId:string):Promise<ScreenplayNativeBinding|null>{
  const rows=await client.query(`SELECT ${bindingFields} FROM camery_screenplay.native_bindings WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND change_id=$3`,[target.tenantId,target.projectId,changeId]);
  if(rows.rows.length>1)invalid('binding cardinality');if(!rows.rows.length)return null;const row=rows.rows[0],binding=captureScreenplay(ScreenplayNativeBindingSchema,row.record,'stored screenplay binding',SCREENPLAY_CANDIDATE_BYTES),{digest,...body}=binding,mapping=binding.mapping;
  if(row.tenant_id!==binding.key.tenantId||row.project_id!==binding.key.projectId||row.candidate_id!==binding.key.candidateId||row.formal_tenant_id!==target.tenantId||row.formal_project_id!==target.projectId||row.change_id!==changeId||!same(mapping.target,target)||mapping.request.id!==changeId||String(row.source_revision)!==String(mapping.sourceRevision)||row.mapping_digest!==mapping.digest||row.review_digest!==mapping.reviewDigest||row.digest!==digest||continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)!==digest)invalid('binding columns');
  return freezeScreenplay(binding);
}
export async function insertScreenplayNativeBinding(client:PoolClient,input:ScreenplayNativeBinding):Promise<void>{
  const binding=captureScreenplay(ScreenplayNativeBindingSchema,input,'screenplay binding',SCREENPLAY_CANDIDATE_BYTES),m=binding.mapping;
  await client.query(`INSERT INTO camery_screenplay.native_bindings(${bindingFields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT DO NOTHING`,[binding.key.tenantId,binding.key.projectId,binding.key.candidateId,m.target.tenantId,m.target.projectId,m.request.id,m.sourceRevision,m.digest,m.reviewDigest,binding.digest,canonicalContinuity(binding,SCREENPLAY_CANDIDATE_BYTES)]);
  if(!same(await readScreenplayNativeBinding(client,m.target,m.request.id),binding))invalid('immutable binding');
}
export async function readScreenplayNativeReceipt(client:PoolClient,target:ContinuityTarget,changeId:string):Promise<ScreenplayNativeReceipt|null>{
  const rows=await client.query(`SELECT ${receiptFields} FROM camery_screenplay.native_adoptions WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND change_id=$3`,[target.tenantId,target.projectId,changeId]);
  if(rows.rows.length>1)invalid('receipt cardinality');if(!rows.rows.length)return null;const row=rows.rows[0],receipt=captureScreenplay(ScreenplayNativeReceiptSchema,row.record,'stored screenplay adoption',SCREENPLAY_CANDIDATE_BYTES),{digest,...body}=receipt;
  if(row.formal_tenant_id!==target.tenantId||row.formal_project_id!==target.projectId||row.change_id!==changeId||!same(receipt.target,target)||receipt.changeId!==changeId||String(row.from_revision)!==String(receipt.fromRevision)||String(row.to_revision)!==String(receipt.toRevision)||receipt.toRevision!==receipt.fromRevision+1||row.binding_digest!==receipt.bindingDigest||row.digest!==digest||continuityDigest(body,SCREENPLAY_CANDIDATE_BYTES)!==digest)invalid('receipt columns');return freezeScreenplay(receipt);
}
export async function insertScreenplayNativeReceipt(client:PoolClient,input:ScreenplayNativeReceipt):Promise<void>{
  const receipt=captureScreenplay(ScreenplayNativeReceiptSchema,input,'screenplay adoption',SCREENPLAY_CANDIDATE_BYTES);
  await client.query(`INSERT INTO camery_screenplay.native_adoptions(${receiptFields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT DO NOTHING`,[receipt.target.tenantId,receipt.target.projectId,receipt.changeId,receipt.fromRevision,receipt.toRevision,receipt.bindingDigest,receipt.digest,canonicalContinuity(receipt,SCREENPLAY_CANDIDATE_BYTES)]);
  if(!same(await readScreenplayNativeReceipt(client,receipt.target,receipt.changeId),receipt))invalid('immutable receipt');
}

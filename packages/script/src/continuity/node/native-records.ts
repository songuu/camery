import type {PoolClient} from 'pg';
import {captureContinuity,freezeContinuity} from '../boundary.js';
import {ContinuityError} from '../contracts.js';
import {canonicalContinuity,continuityDigest} from './digest.js';
import {CONTINUITY_NATIVE_RECORD_BYTES,ContinuityNativeBindingSchema,ContinuityNativeReceiptSchema} from './native-contracts.js';
import type {ContinuityNativeBinding,ContinuityNativeReceipt} from './native-contracts.js';
import type {ContinuityTarget} from './persistence-contracts.js';

const bindingFields='tenant_id,project_id,candidate_id,formal_tenant_id,formal_project_id,change_id,snapshot_id,snapshot_version,source_revision,candidate_digest,review_digest,request_digest,digest,record';
const receiptFields='formal_tenant_id,formal_project_id,change_id,snapshot_id,snapshot_version,from_revision,to_revision,binding_digest,review_digest,ledger_digest,digest,record';
type Row=Record<string,unknown>;
function failed(operation:string,code:'STORAGE_FAILED'|'CONFLICT'='STORAGE_FAILED'):never{throw new ContinuityError(code,operation,'native proof');}
function safe(error:unknown,operation:string):never{let known=false;try{known=error instanceof ContinuityError;}catch{/* Driver prototype traps do not supply public diagnostics. */}if(known)throw error;return failed(operation);}
function columns(row:Row,expected:Record<string,string|number>):void{
  for(const [key,value] of Object.entries(expected))if(row[key]!==value&&(typeof value!=='number'||row[key]!==String(value)))failed('native proof columns');
}
function bindingColumns(record:ContinuityNativeBinding){return {tenant_id:record.key.tenantId,project_id:record.key.projectId,candidate_id:record.key.candidateId,formal_tenant_id:record.target.tenantId,formal_project_id:record.target.projectId,change_id:record.changeId,snapshot_id:record.snapshot.id,snapshot_version:record.snapshot.version,source_revision:record.sourceRevision,candidate_digest:record.candidateDigest,review_digest:record.reviewDigest,request_digest:record.requestDigest,digest:record.digest};}
function receiptColumns(record:ContinuityNativeReceipt){return {formal_tenant_id:record.target.tenantId,formal_project_id:record.target.projectId,change_id:record.changeId,snapshot_id:record.snapshot.id,snapshot_version:record.snapshot.version,from_revision:record.fromRevision,to_revision:record.toRevision,binding_digest:record.bindingDigest,review_digest:record.reviewDigest,ledger_digest:record.ledgerDigest,digest:record.digest};}
function targetMatches(record:{target:ContinuityTarget;changeId:string},target:ContinuityTarget,changeId:string):void{
  if(record.target.tenantId!==target.tenantId||record.target.projectId!==target.projectId||record.changeId!==changeId)failed('native proof target');
}
function boundDigest(record:ContinuityNativeBinding|ContinuityNativeReceipt):void{
  const {digest,...body}=record;if(continuityDigest(body,CONTINUITY_NATIVE_RECORD_BYTES)!==digest)failed('native proof digest');
}
/** Trusted storage read on the caller's transaction; these helpers never commit, release or grant authority. */
export async function readContinuityNativeBinding(client:PoolClient,target:ContinuityTarget,changeId:string):Promise<ContinuityNativeBinding|null>{
  try{
    const result=await client.query(`SELECT ${bindingFields} FROM camery_continuity.native_bindings WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND change_id=$3`,[target.tenantId,target.projectId,changeId]);
    if(result.rows.length===0)return null;if(result.rows.length!==1)failed('native binding cardinality');
    const row=result.rows[0] as Row,record=captureContinuity(ContinuityNativeBindingSchema,row['record'],'native binding',CONTINUITY_NATIVE_RECORD_BYTES);
    columns(row,bindingColumns(record));targetMatches(record,target,changeId);boundDigest(record);return freezeContinuity(record);
  }catch(error){return safe(error,'read native binding');}
}
export async function readContinuityNativeReceipt(client:PoolClient,target:ContinuityTarget,changeId:string):Promise<ContinuityNativeReceipt|null>{
  try{
    const result=await client.query(`SELECT ${receiptFields} FROM camery_continuity.native_adoptions WHERE formal_tenant_id=$1 AND formal_project_id=$2 AND change_id=$3`,[target.tenantId,target.projectId,changeId]);
    if(result.rows.length===0)return null;if(result.rows.length!==1)failed('native adoption cardinality');
    const row=result.rows[0] as Row,record=captureContinuity(ContinuityNativeReceiptSchema,row['record'],'native adoption',CONTINUITY_NATIVE_RECORD_BYTES);
    columns(row,receiptColumns(record));targetMatches(record,target,changeId);boundDigest(record);if(record.toRevision!==record.fromRevision+1)failed('native adoption revision');return freezeContinuity(record);
  }catch(error){return safe(error,'read native adoption');}
}
export async function insertContinuityNativeBinding(client:PoolClient,input:ContinuityNativeBinding):Promise<void>{
  try{
    const record=captureContinuity(ContinuityNativeBindingSchema,input,'native binding',CONTINUITY_NATIVE_RECORD_BYTES);boundDigest(record);
    await client.query(`INSERT INTO camery_continuity.native_bindings(${bindingFields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT DO NOTHING`,[...Object.values(bindingColumns(record)),canonicalContinuity(record,CONTINUITY_NATIVE_RECORD_BYTES)]);
    const saved=await readContinuityNativeBinding(client,record.target,record.changeId);
    if(!saved||canonicalContinuity(saved,CONTINUITY_NATIVE_RECORD_BYTES)!==canonicalContinuity(record,CONTINUITY_NATIVE_RECORD_BYTES))failed('immutable native binding','CONFLICT');
  }catch(error){safe(error,'insert native binding');}
}
export async function insertContinuityNativeReceipt(client:PoolClient,input:ContinuityNativeReceipt):Promise<void>{
  try{
    const record=captureContinuity(ContinuityNativeReceiptSchema,input,'native adoption',CONTINUITY_NATIVE_RECORD_BYTES);boundDigest(record);if(record.toRevision!==record.fromRevision+1)failed('native adoption revision');
    await client.query(`INSERT INTO camery_continuity.native_adoptions(${receiptFields}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT DO NOTHING`,[...Object.values(receiptColumns(record)),canonicalContinuity(record,CONTINUITY_NATIVE_RECORD_BYTES)]);
    const saved=await readContinuityNativeReceipt(client,record.target,record.changeId);
    if(!saved||canonicalContinuity(saved,CONTINUITY_NATIVE_RECORD_BYTES)!==canonicalContinuity(record,CONTINUITY_NATIVE_RECORD_BYTES))failed('immutable native adoption','CONFLICT');
  }catch(error){safe(error,'insert native adoption');}
}

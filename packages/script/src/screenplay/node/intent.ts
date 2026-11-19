import {z} from 'zod';
import type {PoolClient} from 'pg';
import {StableId} from '@camery/ir';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {ScreenplayError} from '../contracts.js';
import {ScreenplayKeySchema} from './contracts.js';
import {authorizeScreenplayHost} from './host.js';
import {readScreenplayNativeBinding} from './native-records.js';
const Pointer=z.strictObject({formal_tenant_id:StableId,formal_project_id:StableId,change_id:StableId});
/** Discover only committed original IDs. No row means no committed domain binding; never fabricate an adoption ACK. */
export async function readScreenplayNativeIntent(client:PoolClient,input:unknown,host:unknown){
  const key=freezeScreenplay(captureScreenplay(ScreenplayKeySchema,input,'screenplay intention key',2048));authorizeScreenplayHost(host,'screenplay:read',{tenantId:key.tenantId,projectId:key.projectId});
  try{
    const rows=await client.query('SELECT formal_tenant_id,formal_project_id,change_id FROM camery_screenplay.native_bindings WHERE tenant_id=$1 AND project_id=$2 AND candidate_id=$3',[key.tenantId,key.projectId,key.candidateId]);
    if(!rows.rows.length)return null;if(rows.rows.length!==1)throw new ScreenplayError('STORAGE_FAILED','original screenplay intention','cardinality');
    const pointer=captureScreenplay(Pointer,rows.rows[0],'original screenplay intention',2048),binding=await readScreenplayNativeBinding(client,{tenantId:pointer.formal_tenant_id,projectId:pointer.formal_project_id},pointer.change_id);
    if(!binding||binding.key.tenantId!==key.tenantId||binding.key.projectId!==key.projectId||binding.key.candidateId!==key.candidateId)throw new ScreenplayError('STORAGE_FAILED','original screenplay intention','key');
    return binding;
  }catch(error){let known=false;try{known=error instanceof ScreenplayError;}catch{/* Driver prototype traps cannot supply public diagnostics. */}if(known)throw error;throw new ScreenplayError('STORAGE_FAILED','original screenplay intention','storage');}
}

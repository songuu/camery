import {authorize,parseIdentity} from '@camery/access';
import type {Permission} from '@camery/access';
import {StableId} from '@camery/ir';
import {freeze} from '@camery/methods';
import {snapshotJson} from '@camery/methods/json';
import type {PersistedAdoptOptions} from '@camery/versioning/node';
import type {PostgresProjectIdentityStore} from './identity-map.js';
import {ProjectIdentityError} from './contracts.js';

/** Host composition only. A session must come from authentication; ordinary identity bindings never grant permission. */
export async function resolveProjectAuthority(input:{identities:Pick<PostgresProjectIdentityStore,'resolve'>;subject:unknown;projectId:string;permission:Permission}){
  const subject=parseIdentity(input.subject);const projectId=input.projectId;const permission=input.permission;
  authorize(subject,subject.tenantId,projectId,permission);
  const read=input.identities.resolve.bind(input.identities);
  const raw=await read({tenantId:subject.tenantId,projectId,kind:'user',key:subject.userId});
  let binding;
  try{
    binding=snapshotJson(raw,8192);
    if(binding.scope.tenantId!==subject.tenantId||binding.scope.projectId!==projectId||binding.principal.kind!=='user'
      ||![binding.versionKey.tenantId,binding.versionKey.projectId,binding.principal.id].every(value=>value.length===26&&StableId.safeParse(value).success))throw new Error();
  }catch{throw new ProjectIdentityError('STORAGE_FAILED','resolved host authority');}
  const bound=freeze(binding);
  const check:PersistedAdoptOptions['authorize']=(actor,key,scope)=>{
    if(actor.kind!=='user'||actor.id!==bound.principal.id||key.tenantId!==bound.versionKey.tenantId||key.projectId!==bound.versionKey.projectId
      ||!['project','episode','scene'].includes(scope.kind)||!StableId.safeParse(scope.id).success||scope.id.length!==26
      ||scope.kind==='project'&&scope.id!==key.projectId)return false;
    // The engine checks actual episode/scene membership and object locks; the host binds grants to this mapped project and actor.
    try{authorize(subject,subject.tenantId,projectId,'candidate:review');return true;}catch{return false;}
  };
  return Object.freeze({...bound,authorize:check});
}

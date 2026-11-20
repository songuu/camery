import {z} from 'zod';
import {parseIdentity,authorize} from '@camery/access';
import type {ScreenplayHost} from '@camery/script/screenplay/node';
import {ProjectApplicationError} from './intent-contracts.js';

/** Finalization compiles already reviewed text; this grant never authorizes source review or free-form preparation. */
export function createScreenplayProjectHost(input:unknown,tenantId:string,projectId:string,at:string,allowFinalize:boolean):ScreenplayHost{
  const subject=parseIdentity(input);authorize(subject,tenantId,projectId,'project:read');
  if(!z.iso.datetime({precision:3}).safeParse(at).success)throw new ProjectApplicationError('INVALID_INPUT','screenplay host time');
  const scope=Object.freeze({tenantId,projectId}),actor=Object.freeze({kind:'human' as const,id:subject.userId});
  return Object.freeze({actor,scope,at,authorize:(request:Parameters<ScreenplayHost['authorize']>[0])=>{
    try{
      if(request.scope.tenantId!==scope.tenantId||request.scope.projectId!==scope.projectId)return false;
      if(request.action==='screenplay:read'){authorize(subject,tenantId,projectId,'project:read');return true;}
      if(request.action==='screenplay:finalize'&&allowFinalize===true){authorize(subject,tenantId,projectId,'candidate:review');return true;}
      return false;
    }catch{return false;}
  }});
}

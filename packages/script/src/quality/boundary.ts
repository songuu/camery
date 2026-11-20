import type {z} from 'zod';
import {createIssue} from '@camery/agents';
import {digest} from '@camery/methods';
import {snapshotJson,JsonBoundaryError} from '@camery/methods/json';
import {QualityScopeSchema,QualityFindingDetailSchema,QualityFindingSchema,QualityError} from './contracts.js';
import type {QualityFinding} from './contracts.js';
export function captureQuality<S extends z.ZodType>(schema:S,input:unknown,operation:string,maxBytes:number):z.infer<S>{
  let own:QualityError|undefined;try{const result=schema.safeParse(snapshotJson(input,maxBytes,65536));if(result.success)return result.data;own=new QualityError('INVALID_INPUT',operation,result.error.issues[0]!.path.join('.')||'$');throw own;}
  catch(error){if(own&&error===own)throw own;let limit=false;try{limit=error instanceof JsonBoundaryError&&error.code==='INPUT_LIMIT';}catch{/* Unknown prototypes cannot supply public diagnostics. */}throw new QualityError(limit?'INPUT_LIMIT':'INVALID_INPUT',operation,'$');}
}
export function freezeQuality<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeQuality(child);Object.freeze(value);}return value;}
/** The trusted source digest distinguishes immutable Issues from different revisions; pure JSON still grants no source authority. */
export function createQualityFinding(scopeInput:unknown,detailInput:unknown):QualityFinding{
  const scope=captureQuality(QualityScopeSchema,scopeInput,'issue scope',2048),detail=captureQuality(QualityFindingDetailSchema,detailInput,'quality finding',131072),{code,origin,phase,waivable,evidence,...body}=detail;
  for(const entry of evidence){if(!entry.path.startsWith('/')||/~(?![01])/u.test(entry.path)||(entry.quote===null?(entry.start!==null||entry.end!==null):(entry.start===null||entry.end===null||entry.end<=entry.start||entry.end-entry.start!==entry.quote.length)))throw new QualityError('INVALID_REFERENCE','quality finding evidence','evidence');}
  const id='quality-'+digest({scope,detail}),issue=createIssue({issueId:id,taskId:scope.taskId,scope:{tenantId:scope.tenantId,projectId:scope.projectId},objectId:scope.objectId,...body,evidenceScope:'text'});
  return freezeQuality(captureQuality(QualityFindingSchema,{id,sourceDigest:scope.sourceDigest,code,origin,phase,waivable,issue,evidence},'quality finding result',131072));
}

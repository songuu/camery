import {VersionPersistenceError} from '@camery/versioning/node';
import type {VersionAdoptionGuard} from '@camery/versioning/node';
import {capture,deepFreeze} from '../boundary.js';
import {OutlineError} from '../contracts.js';
import type {OutlineCandidate,ReviewedOutline} from '../generation-contracts.js';
import type {OutlineProgress,OutlineRunKey} from './persistence-contracts.js';
import {captureOutlineProgress} from './state.js';
import {OutlineAdoptionSourceSchema} from './formal-contracts.js';
import type {OutlineAdoptionSource} from './formal-contracts.js';
import type {PostgresOutlineStore} from './store.js';
export type ReviewedOutlineProgress=OutlineProgress&{readonly candidate:OutlineCandidate;readonly review:ReviewedOutline};
function reviewed(key:OutlineRunKey,input:unknown):ReviewedOutlineProgress{
  const progress=captureOutlineProgress(key,input);if(!progress.candidate||progress.review?.status!=='reviewed')throw new OutlineError('INCOMPLETE','formal reviewed source','review');
  return deepFreeze({...progress,candidate:progress.candidate,review:progress.review});
}
/** A source descriptor binds integrity only; authorization and currentness require the actual caller-owned source transaction. */
function descriptor(p:ReviewedOutlineProgress):OutlineAdoptionSource{
  return capture(OutlineAdoptionSourceSchema,{tenantId:p.run.tenantId,projectId:p.run.projectId,runId:p.run.runId,runDigest:p.run.digest,briefDigest:p.run.brief.digest,candidateDigest:p.candidate.digest,reviewDigest:p.review.digest,sourceDigest:p.run.source.digest},'formal source descriptor',4096);
}
export function outlineAdoptionSource(key:OutlineRunKey,input:unknown):OutlineAdoptionSource{return descriptor(reviewed(key,input));}
export function captureOutlineAdoptionProgress(input:unknown,progress:unknown):ReviewedOutlineProgress{
  const source=capture(OutlineAdoptionSourceSchema,input,'formal source',4096),actual=reviewed({tenantId:source.tenantId,projectId:source.projectId,runId:source.runId},progress);
  const expected=descriptor(actual);
  if((Object.keys(source) as (keyof OutlineAdoptionSource)[]).some(key=>source[key]!==expected[key]))throw new OutlineError('CONFLICT','formal source binding','source');return actual;
}
/** The version adopter owns BEGIN/COMMIT and the connection; this guard never creates another transaction or a model call. */
export function createOutlineSourceGuard(store:Pick<PostgresOutlineStore,'readForAdoption'>,input:unknown):VersionAdoptionGuard{
  const source=deepFreeze(capture(OutlineAdoptionSourceSchema,input,'formal adoption source',4096)),read=store.readForAdoption.bind(store);
  return async client=>{try{await read(client,source);}catch(error){let refusal:string|undefined;
    if(error instanceof OutlineError){if(error.code==='CONFLICT')refusal='ADOPTION_SOURCE_CHANGED';if(error.code==='INCOMPLETE')refusal='ADOPTION_SOURCE_UNREVIEWED';if(error.code==='NOT_FOUND')refusal='ADOPTION_SOURCE_MISSING';}
    throw new VersionPersistenceError(refusal??'OUTLINE_SOURCE_UNAVAILABLE','outline source guard',source.projectId);
  }};
}

import {captureScreenplayHost} from '../../screenplay/node/host.js';
import {ScreenplayScopeSchema} from '../../screenplay/node/contracts.js';
import {captureQuality,freezeQuality} from '../boundary.js';
import {QualityError} from '../contracts.js';
export const QUALITY_ACTIONS=['quality:read','quality:run','quality:review','quality:revise','quality:restart','outline:read','screenplay:read'] as const;
export type QualityAction=typeof QUALITY_ACTIONS[number];
export interface QualityHost{readonly actor:{readonly kind:'human';readonly id:string};readonly scope:{readonly tenantId:string;readonly projectId:string};readonly at:string;readonly authorize:(request:{readonly action:QualityAction;readonly scope:{readonly tenantId:string;readonly projectId:string}})=>boolean}
function forbidden():never{throw new QualityError('FORBIDDEN','trusted quality authority','host');}
/** Reuse the established strict identity/callback capture. Its action-specific authorization remains separate. */
export function captureQualityHost(input:unknown):QualityHost{
  try{const captured=captureScreenplayHost(input);return Object.freeze({...captured,authorize:captured.authorize as QualityHost['authorize']});}catch{return forbidden();}
}
export function authorizeQualityHost(input:unknown,action:QualityAction,scopeInput:unknown):QualityHost{
  const host=captureQualityHost(input);try{const scope=captureQuality(ScreenplayScopeSchema,scopeInput,'quality authority scope',1024);if(!QUALITY_ACTIONS.includes(action)||scope.tenantId!==host.scope.tenantId||scope.projectId!==host.scope.projectId)forbidden();const allowed:unknown=host.authorize(freezeQuality({action,scope}));if(allowed!==true){try{void Promise.prototype.then.call(allowed as Promise<unknown>,undefined,()=>{});}catch{/* Observe only an actual rejected Promise; do not execute a thenable. */}forbidden();}return host;}catch{return forbidden();}
}

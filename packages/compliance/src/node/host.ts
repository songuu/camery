import {z} from 'zod';
import {capture,freeze} from '../boundary.js';
import {ComplianceError,Id} from '../contracts.js';
import {ScopeSchema} from './generation.js';
export type ComplianceAction='compliance:read'|'compliance:scan'|'compliance:review';
export interface ComplianceHost{readonly actor:{readonly kind:'human';readonly id:string};readonly scope:{readonly tenantId:string;readonly projectId:string};readonly at:string;readonly authorize:(request:{readonly action:ComplianceAction;readonly scope:{readonly tenantId:string;readonly projectId:string}})=>boolean}
const Identity=z.strictObject({actor:z.strictObject({kind:z.literal('human'),id:Id}),scope:ScopeSchema,at:z.iso.datetime({precision:3})});
function forbidden():never{throw new ComplianceError('FORBIDDEN','trusted precheck authority','host');}
/** Deployment-supplied identity and live grants; no JSON DTO may authenticate itself. */
export function captureHost(input:unknown):ComplianceHost{
  try{if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.getOwnPropertySymbols(input).length)forbidden();const descriptors=Object.getOwnPropertyDescriptors(input),names=['actor','scope','at','authorize'];if(Object.keys(descriptors).length!==names.length)forbidden();const own:Record<string,unknown>={};for(const name of names){const d=descriptors[name];if(!d||!d.enumerable||!('value'in d))forbidden();own[name]=d.value;}const authorize=own['authorize'];delete own['authorize'];if(typeof authorize!=='function')forbidden();const identity=capture(Identity,own,'precheck host identity',2048);if(new Date(identity.at).toISOString()!==identity.at)forbidden();return Object.freeze({...freeze(identity),authorize:authorize as ComplianceHost['authorize']});}catch{return forbidden();}
}
export function authorizeHost(input:unknown,action:ComplianceAction,scopeInput:unknown):ComplianceHost{
  const host=captureHost(input);try{const scope=capture(ScopeSchema,scopeInput,'precheck authority scope',1024);if(scope.tenantId!==host.scope.tenantId||scope.projectId!==host.scope.projectId||!['compliance:read','compliance:scan','compliance:review'].includes(action))forbidden();const allowed:unknown=host.authorize(freeze({action,scope}));if(allowed!==true){try{void Promise.prototype.then.call(allowed as Promise<unknown>,undefined,()=>{});}catch{/* Observe actual rejected Promises without executing arbitrary thenables. */}forbidden();}return host;}catch{return forbidden();}
}

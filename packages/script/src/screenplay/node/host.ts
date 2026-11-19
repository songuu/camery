import {z} from 'zod';
import {Id} from '../../contracts.js';
import {canonicalTime} from '../../reviewed.js';
import {captureScreenplay,freezeScreenplay} from '../boundary.js';
import {ScreenplayError} from '../contracts.js';
import {ScreenplayScopeSchema} from './contracts.js';
import type {ScreenplayHost,ScreenplayAction} from './contracts.js';
const Identity=z.strictObject({actor:z.strictObject({kind:z.literal('human'),id:Id}),scope:ScreenplayScopeSchema,at:z.iso.datetime({precision:3})});
const fields=['actor','scope','at','authorize'];
function forbidden():never{throw new ScreenplayError('FORBIDDEN','trusted human authority','host');}
export function captureScreenplayHost(input:unknown):ScreenplayHost{
  try{
    if(!input||typeof input!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.getOwnPropertySymbols(input).length)forbidden();
    const descriptors=Object.getOwnPropertyDescriptors(input);if(Object.keys(descriptors).length!==fields.length)forbidden();const record:Record<string,unknown>={};
    for(const name of fields){const descriptor=descriptors[name];if(!descriptor||!descriptor.enumerable||!('value'in descriptor))forbidden();record[name]=descriptor.value;}
    const authorize=record['authorize'];delete record['authorize'];if(typeof authorize!=='function')forbidden();
    const identity=captureScreenplay(Identity,record,'human identity',2048);if(!canonicalTime(identity.at))forbidden();
    return Object.freeze({...freezeScreenplay(identity),authorize:authorize as ScreenplayHost['authorize']});
  }catch{return forbidden();}
}
export function authorizeScreenplayHost(input:unknown,action:ScreenplayAction,scopeInput:unknown):ScreenplayHost{
  const host=captureScreenplayHost(input);
  try{
    const scope=captureScreenplay(ScreenplayScopeSchema,scopeInput,'authority scope',1024);
    if(!['screenplay:read','screenplay:prepare','screenplay:review','screenplay:finalize'].includes(action)||scope.tenantId!==host.scope.tenantId||scope.projectId!==host.scope.projectId)forbidden();
    const allowed:unknown=host.authorize(freezeScreenplay({action,scope}));
    if(allowed!==true){try{void Promise.prototype.then.call(allowed as Promise<unknown>,undefined,()=>{});}catch{/* Observe only real rejected Promises, never untrusted thenables. */}forbidden();}
    return host;
  }catch{return forbidden();}
}

import {VersionPersistenceError} from '@camery/versioning/node';
import type {VersionAdoptionGuard} from '@camery/versioning/node';
import {DevelopmentError} from '../contracts.js';
import {copy,freeze,parse} from '../data.js';
import {DevelopmentAdoptionSourceSchema} from './contracts.js';
import type {PostgresDevelopmentStore} from './store.js';
/** Trusted composition only. The adopter supplies its existing transaction; this guard never starts or commits one. */
export function createDevelopmentSourceGuard(store:Pick<PostgresDevelopmentStore,'readForAdoption'>,input:unknown):VersionAdoptionGuard{
  const source=freeze(parse(DevelopmentAdoptionSourceSchema,copy(input),'formal adoption source'));const read=store.readForAdoption.bind(store);
  return async client=>{
    try{await read(client,source);}
    catch(error){
      let refusal:string|undefined;
      if(error instanceof DevelopmentError){if(error.code==='CONFLICT')refusal='ADOPTION_SOURCE_CHANGED';if(error.code==='INCOMPLETE')refusal='ADOPTION_SOURCE_UNREVIEWED';if(error.code==='NOT_FOUND')refusal='ADOPTION_SOURCE_MISSING';}
      // Corrupt evidence and unavailable storage are not a freshness refusal and must not enable historical ACK recovery.
      throw new VersionPersistenceError(refusal??'DEVELOPMENT_SOURCE_UNAVAILABLE','development source guard',source.projectId);
    }
  };
}

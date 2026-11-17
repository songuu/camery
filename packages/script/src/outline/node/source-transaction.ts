import type { Pool,PoolClient } from 'pg';
import { PostgresBibleStore } from '@camery/bible/node';
import { PostgresDevelopmentStore } from '../../node/store.js';
import { capture,deepFreeze } from '../boundary.js';
import { OutlineSourceDescriptorSchema } from '../generation-contracts.js';
import type { OutlineSourceDescriptor,OutlineSourceSnapshot } from '../generation-contracts.js';
import { captureStoredOutlineSource,outlineSourceFailure } from './source.js';

export type OutlineSourceTransaction=(client:PoolClient,descriptor:OutlineSourceDescriptor)=>Promise<OutlineSourceSnapshot>;
/** Caller owns an open READ COMMITTED transaction. Source-domain locks remain held until that caller commits. */
export function createOutlineSourceTransaction(pool:Pool):OutlineSourceTransaction{
  const development=new PostgresDevelopmentStore(pool),bible=new PostgresBibleStore(pool);
  return async(client,input)=>{
    const descriptor=deepFreeze(capture(OutlineSourceDescriptorSchema,input,'transaction source',8192));
    const {kind,...command}=descriptor;
    try{
      const progress=kind==='development'?await development.readForAdoption(client,command):await bible.readForOutline(client,command);
      return captureStoredOutlineSource(descriptor,progress);
    }catch(error){return outlineSourceFailure(error);}
  };
}

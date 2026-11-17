import {z} from 'zod';
import {freeze} from '@camery/methods';
import {snapshotJson} from '@camery/methods/json';
import {projectIntentDigest} from './intent-store.js';
import {ProjectApplicationError} from './intent-contracts.js';

/** A cursor binds a position to a query; every page still requires fresh host authorization. */
export function encodeReadCursor(binding:unknown,position:unknown):string{
  return Buffer.from(JSON.stringify({version:1,binding:projectIntentDigest(binding),position:snapshotJson(position,2048)})).toString('base64url');
}
export function decodeReadCursor<S extends z.ZodType>(binding:unknown,token:string,schema:S):z.infer<S>{
  try{
    if(typeof token!=='string'||token.length===0||token.length>4096)throw new Error();const bytes=Buffer.from(token,'base64url');if(bytes.toString('base64url')!==token)throw new Error();
    const parsed=z.strictObject({version:z.literal(1),binding:z.string().length(64),position:z.unknown()}).parse(snapshotJson(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),3072));
    if(parsed.binding!==projectIntentDigest(binding)||!Object.hasOwn(parsed,'position'))throw new Error();return freeze(schema.parse(parsed.position)) as z.infer<S>;
  }catch{throw new ProjectApplicationError('INVALID_INPUT','read cursor');}
}

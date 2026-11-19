import type {Pool} from 'pg';
import {vi} from 'vitest';
import {EventEmitter} from 'node:events';
export function continuityInstallDatabase(){
  const state={ledger:[] as {version:number;checksum:string}[],prerequisites:true,allowed:true,resultRows:1,fail:[] as string[]};
  const query=vi.fn(async(text:string,_values?:unknown[])=>{
    if(state.fail.some(prefix=>text.startsWith(prefix)))throw new Error('private database credential');
    if(text.includes('AS snapshots_ready'))return {rows:[{snapshots_ready:state.prerequisites,projects_ready:state.prerequisites}]};
    if(text.startsWith('SELECT version,checksum FROM camery_continuity'))return {rows:state.ledger};
    if(text.includes('WITH permitted'))return {rows:Array.from({length:state.resultRows},()=>({allowed:state.allowed}))};
    return {rows:[]};
  });
  const release=vi.fn(),connect=vi.fn(async()=>Object.assign(new EventEmitter(),{query,release})),pool={query,connect} as unknown as Pool;
  return {pool,state,query,connect,release};
}

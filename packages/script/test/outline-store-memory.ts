import { vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOutlineStore } from '../src/outline/node/store.js';
import { OutlineError } from '../src/outline/contracts.js';
import type { OutlineSourceTransaction } from '../src/outline/node/source-transaction.js';
import type { OutlineSourceSnapshot } from '../src/outline/generation-contracts.js';

type Row=Record<string,unknown>;
type Table='briefs'|'runs'|'candidates'|'reviews';
/** SQL protocol fixture only; real concurrency/roles/rollback are proved by PostgreSQL tests. */
export function outlineMemory(source:OutlineSourceSnapshot){
  const data={briefs:[] as Row[],runs:[] as Row[],candidates:[] as Row[],reviews:[] as Row[]};let saved:typeof data|undefined;
  const state={current:true,fail:[] as string[],failOnce:[] as string[],connectFailure:false,syncConnectFailure:false,releaseFailure:false,emptyInsert:false,
    connectGate:null as Promise<void>|null,queryGate:null as {prefix:string;wait:Promise<void>}|null,selectOverrides:{} as Partial<Record<Table,Row[]>>,released:[] as boolean[]};
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(state.queryGate&&sql.startsWith(state.queryGate.prefix))await state.queryGate.wait;
    const once=state.failOnce.findIndex(prefix=>sql.startsWith(prefix));if(once>=0){state.failOnce.splice(once,1);throw new Error('private driver secret');}
    if(state.fail.some(prefix=>sql.startsWith(prefix)))throw new Error('private driver secret');
    if(sql.startsWith('BEGIN'))saved=structuredClone(data);if(sql==='ROLLBACK'&&saved)Object.assign(data,saved);if(sql==='COMMIT')saved=undefined;
    const target=(['briefs','runs','candidates','reviews'] as const).find(table=>sql.includes(`camery_outline.${table}`));
    if(sql.startsWith('SELECT')&&target){
      let rows=data[target].filter(row=>row.tenant_id===values[0]&&row.project_id===values[1]&&(target==='briefs'?row.brief_id===values[2]:row.run_id===values[2]));
      if(target==='briefs'){if(values[3]!==undefined)rows=rows.filter(row=>Number(row.revision)===values[3]);else rows=rows.toSorted((a,b)=>Number(b.revision)-Number(a.revision)).slice(0,1);}
      return {rows:structuredClone(state.selectOverrides[target]??rows)};
    }
    if(sql.startsWith('INSERT')&&target){
      let row:Row;
      if(target==='briefs')row={tenant_id:values[0],project_id:values[1],brief_id:values[2],revision:values[3],actor_id:values[4],digest:values[5],request_digest:values[6],record:JSON.parse(values[7] as string),created_at:new Date('2026-11-17T11:05:00.000Z')};
      else if(target==='runs')row={tenant_id:values[0],project_id:values[1],run_id:values[2],brief_id:values[3],brief_revision:values[4],brief_digest:values[5],source_digest:values[6],digest:values[7],request_digest:values[8],record:JSON.parse(values[9] as string),created_at:new Date('2026-11-17T11:05:00.000Z')};
      else if(target==='candidates')row={tenant_id:values[0],project_id:values[1],run_id:values[2],digest:values[3],record:JSON.parse(values[4] as string)};
      else row={tenant_id:values[0],project_id:values[1],run_id:values[2],status:values[3],request_digest:values[4],digest:values[5],record:JSON.parse(values[6] as string)};
      data[target].push(row);return {rows:state.emptyInsert?[]:structuredClone([row])};
    }
    return {rows:[]};
  });
  const release=vi.fn((destroy=false)=>{state.released.push(destroy);if(state.releaseFailure)throw new Error('private release');});
  const connect=vi.fn(()=>{if(state.syncConnectFailure)throw new Error('private synchronous connection');return (async()=>{if(state.connectGate)await state.connectGate;if(state.connectFailure)throw new Error('private connection');return {query,release};})();});const pool={query,connect} as unknown as Pool;
  const sourceReader=vi.fn<OutlineSourceTransaction>(async(_client,descriptor)=>{if(!state.current)throw new OutlineError('CONFLICT','fixture current source','source');if(descriptor.runDigest!==source.descriptor.runDigest)throw new OutlineError('CONFLICT','fixture source identity','source');return source;});
  return {data,state,query,release,connect,pool,sourceReader,store:new PostgresOutlineStore(pool,sourceReader)};
}

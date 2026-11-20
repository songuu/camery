import {EventEmitter} from 'node:events';
import {vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';

/** Driver lifecycle protocol only; no real connection, PostgreSQL role or transaction guarantee is established by this harness. */
export function qualityDbFixture(){const client=Object.assign(new EventEmitter(),{query:vi.fn(async(_sql:string)=>({rows:[]})),release:vi.fn((_destroy?:boolean)=>{})}),pool={connect:vi.fn(async()=>client)} as unknown as Pool,action=vi.fn(async(_client:PoolClient)=>({saved:'immutable'}));return {client,pool,action};}
type Rows=Record<string,unknown>[];
type Ledger={version:unknown;checksum:unknown};
interface Snapshot{schema:boolean;ledger:boolean;records:Ledger[]}
/** A coarse in-memory write journal models commit/rollback outcomes for the installer protocol, not SQL/FK enforcement. */
export function qualityMigrationFixture(sql:string){
  const state={committed:{schema:false,ledger:false,records:[]} as Snapshot,ready:[{ready:true}] as Rows,exists:null as Rows|null,prior:null as Rows|null,applies:0,commits:0,rollbacks:0};
  function client(){let pending:Snapshot|null=null;return Object.assign(new EventEmitter(),{query:vi.fn(async(statement:string,params:unknown[]=[]):Promise<{rows:Rows}>=>{
    if(statement==='BEGIN')pending=structuredClone(state.committed);
    else if(statement==='COMMIT'){if(pending)state.committed=pending;pending=null;state.commits++;}
    else if(statement==='ROLLBACK'){pending=null;state.rollbacks++;}
    else if(statement.includes('AS ready'))return {rows:state.ready};
    else if(statement.includes('AS installed'))return {rows:state.exists??[{installed:(pending??state.committed).ledger}]};
    else if(statement==='SELECT version,checksum FROM camery_quality.migrations ORDER BY version')return {rows:state.prior??(pending??state.committed).records};
    else if(statement===sql){if(!pending)throw new Error('DDL outside owned protocol transaction');pending.schema=true;state.applies++;}
    else if(statement.startsWith('CREATE TABLE camery_quality.migrations')){if(!pending)throw new Error('Ledger outside transaction');pending.ledger=true;}
    else if(statement.startsWith('INSERT INTO camery_quality.migrations')){if(!pending)throw new Error('Checksum outside transaction');pending.records.push({version:params[0],checksum:params[1]});}
    return {rows:[]};
  }),release:vi.fn((destroy?:boolean)=>{if(destroy)pending=null;})});}
  const first=client(),clients=[first];let next=0;const pool={connect:vi.fn(async()=>{const found=clients[next]??client();if(!clients[next])clients.push(found);next++;return found;})} as unknown as Pool;
  return {state,client:first,clients,pool};
}

import { vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresDevelopmentStore } from '../src/node/store.js';
type Row=Record<string,unknown>;
interface State {briefs:Row[];runs:Row[];candidates:Row[];reviews:Row[];run_origins:Row[]}
/** Unit-only driver fixture for error/capture paths; actual SQL, constraints and concurrency are tested against PostgreSQL. */
export function memoryDatabase(){
  const data:State={briefs:[],runs:[],candidates:[],reviews:[],run_origins:[]};let backup:State|null=null;
  const options:{fail:string[];emptyBrief:boolean;hideRun:boolean;commitAckLost:boolean;releaseFailure:boolean;wait?:{prefix:string;gate:Promise<void>}}={fail:[],emptyBrief:false,hideRun:false,commitAckLost:false,releaseFailure:false};
  const matches=(row:Row,values:unknown[])=>row['tenant_id']===values[0]&&row['project_id']===values[1]&&row['run_id']===values[2];
  const release=vi.fn(()=>{if(options.releaseFailure)throw new Error('private release');});
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    if(options.wait&&sql.startsWith(options.wait.prefix))await options.wait.gate;
    if(options.fail.some(prefix=>sql.startsWith(prefix)))throw new Error('private database URL');
    if(sql==='BEGIN'){backup=structuredClone(data);return {rows:[]};}
    if(sql==='COMMIT'){backup=null;if(options.commitAckLost){options.commitAckLost=false;throw new Error('private acknowledgement');}return {rows:[]};}
    if(sql==='ROLLBACK'){if(backup)Object.assign(data,backup);backup=null;return {rows:[]};}
    if(sql.includes('FROM camery_script.briefs')){
      const rows=data.briefs.filter(row=>row['tenant_id']===values[0]&&row['project_id']===values[1]&&row['brief_id']===values[2]&&(values.length<4||Number(row['revision'])===values[3]));
      return {rows:values.length<4?[...rows].sort((a,b)=>Number(b['revision'])-Number(a['revision'])).slice(0,1):rows};
    }
    for(const table of ['runs','candidates','reviews','run_origins'] as const)if(sql.includes(`FROM camery_script.${table}`))return {rows:options.hideRun&&table==='runs'?[]:data[table].filter(row=>matches(row,values))};
    if(sql.startsWith('INSERT INTO camery_script.briefs')){
      const row={tenant_id:values[0],project_id:values[1],brief_id:values[2],revision:String(values[3]),actor_id:values[4],digest:values[5],request_digest:values[6],record:JSON.parse(values[7] as string),created_at:new Date('2026-11-16T12:00:00.000Z')};
      data.briefs.push(row);return {rows:options.emptyBrief?[]:[row]};
    }
    if(sql.startsWith('INSERT INTO camery_script.runs')){const row={tenant_id:values[0],project_id:values[1],run_id:values[2],brief_id:values[3],brief_revision:String(values[4]),brief_digest:values[5],methods:JSON.parse(values[6] as string),execution:JSON.parse(values[7] as string),digest:values[8],request_digest:values[9],created_at:new Date('2026-11-16T12:00:00.000Z')};data.runs.push(row);return {rows:sql.includes('RETURNING')?[row]:[]};}
    if(sql.startsWith('INSERT INTO camery_script.run_origins'))data.run_origins.push({tenant_id:values[0],project_id:values[1],run_id:values[2],source_run_id:values[3],source_run_digest:values[4],stage:values[5],actor_id:values[6],foundation_run_id:values[7],foundation_stage:values[8],foundation_review_status:values[9],foundation_review_digest:values[10],record:JSON.parse(values[11] as string),created_at:values[12]});
    if(sql.startsWith('INSERT INTO camery_script.candidates'))data.candidates.push({tenant_id:values[0],project_id:values[1],run_id:values[2],stage:values[3],upstream_digest:values[4],digest:values[5],record:JSON.parse(values[6] as string)});
    if(sql.startsWith('INSERT INTO camery_script.reviews'))data.reviews.push({tenant_id:values[0],project_id:values[1],run_id:values[2],stage:values[3],status:values[4],request_digest:values[5],digest:values[6],record:JSON.parse(values[7] as string)});
    return {rows:[]};
  });
  const connect=vi.fn(async()=>({query,release}));const pool={connect,query} as unknown as Pool;
  return {store:new PostgresDevelopmentStore(pool),pool,data,options,query,connect,release};
}

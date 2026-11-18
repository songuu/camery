import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {vi} from 'vitest';

type Row=Record<string,unknown>;
/** SQL protocol fixture only; real transaction serialization and database permissions are tested separately. */
export function outlineIntentMemory(){
  const rows=new Map<string,Row>(),statements:string[]=[];let snapshot=new Map<string,Row>();
  const state:{headRows:Row[];connectGate:Promise<void>|null;failPrefix?:string;error?:unknown;disconnectPrefix?:string;emptyInsert?:string;releaseFailure?:boolean;loseCommitAck?:boolean}={headRows:[],connectGate:null};
  const events=new EventEmitter();
  const query=vi.fn(async(sql:string,values:unknown[]=[])=>{
    statements.push(sql);if(state.failPrefix&&sql.startsWith(state.failPrefix))throw state.error??new Error('private outline intent driver');
    if(sql.startsWith('BEGIN'))snapshot=structuredClone(rows);
    if(sql==='COMMIT'&&state.loseCommitAck){snapshot=structuredClone(rows);state.loseCommitAck=false;throw new Error('private committed acknowledgement loss');}
    if(sql==='ROLLBACK'){rows.clear();for(const [key,value] of snapshot)rows.set(key,value);}
    if(state.disconnectPrefix&&sql.startsWith(state.disconnectPrefix))events.emit('error',new Error('private outline intent disconnect'));
    if(sql.startsWith('SELECT')&&sql.includes('FROM camery_versioning.projects'))return {rows:structuredClone(state.headRows)};
    if(sql.startsWith('INSERT INTO camery_projects.outline_candidate_intents')){
      const [tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,run_id,run_digest,review_digest,record,digest,business_digest]=values;
      const row={tenant_id,project_id,application_id,actor_kind,actor_key,ir_actor_id,ir_tenant_id,ir_project_id,change_id,run_id,run_digest,review_digest,record:JSON.parse(record as string) as unknown,digest,business_digest,created_at:new Date('2026-11-18T05:00:00.000Z')};
      rows.set('candidate',row);return {rows:state.emptyInsert==='candidate'?[]:[structuredClone(row)]};
    }
    if(sql.startsWith('INSERT INTO camery_projects.outline_decision_intents')){
      const [tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,change_id,record,digest,business_digest]=values;
      const row={tenant_id,project_id,actor_kind,actor_key,ir_actor_id,request_id,change_id,record:JSON.parse(record as string) as unknown,digest,business_digest,created_at:new Date('2026-11-18T05:00:00.000Z')};
      rows.set('decision',row);return {rows:state.emptyInsert==='decision'?[]:[structuredClone(row)]};
    }
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.outline_candidate_intents')){
      const row=rows.get('candidate');const matches=row&&row.tenant_id===values[0]&&row.project_id===values[1]&&(sql.includes('change_id=$3')?row.change_id===values[2]:row.application_id===values[2]);return {rows:matches?[structuredClone(row)]:[]};
    }
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.outline_decision_intents')){
      const row=rows.get('decision');return {rows:row&&row.tenant_id===values[0]&&row.project_id===values[1]&&row.actor_kind===values[2]&&row.actor_key===values[3]&&row.request_id===values[4]?[structuredClone(row)]:[]};
    }
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.outline_candidate_receipts')){
      const row=rows.get('preparation');return {rows:row&&row.tenant_id===values[0]&&row.project_id===values[1]&&row.application_id===values[2]?[structuredClone(row)]:[]};
    }
    if(sql.startsWith('SELECT')&&sql.includes('camery_projects.outline_decision_receipts')){
      const row=rows.get('receipt');return {rows:row&&row.tenant_id===values[0]&&row.project_id===values[1]&&row.actor_kind===values[2]&&row.actor_key===values[3]&&row.request_id===values[4]?[structuredClone(row)]:[]};
    }
    if(sql.startsWith('INSERT INTO camery_projects.outline_candidate_receipts')||sql.startsWith('INSERT INTO camery_projects.outline_decision_receipts')){
      const decision=sql.includes('outline_decision_receipts'),key=decision?'receipt':'preparation';if(rows.has(key))return {rows:[]};
      const row=decision?{tenant_id:values[0],project_id:values[1],actor_kind:values[2],actor_key:values[3],request_id:values[4],intent_digest:values[5],record:JSON.parse(values[6] as string) as unknown,digest:values[7]}:{tenant_id:values[0],project_id:values[1],application_id:values[2],intent_digest:values[3],record:JSON.parse(values[4] as string) as unknown,digest:values[5]};
      if(state.emptyInsert!==key)rows.set(key,row);return {rows:[]};
    }
    return {rows:[]};
  });
  const release=vi.fn((_destroy?:boolean)=>{if(state.releaseFailure)throw new Error('private outline intent release');});
  const client=Object.assign(events,{query,release}),connect=vi.fn(async()=>{if(state.connectGate)await state.connectGate;return client;}),poolQuery=vi.fn(async(sql:string,values?:unknown[])=>query(sql,values));
  const pool={query:poolQuery,connect} as unknown as Pool;
  return {rows,statements,state,client,query,release,connect,poolQuery,pool};
}

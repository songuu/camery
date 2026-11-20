import {EventEmitter} from 'node:events';
import {vi} from 'vitest';
import type {Pool,PoolClient} from 'pg';
import {createIssue,createQuestion,validateTaskTreeDefinition} from '@camery/agents';
import type {LogicalTaskKey,StoredTask,TaskTreeDefinition} from '@camery/agents';
import {PostgresCollaborationStore} from '@camery/agents/node';
import type {CollaborationTransaction,StoredQuestion} from '@camery/agents/node';
import {digest} from '@camery/methods';

export type QualityMemoryRow=Record<string,unknown>;
export type QualityMemoryTable='runs'|'cycles'|'batches'|'stages'|'controls'|'waivers'|'outbox';
const tables=['runs','cycles','batches','stages','controls','waivers','outbox'] as const;
const parsedColumns=new Set(['record','source','preparation']);
function sqlOrderValue(value:unknown):string|number|null{if(value===null||typeof value==='string'||typeof value==='number')return value;throw new Error('Unsupported SQL protocol ordering value');}
/** Explicit SQL/result protocol only: no PostgreSQL locks, roles, FK or isolation claims. Transactions only snapshot these fixture rows. */
export function qualityStoreMemory(sourceQuery:(sql:string,values?:unknown[])=>Promise<{rows:QualityMemoryRow[]}>){
  const data:Record<QualityMemoryTable,QualityMemoryRow[]>={runs:[],cycles:[],batches:[],stages:[],controls:[],waivers:[],outbox:[]};
  const state={fail:[] as string[],failOnce:[] as string[],connectFailure:false,releaseFailure:false,gate:null as {prefix:string;wait:Promise<void>}|null,select:null as ((sql:string,values:unknown[],rows:QualityMemoryRow[])=>QualityMemoryRow[])|null};let saved:typeof data|undefined;
  const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:QualityMemoryRow[];rowCount:number}>=>{
    if(state.gate&&sql.startsWith(state.gate.prefix))await state.gate.wait;
    const failed=state.failOnce.findIndex(prefix=>sql.startsWith(prefix));if(failed>=0){state.failOnce.splice(failed,1);throw new Error('private one-shot SQL failure');}if(state.fail.some(prefix=>sql.startsWith(prefix)))throw new Error('private SQL failure');
    if(sql.startsWith('BEGIN')){saved=structuredClone(data);return {rows:[],rowCount:0};}if(sql==='COMMIT'){saved=undefined;return {rows:[],rowCount:0};}if(sql==='ROLLBACK'){if(saved)Object.assign(data,saved);saved=undefined;return {rows:[],rowCount:0};}if(sql==='SET LOCAL search_path = pg_catalog'||sql.startsWith('SELECT pg_catalog.pg_advisory_xact_lock')||sql.startsWith('SELECT pg_advisory_xact_lock'))return {rows:[],rowCount:0};
    if(sql.includes('camery_outline.')||sql==='SHOW transaction_isolation'){const result=await sourceQuery(sql,values);return {...result,rowCount:result.rows.length};}
    const scoped=(rows:QualityMemoryRow[])=>rows.filter(row=>row['tenant_id']===values[0]&&row['project_id']===values[1]&&row['run_id']===values[2]);
    if(sql.startsWith('SELECT r.tenant_id,r.project_id,r.run_id,r.digest,')){const rows=scoped(data.runs).map(run=>{const cycles=scoped(data.cycles),controls=scoped(data.controls).toSorted((a,b)=>Number(a['sequence'])-Number(b['sequence']));return {tenant_id:run['tenant_id'],project_id:run['project_id'],run_id:run['run_id'],digest:run['digest'],cycle_count:cycles.length,control_count:controls.length,control_max:Math.max(0,...controls.map(row=>Number(row['sequence']))),last_control_digest:controls.at(-1)?.['digest']??null};}),captured=structuredClone(rows),actual=state.select?.(sql,values,captured)??captured;return {rows:actual,rowCount:actual.length};}
    const insert=/^INSERT INTO camery_quality\.([a-z_]+)\(([^)]+)\)/.exec(sql);
    if(insert){const table=insert[1] as QualityMemoryTable;if(!tables.includes(table))throw new Error('Unsupported quality protocol table');const row:QualityMemoryRow={};insert[2]!.split(',').forEach((column,index)=>{row[column]=parsedColumns.has(column)?JSON.parse(values[index] as string):values[index];});if(table==='runs')row['initial_cycle']=1;if(table==='outbox'){row['delivered']=false;row['acknowledged_digest']=null;}data[table].push(row);return {rows:[],rowCount:1};}
    if(sql.startsWith('UPDATE camery_quality.outbox SET delivered=true')){const rows=scoped(data.outbox).filter(row=>row['outbox_id']===values[3]&&row['delivered']===false);for(const row of rows){row['delivered']=true;row['acknowledged_digest']=values[4];}return {rows:[],rowCount:rows.length};}
    const select=/FROM camery_quality\.([a-z_]+)/.exec(sql);
    if(sql.startsWith('SELECT')&&select){const table=select[1] as QualityMemoryTable;if(!tables.includes(table))throw new Error('Unsupported quality protocol table');let rows=scoped(data[table]);
      for(const match of sql.matchAll(/\b([a-z_]+)(?: COLLATE "C")?\s*(IS NOT DISTINCT FROM|=|>)\s*\$(\d+)/g)){const [,column,operator,parameter]=match,wanted=values[Number(parameter)-1];rows=rows.filter(row=>operator==='>'?(typeof wanted==='number'?Number(row[column!])>wanted:String(row[column!])>String(wanted)):row[column!]===wanted);}
      if(sql.includes('AND cycle=1'))rows=rows.filter(row=>row['cycle']===1);if(sql.includes('AND NOT delivered'))rows=rows.filter(row=>row['delivered']===false);
      if(sql.includes('GROUP BY target_kind,phase,batch_index')){const groups=new Map<string,QualityMemoryRow>();for(const row of rows){const group={target_kind:row['target_kind'],phase:row['phase'],batch_index:row['batch_index']};groups.set(JSON.stringify(group),group);}rows=[...groups.values()];}
      const ordering=/ORDER BY (.+?)(?: LIMIT |$)/.exec(sql)?.[1];if(ordering){const orders=ordering.split(',').map(part=>({column:/^([a-z_]+)/.exec(part.trim())![1]!,descending:part.includes(' DESC')}));rows=rows.toSorted((a,b)=>{for(const order of orders){const left=sqlOrderValue(a[order.column]),right=sqlOrderValue(b[order.column]),result=left===right?0:left===null?1:right===null?-1:typeof left==='number'&&typeof right==='number'?left-right:String(left)<String(right)?-1:1;if(result)return order.descending?-result:result;}return 0;});}
      const limit=/LIMIT (\d+|\$\d+)/.exec(sql)?.[1];if(limit)rows=rows.slice(0,limit.startsWith('$')?Number(values[Number(limit.slice(1))-1]):Number(limit));
      // Overrides intentionally run after the fixture snapshot so opaque/accessor rows reach the production boundary unchanged.
      const captured=structuredClone(rows),actual=state.select?.(sql,values,captured)??captured;return {rows:actual,rowCount:actual.length};
    }
    throw new Error('Unsupported quality SQL protocol: '+sql);
  });
  const release=vi.fn((_destroy=false)=>{if(state.releaseFailure)throw new Error('private release failure');}),client=Object.assign(new EventEmitter(),{query,release}),connect=vi.fn(async()=>{if(state.connectFailure)throw new Error('private connect failure');return client;}),pool={connect} as unknown as Pool;
  return {data,state,query,client,connect,pool,release};
}

type SharedProtocol=ReturnType<typeof sharedState>;
const sharedByPool=new WeakMap<object,SharedProtocol>();
const logicalKey=(key:LogicalTaskKey)=>JSON.stringify([key.tenantId,key.projectId,key.taskId]);
function sharedState(){return {tasks:new Map<string,StoredTask>(),trees:new Map<string,TaskTreeDefinition>(),issues:new Map<string,QualityMemoryRow>(),questions:new Map<string,StoredQuestion>(),fail:[] as string[],calls:[] as string[]};}
function sharedFor(instance:PostgresCollaborationStore){const value=sharedByPool.get(Object.getOwnPropertyDescriptor(instance,'pool')!.value as object);if(!value)throw new Error('Unregistered blackboard protocol fixture');return value;}
function sharedCall(state:SharedProtocol,operation:string){state.calls.push(operation);if(state.fail.includes(operation))throw new Error('private shared '+operation+' failure');}
/** Mock only the shared blackboard interfaces. Its actual SQL/FK/transactions are proved separately by PG integration. */
export function qualitySharedProtocol(pool:Pool){
  const state=sharedState();sharedByPool.set(pool,state);
  vi.spyOn(PostgresCollaborationStore.prototype,'createTree').mockImplementation(async function(this:PostgresCollaborationStore,input){const s=sharedFor(this);sharedCall(s,'createTree');const definition=validateTaskTreeDefinition(input),treeKey=JSON.stringify([definition.tenantId,definition.projectId,definition.treeId]),prior=s.trees.get(treeKey);if(prior&&digest(prior)!==digest(definition))throw new Error('Shared tree conflict');s.trees.set(treeKey,structuredClone(definition));for(const task of definition.tasks){const key=logicalKey({...task.scope,taskId:task.taskId});if(!s.tasks.has(key))s.tasks.set(key,{task:structuredClone(task),treeId:definition.treeId,revision:0,durableTaskId:null});}return {definition,tasks:definition.tasks.map(task=>structuredClone(s.tasks.get(logicalKey({...task.scope,taskId:task.taskId}))!))};});
  vi.spyOn(PostgresCollaborationStore.prototype,'loadTask').mockImplementation(async function(this:PostgresCollaborationStore,key){const s=sharedFor(this);sharedCall(s,'loadTask');const task=s.tasks.get(logicalKey(key));if(!task)throw new Error('Missing shared task');return structuredClone(task);});
  vi.spyOn(PostgresCollaborationStore.prototype,'withTask').mockImplementation(async function<T>(this:PostgresCollaborationStore,key:LogicalTaskKey,operation:(context:CollaborationTransaction)=>Promise<T>):Promise<T>{const s=sharedFor(this);sharedCall(s,'withTask');const task=s.tasks.get(logicalKey(key));if(!task)throw new Error('Missing shared task');const client={query:async(sql:string,values:unknown[])=>{sharedCall(s,'query');if(!sql.startsWith('SELECT issue_id,record,record_digest FROM camery_agents.agent_issues'))throw new Error('Unsupported shared issue protocol SQL');const row=s.issues.get(JSON.stringify(values));return {rows:row?[structuredClone(row)]:[]};}} as unknown as PoolClient;return operation({client,task:task.task,revision:task.revision,async putIssue(input){sharedCall(s,'putIssue');const issue=createIssue(input),id=JSON.stringify([key.tenantId,key.projectId,key.taskId,issue.issueId]),row={issue_id:issue.issueId,record:issue,record_digest:digest(issue)},prior=s.issues.get(id);if(prior&&digest(prior)!==digest(row))throw new Error('Shared issue conflict');s.issues.set(id,structuredClone(row));},async openQuestion(){throw new Error('Unexpected nested question protocol');},async event(){throw new Error('Unexpected shared event protocol');}});});
  vi.spyOn(PostgresCollaborationStore.prototype,'openQuestion').mockImplementation(async function(this:PostgresCollaborationStore,key,input){const s=sharedFor(this);sharedCall(s,'openQuestion');const question=createQuestion(input),id=logicalKey(key)+'/'+question.questionId,stored:StoredQuestion={question,gateKey:null,durableTaskId:null,gateInputDigest:null,delivery:'none'},prior=s.questions.get(id);if(prior&&prior.question.questionDigest!==question.questionDigest)throw new Error('Shared question conflict');s.questions.set(id,structuredClone(stored));return structuredClone(prior??stored);});
  vi.spyOn(PostgresCollaborationStore.prototype,'getQuestion').mockImplementation(async function(this:PostgresCollaborationStore,key,id){const s=sharedFor(this);sharedCall(s,'getQuestion');const question=s.questions.get(logicalKey(key)+'/'+id);if(!question)throw new Error('Missing shared question');return structuredClone(question);});
  return state;
}

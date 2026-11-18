import {EventEmitter} from 'node:events';
import type {Pool} from 'pg';
import {vi} from 'vitest';
import type {OutlineProgress} from '../src/outline/node/persistence-contracts.js';

export interface OutlineIdentityRow{
  tenant_id:string;project_id:string;kind:string;owner_key:string;owner_run_id:string|null;outline_owner_run_id:string|null;
  local_key:string;ir_tenant_id:string;ir_project_id:string;stable_id:string;
}
export interface OutlineIdentityPreparationRow{tenant_id:string;project_id:string;run_id:string;run_digest:string;review_digest:string;episode_count:number;ir_tenant_id:string;ir_project_id:string;registry_digest:string}
/** SQL protocol fixture only. PostgreSQL tests independently prove real locks, FK/UNIQUE and commit recovery. */
export function outlineIdentityMemory(){
  const rows:OutlineIdentityRow[]=[],proofs:OutlineIdentityPreparationRow[]=[],developmentBriefs:Record<string,unknown>[]=[],events:string[]=[];let saved:OutlineIdentityRow[]=[],savedProofs:OutlineIdentityPreparationRow[]=[];
  const progressByRunId=new Map<string,OutlineProgress>();
  const options:{fail?:string;error?:unknown;release?:boolean;disconnect?:boolean;emptyInsert?:boolean;corrupt?:(row:OutlineIdentityRow)=>OutlineIdentityRow;selected?:(sql:string,rows:OutlineIdentityRow[])=>OutlineIdentityRow[];corruptProof?:(row:OutlineIdentityPreparationRow)=>OutlineIdentityPreparationRow;lookupProgress?:()=>Promise<OutlineProgress|undefined>}={};
  const emitter=new EventEmitter();
  const query=vi.fn(async(sql:string,values:unknown[]=[]):Promise<{rows:unknown[]}>=>{
    events.push(sql);if(options.fail&&sql.startsWith(options.fail))throw options.error??new Error('private identity driver');
    if(sql.startsWith('BEGIN')){saved=structuredClone(rows);savedProofs=structuredClone(proofs);}
    if(sql==='ROLLBACK'){rows.splice(0,rows.length,...saved);proofs.splice(0,proofs.length,...savedProofs);}
    if(sql.includes(' AS installed'))return {rows:[{installed:true}]};
    if(sql.startsWith('SELECT p.run_id')){
      const latest=await options.lookupProgress?.();if(latest&&!progressByRunId.has(latest.run.runId))progressByRunId.set(latest.run.runId,structuredClone(latest));
      const cursor=typeof values[2]==='string'?values[2]:'';
      type Owner={runId:string;tenantId:string;projectId:string};const owners=new Map<string,Owner>();
      const add=(runId:string,tenantId:string,projectId:string)=>{owners.set(JSON.stringify([runId,tenantId,projectId]),{runId,tenantId,projectId});};
      for(const raw of proofs.filter(row=>row.tenant_id===values[0]&&row.project_id===values[1])){const proof=options.corruptProof?options.corruptProof(structuredClone(raw)):raw;add(proof.run_id,proof.ir_tenant_id,proof.ir_project_id);}
      if(/\bUNION\b/i.test(sql))for(const row of rows)if(row.tenant_id===values[0]&&row.project_id===values[1]&&['outline_character','outline_beat','outline_asset','outline_plot_unit','outline_decision'].includes(row.kind)&&row.outline_owner_run_id!==null)add(row.outline_owner_run_id,row.ir_tenant_id,row.ir_project_id);
      const selected=[...owners.values()].filter(row=>row.runId>cursor).toSorted((left,right)=>left.runId<right.runId?-1:left.runId>right.runId?1:0).slice(0,64);
      return {rows:selected.map(owner=>{const raw=proofs.find(row=>row.tenant_id===values[0]&&row.project_id===values[1]&&row.run_id===owner.runId),proof=raw&&options.corruptProof?options.corruptProof(structuredClone(raw)):raw,progress=progressByRunId.get(owner.runId),brief=progress?.run.brief;return {
        owner_run_id:owner.runId,ir_tenant_id:owner.tenantId,ir_project_id:owner.projectId,brief_id:brief?.briefId??null,brief_revision:brief?.revision??null,brief_digest:brief?.digest??null,
        tenant_id:brief?.tenantId??null,project_id:brief?.projectId??null,stored_brief_id:brief?.briefId??null,stored_revision:brief?.revision??null,digest:brief?.digest??null,record:brief??null,
        proof_run_digest:proof?.run_digest??null,run_digest:progress?.run.digest??null,review_digest:proof?.review_digest??null,stored_review_digest:progress?.review?.digest??null,episode_count:proof?.episode_count??null,
      };})};
    }
    if(/^SELECT (?:DISTINCT )?i\.owner_run_id/.test(sql))return {rows:structuredClone(developmentBriefs)};
    if(sql.startsWith('SELECT')&&sql.includes('camery_outline.identity_preparations'))return {rows:proofs.filter(row=>row.tenant_id===values[0]&&row.project_id===values[1]&&row.run_id===values[2]).map(row=>options.corruptProof?options.corruptProof(structuredClone(row)):structuredClone(row))};
    if(sql.startsWith('INSERT INTO camery_outline.identity_preparations')){
      const latest=await options.lookupProgress?.();if(latest&&!progressByRunId.has(latest.run.runId))progressByRunId.set(latest.run.runId,structuredClone(latest));
      const [tenant_id,project_id,run_id,run_digest,review_digest,episode_count,ir_tenant_id,ir_project_id,registry_digest]=values as [string,string,string,string,string,number,string,string,string];
      if(proofs.some(row=>row.tenant_id===tenant_id&&row.project_id===project_id&&row.run_id===run_id))throw Object.assign(new Error('private preparation unique'),{code:'23505'});
      const proof={tenant_id,project_id,run_id,run_digest,review_digest,episode_count,ir_tenant_id,ir_project_id,registry_digest};proofs.push(proof);return {rows:[options.corruptProof?options.corruptProof(structuredClone(proof)):structuredClone(proof)]};
    }
    if(sql.startsWith('SELECT')&&sql.includes('camery_script.ir_identities')){
      let selected=rows.filter(row=>row.tenant_id===values[0]&&row.project_id===values[1]);
      if(sql.includes('kind=$3'))selected=selected.filter(row=>row.kind===values[2]&&row.owner_key===values[3]&&row.local_key===values[4]);
      else if(sql.includes('kind=ANY($3::text[])')){const kinds=values[2] as string[];selected=selected.filter(row=>kinds.includes(row.kind));if(sql.includes('owner_key=$4'))selected=selected.filter(row=>row.owner_key===values[3]);}
      if(sql.includes('ORDER BY kind'))selected=selected.toSorted((left,right)=>left.kind<right.kind?-1:left.kind>right.kind?1:left.local_key<right.local_key?-1:left.local_key>right.local_key?1:0);
      if(sql.includes('LIMIT 1'))selected=selected.slice(0,1);
      selected=structuredClone(selected).map(row=>options.corrupt?options.corrupt(row):row);
      return {rows:options.selected?options.selected(sql,selected):selected};
    }
    if(sql.startsWith('INSERT INTO camery_script.ir_identities')){
      const [tenant_id,project_id,kind,owner_key,owner_run_id,outline_owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id]=values as [string,string,string,string,string|null,string|null,string,string,string,string];
      if(rows.some(row=>row.stable_id===stable_id||row.tenant_id===tenant_id&&row.project_id===project_id&&row.kind===kind&&row.owner_key===owner_key&&row.local_key===local_key))throw Object.assign(new Error('private identity unique'),{code:'23505'});
      const row={tenant_id,project_id,kind,owner_key,owner_run_id,outline_owner_run_id,local_key,ir_tenant_id,ir_project_id,stable_id};rows.push(row);
      if(options.disconnect)emitter.emit('error',new Error('private identity disconnect'));
      return {rows:options.emptyInsert?[]:[options.corrupt?options.corrupt(structuredClone(row)):structuredClone(row)]};
    }
    return {rows:[]};
  });
  const release=vi.fn((_destroy?:boolean)=>{if(options.release)throw new Error('private identity release');});
  const client=Object.assign(emitter,{query,release}),connect=vi.fn(async()=>client),pool={connect} as unknown as Pool;
  return {rows,proofs,developmentBriefs,events,options,query,release,client,connect,pool};
}
